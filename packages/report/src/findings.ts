// DomainReport -> email-authentication findings. Port of unzip-inboxangel outreach-tools/mail_check.py.
//
// Calibration (impact = how much it hurts signup/login/receipt mail, confidence = how sure we are the finding is real):
//  - a DNS record that is absent or broken in the answer is a fact: confidence >= 0.9;
//  - apex SPF may be absent because a sender uses its own `send.` subdomain: spf-missing is 0.95 when a mailbox provider
//    (MX) sends as the apex, 0.8 otherwise;
//  - DKIM selectors cannot be enumerated: "no key at the common selectors" is a weak signal (0.15-0.5, never a verdict);
//  - DNS errors never become findings: they go to `unchecked`.
// The DMARC vendor-stuck signal of the Python original stays in prospecting: it is not a finding.

import { PROVIDERS, type DetectedProvider, type DnsHost, type DomainReport, type Grade, type SpfIssue } from '@inbox-angel/dns-checks';

export type Severity = 'high' | 'medium' | 'low';
export type Effort = 'S' | 'M' | 'L';

export interface Finding {
  /** Canonical finding id (KTD13), e.g. `dmarc-missing`; also the catalog key. */
  id: string;
  title: string;
  area: 'email-authentication';
  severity: Severity;
  effort: Effort;
  impact: number;
  confidence: number;
  evidence: string[];
  recommendation: string;
  /** dkim-not-found-for-sender only: the sender provider id the finding is about. */
  provider?: string;
}

export type AssetStatus = 'present' | 'missing' | 'invalid' | 'not-declared' | 'unreachable';

export interface Facts {
  domain: string;
  checkedAt: string;
  source: string;
  grade: Grade;
  dnsHost: DnsHost;
  ns: string[];
  mailboxProviders: DetectedProvider[];
  senderProviders: DetectedProvider[];
  mx: { status: DomainReport['mx']['status']; hosts: string[] };
  spf: {
    status: DomainReport['spf']['status'];
    raw: string | null;
    raws: string[];
    verdict: 'strict' | 'soft' | 'open' | 'missing' | null;
    lookupCount: number;
    includes: string[];
    issues: SpfIssue[];
  };
  dmarc: {
    status: DomainReport['dmarc']['status'];
    raw: string | null;
    raws: string[];
    policy: string | null;
    /** As published; may be malformed. Read it through `pctOf`. */
    pct: unknown;
    sp: string | null;
    rua: string[];
    inherited: boolean;
    foundAt: string | null;
    /** null when there is no record. */
    valid: boolean | null;
    issues: string[];
  };
  dkim: { foundSelectors: string[]; scanned: number };
  mtaSts: DomainReport['mtaSts']['status'];
  bimi: {
    status: DomainReport['bimi']['status'];
    raw: string | null;
    foundAt: string | null;
    logo: { url: string | null; status: AssetStatus; detail: string | null };
    certificate: { url: string | null; status: AssetStatus; detail: string | null };
  };
  unchecked: string[];
}

/** Confidence that the common-selector scan would have found this sender's DKIM key (per-account selectors cannot be guessed). */
const DKIM_FINDABLE: Record<string, number> = {
  resend: 0.5, 'google-workspace': 0.5, 'microsoft-365': 0.5, postmark: 0.45, sendgrid: 0.4,
  mailgun: 0.35, 'mailchimp-mandrill': 0.4, zoho: 0.3, 'amazon-ses': 0.15,
};
const findable = (id: string) => DKIM_FINDABLE[id] ?? 0.2;

/**
 * A live DKIM key under one of these provider-specific selectors identifies the sending service (dns-checks detects
 * providers from MX and SPF only). Ambiguous selectors (default, s1, s2, k1, mail, smtp, dkim, cm...) are deliberately absent.
 */
const DKIM_SELECTOR_PROVIDER: Record<string, string> = {
  resend: 'resend', amazonses: 'amazon-ses', pm: 'postmark', 'pm-bounces': 'postmark', sendgrid: 'sendgrid', smtpapi: 'sendgrid',
  mailgun: 'mailgun', mandrill: 'mailchimp-mandrill', google: 'google-workspace', selector1: 'microsoft-365', selector2: 'microsoft-365',
  zoho: 'zoho', protonmail: 'proton', fm1: 'fastmail',
};

const MAILTO = /mailto:[^\s,;"\\]+/gi;

/** DMARC rua/ruf addresses can be personal mailboxes: findings and reports never carry them. */
export function redact(text: string): string {
  return text.replace(MAILTO, 'mailto:<address>');
}

function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}

/** DMARC pct as an int; absent or malformed counts as 100 (the DMARC default), so a bad tag never crashes a batch. */
export function pctOf(value: unknown): number {
  if (value === null || value === undefined || value === '') return 100;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 100;
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return parseInt(value, 10);
  return 100;
}

const sev = (impact: number): Severity => (impact >= 0.75 ? 'high' : impact >= 0.5 ? 'medium' : 'low');

function f(id: string, title: string, impact: number, confidence: number, effort: Effort, evidence: string[], recommendation: string, extra: Partial<Finding> = {}): Finding {
  return { id, title, area: 'email-authentication', severity: sev(impact), effort, impact, confidence, evidence, recommendation, ...extra };
}

export function factsOf(r: DomainReport, checkedAt: string): Facts {
  const providers: DetectedProvider[] = r.providers.map(p => ({ ...p, evidence: [...p.evidence] }));
  const liveDkim = r.dkim.found.filter(x => x.record && !x.record.revoked).map(x => x.selector);
  for (const sel of liveDkim) {
    const info = PROVIDERS.find(p => p.id === DKIM_SELECTOR_PROVIDER[sel]);
    if (!info) continue;
    const known = providers.find(p => p.id === info.id);
    if (known) known.evidence = [...known.evidence, `dkim-selector:${sel}`];
    else providers.push({ ...info, evidence: [`dkim-selector:${sel}`] });
  }
  const unchecked = r.errors.map(e => `${e.check}: ${e.message}`);
  const asset = (a: { url: string | null; status: AssetStatus; detail?: string } | undefined) =>
    ({ url: a?.url ?? null, status: a?.status ?? ('not-declared' as const), detail: a?.detail ?? null });
  for (const [label, a] of [['logo', r.bimi.logo], ['certificate', r.bimi.vmc]] as const) {
    if (a?.status === 'unreachable') unchecked.push(`BIMI ${label}: could not be fetched (${a.detail || 'network error'})`); // a fetch failure says nothing about the asset
  }
  unchecked.push(`DKIM: only ${r.dkim.scanned} common selectors can be probed; a key under any other selector is invisible from outside`);
  unchecked.push('Subdomains used by mail services (for example a send. or bounce. subdomain) were not queried');
  unchecked.push('Inbox placement and sender reputation cannot be measured from public DNS');
  const spf = r.spf, dmarc = r.dmarc, rec = dmarc.record;
  return {
    domain: r.domain, checkedAt, source: 'dns-checks checkDomain over DoH', grade: r.grade, dnsHost: r.dnsHost, ns: r.ns.hosts,
    mailboxProviders: providers.filter(p => p.kind === 'mailbox' || p.kind === 'both'),
    senderProviders: providers.filter(p => p.kind === 'sender' || p.kind === 'both'),
    mx: { status: r.mx.status, hosts: r.mx.hosts.map(h => h.host) },
    spf: {
      status: spf.status, raw: spf.record?.raw ?? null, raws: spf.rawRecords ?? [], verdict: spf.record?.verdict ?? null,
      lookupCount: spf.lookupCount, includes: spf.includes ?? [], issues: spf.issues ?? [],
    },
    dmarc: {
      status: dmarc.status, raw: rec?.raw ?? null, raws: dmarc.rawRecords ?? [], policy: rec?.policy ?? null, pct: rec?.pct ?? null,
      sp: rec?.subdomainPolicy ?? null, rua: rec?.rua ?? [], inherited: dmarc.inherited, foundAt: dmarc.foundAt, valid: rec ? rec.valid : null,
      issues: rec?.issues ?? [],
    },
    dkim: { foundSelectors: liveDkim, scanned: r.dkim.scanned },
    mtaSts: r.mtaSts.status,
    bimi: { status: r.bimi.status, raw: r.bimi.raw === null ? null : redact(r.bimi.raw), foundAt: r.bimi.foundAt, logo: asset(r.bimi.logo), certificate: asset(r.bimi.vmc) },
    unchecked,
  };
}

/** BIMI Group: enforcement "on the organizational domain and subdomains" (p and sp at quarantine or reject). */
export function dmarcEnforces(d: Facts['dmarc']): boolean {
  const policy = (d.policy ?? '').toLowerCase();
  const sp = (d.sp || d.policy || '').toLowerCase(); // sp defaults to p
  const enforcing = (x: string) => x === 'quarantine' || x === 'reject';
  return d.status === 'found' && d.valid !== false && enforcing(policy) && enforcing(sp);
}

function bimiFindings(facts: Facts, d: string, seen: string): Finding[] {
  const out: Finding[] = [];
  const { dmarc, bimi } = facts;
  if ((dmarc.status === 'none' || dmarc.status === 'found') && dmarc.valid !== false && !dmarcEnforces(dmarc)) {
    const now = dmarc.raw
      ? `DMARC ${dmarc.foundAt}: ${dmarc.raw}` + (dmarc.sp && dmarc.sp !== dmarc.policy ? ` (subdomain policy sp=${dmarc.sp})` : '')
      : `TXT _dmarc.${d}: no v=DMARC1 record`;
    out.push(f('bimi-blocked-by-dmarc-none', 'BIMI is blocked: DMARC is not enforced', 0.4, 0.95, 'M',
      [`${now} ${seen}`, 'BIMI Group: DMARC must be at enforcement on the domain and its subdomains (p and sp at quarantine or reject)'],
      'Move DMARC to p=quarantine or p=reject once every legitimate sender passes; BIMI is switched off while the policy is none or missing.'));
  } else if (dmarcEnforces(dmarc) && pctOf(dmarc.pct) < 100) {
    out.push(f('bimi-blocked-by-dmarc-pct', `BIMI is blocked: DMARC applies to only ${dmarc.pct}% of mail`, 0.4, 0.95, 'S',
      [`DMARC ${dmarc.foundAt}: ${dmarc.raw} ${seen}`, 'BIMI needs the policy to apply to all mail (pct=100 or no pct tag)'],
      'Raise pct to 100 (or remove the tag) once the policy is proven.'));
  }
  if (bimi.status === 'none') {
    out.push(f('bimi-missing', 'No BIMI record', 0.3, 0.9, 'L', [`TXT default._bimi.${d}: no v=BIMI1 record ${seen}`],
      'Publish a BIMI record at default._bimi pointing to your SVG logo and your certificate.'));
  } else if (bimi.status === 'found') {
    const { logo, certificate: cert } = bimi;
    if (logo.status === 'not-declared' || logo.status === 'missing' || logo.status === 'invalid') {
      const why = {
        'not-declared': 'the record has no l= logo URL',
        missing: `the logo URL answers ${logo.detail || 'with an error'}`,
        invalid: `the logo URL is not a usable SVG (${logo.detail || 'wrong content'})`,
      }[logo.status];
      out.push(f('bimi-logo-invalid', 'BIMI logo is missing or is not an SVG', 0.3, 0.9, 'M', [`${bimi.foundAt}: ${bimi.raw} ${seen}`, `logo: ${why}`],
        'Host your logo as an SVG Tiny-PS file over HTTPS and point l= at it.'));
    }
    if (cert.status === 'not-declared' || cert.status === 'missing' || cert.status === 'invalid') {
      const why = {
        'not-declared': 'the record has no a= certificate URL',
        missing: `the certificate URL answers ${cert.detail || 'with an error'}`,
        invalid: `the certificate URL is not a PEM certificate (${cert.detail || 'wrong content'})`,
      }[cert.status];
      out.push(f('bimi-no-certificate', 'BIMI has no usable certificate (VMC or CMC)', 0.3, 0.9, 'L', [`${bimi.foundAt}: ${bimi.raw} ${seen}`, `certificate: ${why}`],
        "Gmail needs a Verified Mark Certificate (VMC, recommended) or a Common Mark Certificate (CMC) in a=; Apple's BIMI page names a VMC as accepted evidence. Get one and host the PEM file."));
    }
  }
  return out;
}

/** Findings for one checkDomain() result. Not redacted: use `build` for anything that leaves the process. */
export function findingsOf(r: DomainReport, checkedAt: string): Finding[] {
  const facts = factsOf(r, checkedAt);
  const d = r.domain;
  const { spf, dmarc } = facts;
  const mailDomain = facts.mx.status === 'found' || facts.senderProviders.length > 0 || facts.mailboxProviders.length > 0;
  const out: Finding[] = [];
  const seen = `(DoH, public DNS, ${checkedAt.slice(0, 10)})`;

  // SPF
  if (spf.status === 'none') {
    out.push(f('spf-missing', 'No SPF record', mailDomain ? 0.85 : 0.6, facts.mailboxProviders.length ? 0.95 : 0.8, 'S',
      [`TXT ${d}: no v=spf1 record ${seen}`, ...(facts.mx.hosts.length ? [`MX ${d}: ${facts.mx.hosts.slice(0, 3).join(', ')}`] : [])],
      'Publish one SPF TXT record at the domain apex listing every service that sends your mail.'));
  } else if (spf.status === 'permerror') {
    const issues = spf.issues.filter(i => i.code !== 'dns-error');
    if (spf.raws.length > 1 && issues.some(i => i.code === 'multiple-records' && i.domain === d)) {
      out.push(f('multiple-spf', 'Two SPF records on the same name', 0.85, 0.95, 'S',
        [`TXT ${d}: ${spf.raws.length} v=spf1 records ${seen}`, ...spf.raws.slice(0, 3).map(x => `record: ${x}`)],
        'Merge the records into one; receivers treat several SPF records as a permanent error (RFC 7208 section 4.2).'));
    } else if (issues.some(i => i.code === 'lookup-limit') || spf.lookupCount > 10) {
      out.push(f('spf-over-10-lookups', `SPF needs more than 10 DNS lookups (${spf.lookupCount})`, 0.85, 0.95, 'M',
        [`SPF at ${d}: ${spf.lookupCount} DNS-querying terms, limit 10 (RFC 7208 section 4.6.4) ${seen}`,
          ...(spf.includes.length ? [`includes reached: ${spf.includes.slice(0, 10).join(', ')}`] : [])],
        'Remove includes for services you no longer send from, or consolidate; SPF evaluates to permerror past 10 lookups.'));
    } else {
      out.push(f('spf-permerror', 'SPF record is broken (permerror)', 0.8, 0.9, 'S',
        [`SPF at ${d}: permerror ${seen}`, ...issues.slice(0, 4).map(i => i.message)],
        'Fix the SPF problem named in the evidence; receivers treat a permerror as no usable SPF.'));
    }
  } else if (spf.status === 'ok' && spf.verdict === 'open') {
    out.push(f('spf-open', 'SPF record does not restrict senders (+all or ?all)', 0.7, 0.95, 'S', [`SPF at ${d}: ${spf.raw} ${seen}`],
      'List your sending services and end the SPF record with ~all or -all so it restricts senders.'));
  } else if (spf.status === 'ok' && spf.verdict === 'missing') {
    out.push(f('spf-no-all', 'SPF record has no ending (all) rule', 0.35, 0.95, 'S', [`SPF at ${d}: ${spf.raw} ${seen}`],
      'End the SPF record with ~all or -all.'));
  }

  // DMARC
  if (dmarc.status === 'none') {
    out.push(f('dmarc-missing', 'No DMARC record', 0.8, 0.95, 'S', [`TXT _dmarc.${d}: no v=DMARC1 record ${seen}`],
      'Publish a DMARC TXT record at _dmarc (start with p=none, no mail is blocked).'));
  } else if (dmarc.status === 'multiple') {
    out.push(f('dmarc-multiple', 'Two DMARC records on the same name', 0.8, 0.95, 'S',
      [`TXT _dmarc.${d}: ${dmarc.raws.length} v=DMARC1 records ${seen}`, ...dmarc.raws.slice(0, 3).map(x => `record: ${x}`)],
      'Delete all but one; with several records DMARC does not apply (RFC 7489 section 6.6.3).'));
  } else if (dmarc.status === 'found' && dmarc.valid === false) {
    out.push(f('dmarc-invalid', 'DMARC record is malformed', 0.7, 0.9, 'S', [`${dmarc.foundAt}: ${dmarc.raw} ${seen}`, ...dmarc.issues.slice(0, 3)],
      'Correct the DMARC syntax problems listed; an invalid record is ignored.'));
  } else if (dmarc.status === 'found' && dmarc.policy === 'none' && dmarc.rua.length === 0) {
    out.push(f('dmarc-p-none-no-rua', 'DMARC is on p=none and sends no reports', 0.35, 0.95, 'S', [`${dmarc.foundAt}: ${dmarc.raw} ${seen}`],
      'Add rua=mailto:<a mailbox you read> so DMARC reports show who sends mail as you.'));
  }

  // DKIM (weak by construction)
  const senders = facts.senderProviders;
  if (senders.length && facts.dkim.foundSelectors.length === 0 && (spf.status === 'ok' || spf.status === 'permerror')) {
    const p = senders.reduce((best, x) => (findable(x.id) > findable(best.id) ? x : best));
    out.push(f('dkim-not-found-for-sender', `No DKIM key found for ${p.name}`, 0.6, findable(p.id), 'S',
      [`SPF authorises ${p.name} (${p.evidence.slice(0, 2).join(', ')}) ${seen}`,
        `no DKIM key at ${facts.dkim.scanned} common selectors; selectors cannot be listed, so this is a hint, not proof`],
      `Check ${p.name}'s domain page: it shows the exact DKIM record to publish.`, { provider: p.id }));
  }

  // BIMI: only for domains that handle mail
  if (mailDomain) out.push(...bimiFindings(facts, d, seen));

  // MTA-STS
  if (facts.mtaSts === 'none' && facts.mx.status === 'found') {
    out.push(f('mta-sts-missing', 'No MTA-STS policy', 0.1, 0.9, 'M', [`TXT _mta-sts.${d}: none ${seen}`],
      'Optional hardening for inbound mail; not a deliverability fix for signup or receipt emails.'));
  }
  return out;
}

export interface MailCheck {
  findings: Finding[];
  facts: Facts;
  unchecked: string[];
}

/** Findings, facts and what could not be checked, with every mailbox address redacted. */
export function build(r: DomainReport, checkedAt: string): MailCheck {
  const facts = factsOf(r, checkedAt);
  return redactDeep({ findings: findingsOf(r, checkedAt), facts, unchecked: facts.unchecked });
}
