// MTA-STS (RFC 8461) discovery: `_mta-sts.<domain>` TXT + HTTPS policy file, plus the
// pure helpers used when publishing a policy.

import { normalizeName, type Resolver } from './doh';

export type MtaStsMode = 'testing' | 'enforce' | 'none';

export interface MtaStsPolicy {
  version: string | null;
  mode: MtaStsMode | null;
  mx: string[];
  maxAge: number | null;
}

export type MtaStsStatus =
  /** TXT and a well-formed policy were found */
  | 'valid'
  /** no `_mta-sts` TXT record (authoritative) */
  | 'none'
  /** TXT or policy present but broken (multiple TXT, bad id, HTTP 404, malformed policy…) */
  | 'invalid'
  /** DNS failure or network failure fetching the policy: unknown */
  | 'error';

export interface MtaStsLookup {
  status: MtaStsStatus;
  txt: { raw: string; id: string } | null;
  policy: MtaStsPolicy | null;
  policyUrl: string;
  issues: string[];
  error?: string;
}

export function parseMtaStsPolicy(text: string): MtaStsPolicy {
  const policy: MtaStsPolicy = { version: null, mode: null, mx: [], maxAge: null };
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'version') policy.version = val;
    else if (key === 'mode') {
      const m = val.toLowerCase();
      if (m === 'testing' || m === 'enforce' || m === 'none') policy.mode = m;
    } else if (key === 'mx') policy.mx.push(val.toLowerCase());
    else if (key === 'max_age' && /^\d+$/.test(val)) policy.maxAge = parseInt(val, 10);
  }
  return policy;
}

export function validateMtaStsPolicy(p: MtaStsPolicy): string[] {
  const issues: string[] = [];
  if (p.version !== 'STSv1') issues.push('Policy must start with "version: STSv1"');
  if (!p.mode) issues.push('Policy has no valid "mode:" (testing, enforce or none)');
  if (p.maxAge === null) issues.push('Policy has no valid "max_age:"');
  else if (p.mode === 'enforce' && p.maxAge < 86400) issues.push('max_age under one day is too short to be effective in enforce mode');
  if (p.mode && p.mode !== 'none' && p.mx.length === 0) issues.push('Policy lists no "mx:" hosts');
  return issues;
}

export function mtaStsPolicyUrl(domain: string): string {
  return `https://mta-sts.${normalizeName(domain)}/.well-known/mta-sts.txt`;
}

export async function lookupMtaSts(resolver: Resolver, domain: string, timeoutMs = 5000): Promise<MtaStsLookup> {
  const name = normalizeName(domain);
  const policyUrl = mtaStsPolicyUrl(name);
  const out: MtaStsLookup = { status: 'none', txt: null, policy: null, policyUrl, issues: [] };

  const t = await resolver.txt(`_mta-sts.${name}`);
  if (t.status === 'error') return { ...out, status: 'error', error: t.error ?? 'DNS error' };
  const records = t.records.filter(r => /^\s*v=STSv1\s*(;|$)/i.test(r));
  if (records.length === 0) return out;
  if (records.length > 1) return { ...out, status: 'invalid', issues: ['Multiple _mta-sts TXT records; senders will ignore MTA-STS'] };

  const raw = records[0].trim();
  const id = raw.match(/(?:^|;)\s*id=([A-Za-z0-9]{1,32})\s*(?:;|$)/)?.[1];
  if (!id) return { ...out, status: 'invalid', txt: { raw, id: '' }, issues: ['_mta-sts TXT record has no valid id= (1-32 alphanumerics)'] };
  out.txt = { raw, id };

  let res;
  let body: string;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // RFC 8461 §3.3: redirects MUST NOT be followed.
    res = await resolver.fetch(policyUrl, { redirect: 'manual', headers: { Accept: 'text/plain' }, signal: controller.signal });
    if (res.ok) body = await res.text();
  } catch (e) {
    const msg = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : e instanceof Error ? e.message : String(e);
    return { ...out, status: 'error', error: `could not fetch policy: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const redirected = res.status >= 300 && res.status < 400;
    return {
      ...out,
      status: 'invalid',
      issues: [redirected ? `Policy URL redirects (HTTP ${res.status}); MTA-STS forbids redirects` : `Policy URL returned HTTP ${res.status}`],
    };
  }
  const policy = parseMtaStsPolicy(body!);
  const issues = validateMtaStsPolicy(policy);
  const ctype = res.headers.get('content-type');
  if (ctype && !/^text\/plain/i.test(ctype)) issues.push(`Policy Content-Type is "${ctype}", expected text/plain`);
  return { ...out, status: issues.length ? 'invalid' : 'valid', policy, issues };
}

// ── Publishing helpers (pure) ────────────────────────────────

export function generatePolicyId(now: Date = new Date()): string {
  return now.toISOString().replace(/\D/g, '').slice(0, 14); // YYYYMMDDHHMMSS
}

export function buildPolicyFile(mode: 'testing' | 'enforce', mxHosts: string[], maxAge: number): string {
  return ['version: STSv1', `mode: ${mode}`, ...mxHosts.map(mx => `mx: ${mx}`), `max_age: ${maxAge}`].join('\n') + '\n';
}

/**
 * Mode of the policy a domain already publishes, for "preserve existing" on first enable.
 * Returns null when no policy can be read.
 *
 * Only a failed `_mta-sts` TXT lookup is fatal (throws): that means we don't know whether the domain
 * has MTA-STS, and guessing "testing" could downgrade an enforce policy. A policy host that is dead
 * (NXDOMAIN, TLS failure, timeout, HTTP error) is a stale/broken setup that must not block re-enabling,
 * so it yields null and is reported through `onPolicyUnavailable`.
 */
export async function detectExistingMtaStsMode(
  resolver: Resolver,
  domain: string,
  onPolicyUnavailable?: (reason: string) => void,
): Promise<'testing' | 'enforce' | null> {
  const r = await lookupMtaSts(resolver, domain);
  if (r.status === 'error' && r.txt === null) throw new Error(`MTA-STS lookup failed for ${domain}: ${r.error}`);
  const mode = r.policy?.mode;
  if (mode === 'testing' || mode === 'enforce') return mode;
  if (r.txt) onPolicyUnavailable?.(r.error ?? r.issues.join('; ') ?? 'policy unreadable');
  return null;
}
