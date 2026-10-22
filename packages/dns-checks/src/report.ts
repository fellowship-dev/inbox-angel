// checkDomain(): run every check and grade the result on Levels 0–3.

import { createResolver, type Resolver, type ResolverOptions } from './doh';
import { analyzeSpf, type SpfAnalysis } from './spf';
import { lookupDmarc, gradeDmarcPolicy, type DmarcLookup } from './dmarc';
import { scanDkimSelectors, COMMON_DKIM_SELECTORS, type DkimScan } from './dkim';
import { lookupMx, type MxLookup } from './mx';
import { lookupMtaSts, type MtaStsLookup } from './mta-sts';
import { lookupBimi, type BimiLookup } from './bimi';
import { detectProviders, type DetectedProvider } from './providers';
import { normalizeDomain } from './org-domain';

export type Level = 0 | 1 | 2 | 3;

export interface Grade {
  /**
   * 0 Unprotected – no valid SPF or no DMARC
   * 1 Monitoring  – SPF valid and DMARC published, but not enforcing (p=none or pct<100)
   * 2 Enforced    – DMARC quarantine/reject at pct=100 with a valid SPF record
   * 3 Hardened    – p=reject, SPF -all/~all within limits, a DKIM key found and MTA-STS enforce
   *
   * `null` when a DNS failure prevented a fair verdict. A failed lookup never lowers the level.
   */
  level: Level | null;
  label: string;
  /** false when any check hit a DNS error: `level` may be null or capped */
  complete: boolean;
  reasons: string[];
  nextSteps: string[];
}

export interface DomainReport {
  domain: string;
  mx: MxLookup;
  spf: SpfAnalysis;
  dmarc: DmarcLookup;
  dkim: DkimScan;
  mtaSts: MtaStsLookup;
  bimi: BimiLookup;
  providers: DetectedProvider[];
  grade: Grade;
  /** Names of checks that failed with a DNS/network error, with messages. */
  errors: { check: 'mx' | 'spf' | 'dmarc' | 'dkim' | 'mta-sts' | 'bimi'; message: string }[];
}

export interface CheckDomainOptions extends ResolverOptions {
  /** Provide your own resolver (overrides fetch/endpoint/timeout). */
  resolver?: Resolver;
  /** DKIM selectors to probe. Default: COMMON_DKIM_SELECTORS */
  dkimSelectors?: readonly string[];
}

const LABELS: Record<Level, string> = { 0: 'Unprotected', 1: 'Monitoring', 2: 'Enforced', 3: 'Hardened' };

export function gradeReport(r: Omit<DomainReport, 'grade' | 'errors' | 'providers'>): Grade {
  const reasons: string[] = [];
  const nextSteps: string[] = [];
  const spfErr = r.spf.status === 'temperror';
  const dmarcErr = r.dmarc.status === 'error';
  const spfOk = r.spf.status === 'ok' && r.spf.record?.verdict !== 'open' && r.spf.record?.verdict !== 'missing';
  const dmarcGrade = gradeDmarcPolicy(r.dmarc.record);

  if (spfErr || dmarcErr) {
    if (spfErr) reasons.push(`Could not check SPF (${r.spf.issues.find(i => i.code === 'dns-error')?.message ?? 'DNS error'})`);
    if (dmarcErr) reasons.push(`Could not check DMARC (${r.dmarc.error ?? 'DNS error'})`);
    nextSteps.push('Re-run the check; DNS lookups failed so no verdict was given.');
    return { level: null, label: 'Inconclusive', complete: false, reasons, nextSteps };
  }

  const incomplete = r.dkim.errors.length > 0 || r.mtaSts.status === 'error';

  // SPF reasoning
  if (r.spf.status === 'none') { reasons.push('No SPF record'); nextSteps.push('Publish an SPF record listing your senders, ending in -all or ~all.'); }
  else if (r.spf.status === 'permerror') { reasons.push(`SPF is broken (permerror): ${r.spf.issues.filter(i => i.code !== 'dns-error').map(i => i.message).join('; ')}`); nextSteps.push('Fix the SPF record: receivers will treat it as an error.'); }
  else if (r.spf.status === 'temperror') { /* handled above */ }
  else if (r.spf.record?.verdict === 'open') { reasons.push('SPF allows any sender (+all / ?all)'); nextSteps.push('End SPF with -all or ~all.'); }
  else if (r.spf.record?.verdict === 'missing') { reasons.push('SPF has no terminating "all" mechanism'); nextSteps.push('End SPF with -all or ~all.'); }
  else reasons.push(`SPF valid (${r.spf.lookupCount}/10 lookups)`);

  // DMARC reasoning
  if (r.dmarc.status === 'none') { reasons.push('No DMARC record'); nextSteps.push('Publish _dmarc TXT "v=DMARC1; p=none; rua=mailto:…" to start monitoring.'); }
  else if (r.dmarc.status === 'multiple') { reasons.push('Multiple DMARC records: DMARC does not apply'); nextSteps.push('Remove duplicate _dmarc TXT records.'); }
  else if (!r.dmarc.record?.valid) { reasons.push(`DMARC record invalid: ${r.dmarc.record?.issues.join('; ')}`); nextSteps.push('Fix the DMARC record syntax.'); }
  else reasons.push(`DMARC ${r.dmarc.record.policy}${r.dmarc.record.pct < 100 ? ` at ${r.dmarc.record.pct}%` : ''}${r.dmarc.inherited ? ` (inherited from ${r.dmarc.organizationalDomain})` : ''}`);

  const dmarcPublished = dmarcGrade !== 'missing';
  let level: Level = 0;
  if (spfOk && dmarcPublished) level = 1;
  if (level === 1 && (dmarcGrade === 'enforced' || dmarcGrade === 'strict')) level = 2;
  if (level === 1 && dmarcGrade === 'monitoring') nextSteps.push('Move DMARC from p=none to quarantine, then reject, once reports show your senders pass.');
  if (level === 1 && dmarcGrade === 'partial') nextSteps.push('Raise pct= to 100 to enforce on all mail.');

  if (level === 2) {
    const keyFound = r.dkim.found.some(f => f.record && !f.record.revoked);
    const mtaEnforce = r.mtaSts.status === 'valid' && r.mtaSts.policy?.mode === 'enforce';
    const spfFirm = r.spf.record?.verdict === 'strict' || r.spf.record?.verdict === 'soft';
    const checks: [boolean, string, string][] = [
      [dmarcGrade === 'strict', 'DMARC is not p=reject', 'Move DMARC to p=reject.'],
      [spfFirm, 'SPF is not -all/~all', 'End SPF with -all or ~all.'],
      [keyFound, r.dkim.errors.length ? 'No DKIM key found among probed selectors (some lookups failed)' : 'No DKIM key found among common selectors', 'Publish DKIM keys and confirm them in DMARC reports.'],
      [mtaEnforce, r.mtaSts.status === 'error' ? 'MTA-STS could not be checked' : 'MTA-STS is not in enforce mode', 'Publish an MTA-STS policy and move it to mode: enforce.'],
    ];
    const missing = checks.filter(c => !c[0]);
    if (missing.length === 0) level = 3;
    else for (const [, reason, step] of missing) { reasons.push(reason); nextSteps.push(step); }
  }

  return { level, label: LABELS[level], complete: !incomplete, reasons, nextSteps };
}

/**
 * Run all checks against `domain` and return a typed report. Never throws on DNS failure:
 * failures are surfaced per check (`status: 'error'`) and in `errors`.
 */
export async function checkDomain(domain: string, options: CheckDomainOptions = {}): Promise<DomainReport> {
  const name = normalizeDomain(domain);
  const resolver = options.resolver ?? createResolver(options);

  const [mx, spf, dmarc, dkim, mtaSts, bimi] = await Promise.all([
    lookupMx(resolver, name),
    analyzeSpf(name, resolver),
    lookupDmarc(resolver, name),
    scanDkimSelectors(resolver, name, options.dkimSelectors ?? COMMON_DKIM_SELECTORS),
    lookupMtaSts(resolver, name),
    lookupBimi(resolver, name),
  ]);

  const errors: DomainReport['errors'] = [];
  if (mx.status === 'error') errors.push({ check: 'mx', message: mx.error ?? 'DNS error' });
  if (spf.status === 'temperror') errors.push({ check: 'spf', message: spf.issues.find(i => i.code === 'dns-error')?.message ?? 'DNS error' });
  if (dmarc.status === 'error') errors.push({ check: 'dmarc', message: dmarc.error ?? 'DNS error' });
  for (const e of dkim.errors) errors.push({ check: 'dkim', message: `${e.selector}: ${e.error}` });
  if (mtaSts.status === 'error') errors.push({ check: 'mta-sts', message: mtaSts.error ?? 'error' });
  if (bimi.status === 'error') errors.push({ check: 'bimi', message: bimi.error ?? 'error' });

  const providers = detectProviders({ mxHosts: mx.hosts.map(h => h.host), spfIncludes: spf.includes });
  const partial = { domain: name, mx, spf, dmarc, dkim, mtaSts, bimi };
  return { ...partial, providers, grade: gradeReport(partial), errors };
}
