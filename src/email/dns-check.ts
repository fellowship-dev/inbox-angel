// Worker-side adapter over @inbox-angel/dns-checks (packages/dns-checks), which holds all
// DNS logic. This file only binds the package to the global fetch and keeps the
// `T | null` call shape the worker uses.
//
// Contract: `null` means the DNS authoritatively has no such record. A DNS failure
// (SERVFAIL, timeout, DoH HTTP error, malformed answer) THROWS DnsLookupError and is never
// folded into `null`, so callers can't mistake "couldn't check" for "doesn't exist".

import {
  analyzeSpf,
  analyzeSpfRecord,
  createResolver,
  lookupDkim as pkgLookupDkim,
  lookupDmarc as pkgLookupDmarc,
  type DkimRecord,
  type DmarcRecord,
  type SpfAnalysis,
  type SpfRecord,
} from '../../packages/dns-checks/src';

export { parseSpfRecord, parseDkimRecord, parseDmarcRecord } from '../../packages/dns-checks/src';
export type { SpfRecord, DkimRecord, DmarcRecord };

export interface DnsRecord {
  type: string;
  value: string;
}

export class DnsLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsLookupError';
  }
}

export interface DnsCheckResult {
  domain: string;
  spf: SpfRecord | null;
  dkim: DkimRecord | null;   // null if no selector available
  dmarc: DmarcRecord | null;
  /** Set per check when the lookup FAILED (as opposed to finding no record). */
  errors?: { spf?: string; dkim?: string; dmarc?: string };
}

function spfProblem(a: SpfAnalysis): string | null {
  if (a.status === 'temperror') return a.issues.find(i => i.code === 'dns-error')?.message ?? 'DNS error';
  if (a.record === null && a.status === 'permerror') return a.issues[0]?.message ?? 'invalid SPF';
  return null;
}

export async function lookupSpf(domain: string): Promise<SpfRecord | null> {
  const a = await analyzeSpf(domain, createResolver());
  const problem = spfProblem(a);
  if (problem) throw new DnsLookupError(`SPF lookup for ${domain} failed: ${problem}`);
  if (a.status === 'none') return null;
  return a.record;
}

/** Count RFC 7208 lookups for an unpublished SPF record. Throws DnsLookupError if DNS failed mid-walk. */
export async function countSpfLookupsFromRecord(record: string): Promise<number> {
  const a = await analyzeSpfRecord(record, createResolver());
  if (a.status === 'temperror') throw new DnsLookupError(`SPF lookup count failed: ${spfProblem(a)}`);
  return a.lookupCount;
}

export async function lookupDkim(domain: string, selector: string): Promise<DkimRecord | null> {
  const r = await pkgLookupDkim(createResolver(), domain, selector);
  if (r.status === 'error') throw new DnsLookupError(`DKIM lookup for ${r.name} failed: ${r.error}`);
  return r.record;
}

export async function lookupDmarc(domain: string): Promise<DmarcRecord | null> {
  const r = await pkgLookupDmarc(createResolver(), domain);
  if (r.status === 'error') throw new DnsLookupError(`DMARC lookup for ${domain} failed: ${r.error}`);
  if (r.status === 'multiple') throw new DnsLookupError(`${r.foundAt} has multiple DMARC records`);
  return r.record;
}

export async function checkDomain(domain: string, dkimSelector?: string | null): Promise<DnsCheckResult> {
  const settle = async <T>(p: Promise<T>): Promise<{ v: T | null; err?: string }> => {
    try {
      return { v: await p };
    } catch (e) {
      return { v: null, err: e instanceof Error ? e.message : String(e) };
    }
  };
  const [spf, dmarc, dkim] = await Promise.all([
    settle(lookupSpf(domain)),
    settle(lookupDmarc(domain)),
    dkimSelector ? settle(lookupDkim(domain, dkimSelector)) : Promise.resolve<{ v: DkimRecord | null; err?: string }>({ v: null }),
  ]);
  const errors: NonNullable<DnsCheckResult['errors']> = {};
  if (spf.err) errors.spf = spf.err;
  if (dmarc.err) errors.dmarc = dmarc.err;
  if (dkim.err) errors.dkim = dkim.err;
  return {
    domain,
    spf: spf.v,
    dkim: dkim.v,
    dmarc: dmarc.v,
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}
