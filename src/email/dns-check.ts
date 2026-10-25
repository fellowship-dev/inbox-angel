// Worker-side adapter over @inbox-angel/dns-checks (packages/dns-checks), which holds all
// DNS logic. This file only binds the package to the global fetch and keeps the
// `T | null` call shape the worker uses.
//
// Contract: `null` means the DNS authoritatively has no such record. A DNS failure
// (SERVFAIL, timeout, DoH HTTP error, malformed answer) THROWS DnsLookupError and is never
// folded into `null`, so callers can't mistake "couldn't check" for "doesn't exist".

import {
  parseDmarcRecord,
  parseSpfRecord,
  analyzeSpf,
  analyzeSpfRecord,
  createResolver,
  lookupDkim as pkgLookupDkim,
  lookupDmarc as pkgLookupDmarc,
  lookupMx,
  type DkimRecord,
  type MxLookup,
  type DmarcRecord as PkgDmarcRecord,
  type SpfAnalysis,
  type SpfRecord as PkgSpfRecord,
} from '@inbox-angel/dns-checks';

export { parseSpfRecord, parseDkimRecord, parseDmarcRecord } from '@inbox-angel/dns-checks';
export type { DkimRecord };

/** Joins the competing records of a multiple-record permerror into one `raw` (SPF and DMARC). */
export const RECORDS_SEPARATOR = '  |  ';

/** Returned lookups may carry `permerror`: the record(s) exist but receivers will treat them as an error. */
export type SpfRecord = PkgSpfRecord & { permerror?: string };
/** `inheritedFrom`: set when the record was not at `_dmarc.<domain>` but inherited from the organizational domain (its name). */
export type DmarcRecord = PkgDmarcRecord & { permerror?: string; inheritedFrom?: string };

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

/** Typed RFC permerrors: the records exist but are unusable. Not a DNS outage. */
export type RecordProblem = string;

export interface DnsCheckResult {
  domain: string;
  spf: SpfRecord | null;
  dkim: DkimRecord | null;   // null if no selector available
  dmarc: DmarcRecord | null;
  /** Set per check when the lookup FAILED (as opposed to finding no record). */
  errors?: { spf?: string; dkim?: string; dmarc?: string };
  /** Set per check when records were found but are broken (multiple records, SPF permerror…). */
  problems?: { spf?: string; dmarc?: string };
  /** The domain's MX answer, for mailbox-provider detection in the fixes only; a failed lookup is `status: 'error'`, never in `errors`. */
  mx?: MxLookup;
}

function spfDnsError(a: SpfAnalysis): string | null {
  return a.status === 'temperror' ? (a.issues.find(i => i.code === 'dns-error')?.message ?? 'DNS error') : null;
}

/**
 * `null` = no SPF record (authoritative). Throws DnsLookupError ONLY on a real DNS failure.
 * A permerror (multiple records, too many lookups, loop…) returns the record with `permerror` set.
 */
export async function lookupSpf(domain: string): Promise<SpfRecord | null> {
  const a = await analyzeSpf(domain, createResolver());
  const dnsErr = spfDnsError(a);
  if (dnsErr) throw new DnsLookupError(`SPF lookup for ${domain} failed: ${dnsErr}`);
  if (a.status === 'none') return null;
  if (a.rawRecords) {
    // multiple v=spf1 records: expose all of them so the change is visible, flagged as permerror
    return { ...parseSpfRecord(a.rawRecords[0]), raw: a.rawRecords.join(RECORDS_SEPARATOR), verdict: 'missing', permerror: a.issues[0]?.message ?? 'multiple SPF records' };
  }
  if (a.status === 'permerror') return { ...a.record!, permerror: a.issues.find(i => i.code !== 'dns-error')?.message ?? 'SPF permerror' };
  return a.record;
}

/** Count RFC 7208 lookups for an unpublished SPF record. Throws DnsLookupError if DNS failed mid-walk. */
export async function countSpfLookupsFromRecord(record: string): Promise<number> {
  const a = await analyzeSpfRecord(record, createResolver());
  if (a.status === 'temperror') throw new DnsLookupError(`SPF lookup count failed: ${spfDnsError(a)}`);
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
  const inherited = r.inherited && r.foundAt ? { inheritedFrom: r.foundAt } : {};
  if (r.status === 'multiple') {
    // RFC 7489 §6.6.3: with several records DMARC does not apply, i.e. effectively no policy.
    const msg = `${r.foundAt} has ${r.rawRecords!.length} DMARC records; receivers ignore DMARC`;
    return { ...parseDmarcRecord(r.rawRecords![0]), raw: r.rawRecords!.join(RECORDS_SEPARATOR), policy: 'none', subdomainPolicy: 'none', valid: false, issues: [msg], permerror: msg, ...inherited };
  }
  return r.record && { ...r.record, ...inherited };
}

export async function checkDomain(domain: string, dkimSelector?: string | null): Promise<DnsCheckResult> {
  const settle = async <T>(p: Promise<T>): Promise<{ v: T | null; err?: string }> => {
    try {
      return { v: await p };
    } catch (e) {
      return { v: null, err: e instanceof Error ? e.message : String(e) };
    }
  };
  const [spf, dmarc, dkim, mx] = await Promise.all([
    settle(lookupSpf(domain)),
    settle(lookupDmarc(domain)),
    dkimSelector ? settle(lookupDkim(domain, dkimSelector)) : Promise.resolve<{ v: DkimRecord | null; err?: string }>({ v: null }),
    lookupMx(createResolver(), domain), // never throws: a DNS failure is status 'error'
  ]);
  const errors: NonNullable<DnsCheckResult['errors']> = {};
  if (spf.err) errors.spf = spf.err;
  if (dmarc.err) errors.dmarc = dmarc.err;
  if (dkim.err) errors.dkim = dkim.err;
  const problems: NonNullable<DnsCheckResult['problems']> = {};
  if (spf.v?.permerror) problems.spf = spf.v.permerror;
  if (dmarc.v?.permerror) problems.dmarc = dmarc.v.permerror;
  return {
    domain,
    spf: spf.v,
    dkim: dkim.v,
    dmarc: dmarc.v,
    mx,
    ...(Object.keys(errors).length ? { errors } : {}),
    ...(Object.keys(problems).length ? { problems } : {}),
  };
}
