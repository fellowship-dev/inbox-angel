// The hosted-records writer: the only code that writes to the operator's records zone.
//
// Everything lives under one label of that zone (`h`), so `*.h.inboxangel.io` is ours and the rest of
// the zone belongs to the operator. Three layers keep it that way:
//   1. the token (HOSTED_RECORDS_TOKEN) should be scoped to DNS:Edit on this one zone;
//   2. `assertHostedName` refuses any record name outside `*.<label>.<zone>`, for create, update and delete;
//   3. (CfClient) every DNS write is re-checked at the client: TXT/AAAA/CNAME only, strictly below `<label>.<zone>`, in this zone only;
//   4. update and delete read the record first and refuse it unless it sits at the name the caller expects,
//      so a stale or wrong record id can't touch another record.
//
// Layout, with <id> an opaque id that is never derived from the customer's domain:
//   <id>._dmarc.h.<zone>        TXT   v=DMARC1; p=…; rua=mailto:rua+<token>@<intake>
//   <id>._spf.h.<zone>          TXT   flattened SPF (customers add include:<id>._spf.h.<zone>)
//   <id>._tlsrpt.h.<zone>       TXT   v=TLSRPTv1; rua=mailto:tls-rpt+<token>@<intake>
//   mta-sts.<id>.h.<zone>       TXT   v=STSv1; id=…     and a proxied AAAA so the Worker serves the policy

import { CfClient, CfNotConfiguredError, type CfDnsRecord, type CfDnsRecordInput, type CfZone } from '../tenancy/cf-client';
import { assertHostedDnsWrite } from '../dns/write-policy';
import { hostedApex, hostedConfig, type HostedConfig, type HostedEnv } from './config';
import { intakeAddress } from './tokens';

export class HostedNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedNameError';
  }
}

const HOSTNAME_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

/** Throws unless `name` is a plain hostname strictly below `<label>.<zone>`. Returns the lower-cased name. */
export function assertHostedName(name: string, cfg: Pick<HostedConfig, 'recordsZone' | 'recordsLabel'>): string {
  const apex = cfg.recordsZone ? `${cfg.recordsLabel}.${cfg.recordsZone}` : undefined;
  if (!apex) throw new HostedNameError('hosted-records zone is not configured');
  const n = name.toLowerCase();
  if (!HOSTNAME_RE.test(n) || n.length > 253) throw new HostedNameError(`refusing record name ${JSON.stringify(name)}: not a plain hostname`);
  if (!n.endsWith(`.${apex}`)) throw new HostedNameError(`refusing record name ${n}: hosted records may only be written under *.${apex}`);
  return n;
}

export interface HostedNames { dmarc: string; spf: string; tlsRpt: string; mtaSts: string }

export function hostedNames(hostedId: string, apex: string): HostedNames {
  return {
    dmarc: `${hostedId}._dmarc.${apex}`,
    spf: `${hostedId}._spf.${apex}`,
    tlsRpt: `${hostedId}._tlsrpt.${apex}`,
    mtaSts: `mta-sts.${hostedId}.${apex}`,
  };
}

export function buildHostedDmarc(policy: 'none' | 'quarantine' | 'reject', token: string, intakeDomain: string): string {
  return `v=DMARC1; p=${policy}; rua=mailto:${intakeAddress('rua', token, intakeDomain)}`;
}

export function buildHostedTlsRpt(token: string, intakeDomain: string): string {
  return `v=TLSRPTv1; rua=mailto:${intakeAddress('tls-rpt', token, intakeDomain)}`;
}

/** Point the rua= of an existing DMARC record at a new address, keeping every other tag. */
export function retargetRua(record: string, newAddress: string): string {
  const parts = record.replace(/^"|"$/g, '').split(';').map(s => s.trim()).filter(Boolean);
  const out = parts.filter(p => p.split('=')[0].trim().toLowerCase() !== 'rua');
  out.push(`rua=mailto:${newAddress}`);
  return out.join('; ');
}

const WRITABLE_TYPES: readonly string[] = ['TXT', 'AAAA'];

export class HostedRecordWriter {
  readonly #cf: CfClient;
  readonly zone: CfZone;
  readonly #cfg: HostedConfig;

  constructor(cf: CfClient, zone: CfZone, cfg: HostedConfig) {
    this.#cf = cf;
    this.zone = zone;
    this.#cfg = cfg;
  }

  async create(record: CfDnsRecordInput): Promise<CfDnsRecord> {
    const name = assertHostedName(record.name, this.#cfg);
    if (!WRITABLE_TYPES.includes(record.type)) throw new HostedNameError(`refusing record type ${record.type}: hosted records are TXT or AAAA`);
    return this.#cf.createDnsRecord(this.zone.id, { ...record, name });
  }

  async setContent(recordId: string, name: string, content: string): Promise<CfDnsRecord> {
    await this.#verifyRecord(recordId, name);
    return this.#cf.patchDnsRecord(this.zone.id, recordId, { content });
  }

  /** Current content of a hosted record. */
  async read(recordId: string, name: string): Promise<CfDnsRecord> {
    return this.#verifyRecord(recordId, name);
  }

  async remove(recordId: string, name: string): Promise<boolean> {
    try {
      await this.#verifyRecord(recordId, name);
    } catch (e) {
      if (e instanceof HostedNameError && /not found/.test(e.message)) return false; // already gone
      throw e;
    }
    return this.#cf.deleteDnsRecord(this.zone.id, recordId);
  }

  /** Every record of the zone (read-only), for the daily diff and the quota count. */
  async listAll(): Promise<CfDnsRecord[]> {
    const perPage = 1000;
    const all: CfDnsRecord[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.#cf.request<CfDnsRecord[]>('GET', `/zones/${this.zone.id}/dns_records`, { query: { page, per_page: perPage } });
      all.push(...(batch ?? []));
      if (!batch || batch.length < perPage) return all;
    }
  }

  async #verifyRecord(recordId: string, name: string): Promise<CfDnsRecord> {
    const expected = assertHostedName(name, this.#cfg);
    let found: CfDnsRecord;
    try {
      found = await this.#cf.request<CfDnsRecord>('GET', `/zones/${this.zone.id}/dns_records/${recordId}`);
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw new HostedNameError(`record ${recordId} not found`);
      throw e;
    }
    if (found.name.toLowerCase() !== expected) {
      throw new HostedNameError(`refusing to touch record ${recordId}: it is ${found.name}, not ${expected}`);
    }
    return found;
  }
}

/** Open the hosted zone with HOSTED_RECORDS_TOKEN, which is separate from every tenant credential. */
export async function openHostedZone(env: HostedEnv, zoneName: string, opts: { fetch?: typeof fetch } = {}): Promise<HostedRecordWriter> {
  if (!env.HOSTED_RECORDS_TOKEN) throw new CfNotConfiguredError();
  const cfg = hostedConfig(env);
  // Layer 4: the client itself refuses any DNS write that is not TXT/AAAA/CNAME under *.<label>.<zone> of this zone.
  const cf = new CfClient(env.HOSTED_RECORDS_TOKEN, { fetch: opts.fetch, mode: 'saas', dnsWritePolicy: w => assertHostedDnsWrite(w, cfg) });
  const zone = await cf.zoneFor(zoneName);
  return new HostedRecordWriter(cf, zone, cfg);
}

export { hostedApex };
