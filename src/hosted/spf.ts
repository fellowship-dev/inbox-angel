// The flattened SPF behind `<id>._spf.h.<zone>`.
//
// It is built from the SPF record the customer had when hosting was enabled (`hosted_domains.spf_source`),
// not from what they publish now: after cutover their record is just `include:<id>._spf.h.<zone>`, which would
// resolve to our own record. The source is walked with the same flattener self-host uses (@inbox-angel/dns-checks)
// and re-walked daily, because the providers it includes change their IP ranges.

import { collectIps, buildFlatRecord, normalizeName, type Resolver, type SpfIssue } from '@inbox-angel/dns-checks';

/** The resolver, but TXT at `domain` answers with `record`. */
export function withSpfSource(resolver: Resolver, domain: string, record: string): Resolver {
  const d = normalizeName(domain);
  return {
    ...resolver,
    txt: async name => (normalizeName(name) === d ? { status: 'ok' as const, records: [record] } : resolver.txt(name)),
  };
}

export type FlatSpf = { ok: true; content: string; ipCount: number } | { ok: false; errors: SpfIssue[] };

/** Flatten `source`. Incomplete results (DNS errors, loops) are never returned as content: a partial record would drop senders. */
export async function flattenSource(domain: string, source: string, resolver: Resolver): Promise<FlatSpf> {
  const flat = await collectIps(domain, withSpfSource(resolver, domain, source));
  if (flat.errors.length > 0) return { ok: false, errors: flat.errors };
  return { ok: true, content: buildFlatRecord(flat.ips, flat.extra, flat.allQualifier), ipCount: flat.ips.length };
}
