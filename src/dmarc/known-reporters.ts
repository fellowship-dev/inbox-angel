// The reporter registry: established receivers whose aggregate reports COUNT (hosted default). Data, not logic: add an entry here, or
// set INTAKE_KNOWN_REPORTERS (docs/hosted.md) to add one without a code change.
//
// Why a registry. A report address is public, so anyone can register a domain, DKIM-sign a message and send an authenticated fake report
// ("100% pass"). Authentication proves WHO sent a report, not that the sender is a real mail receiver. A report counts only when its
// CARRIER (the email) matches an entry on all three of:
//   - the DKIM `d=` organisational domain that PASSED in the trusted Authentication-Results header,
//   - the From address (exact, or a pattern under the entry's domain),
//   - the report's own `report_metadata/email`, which must be in the entry's accepted set.
// The report's org_name, the Submitter and the subject are labels only: they are text the sender wrote and never decide anything. The
// carrier identity, the Submitter and `report_metadata` often name DIFFERENT domains for real reporters (notification.microsoft.com vs
// Outlook.com, yahoo.com vs yahooinc.com vs aol.com, fastmaildmarc.com vs fastmail.com), which is why the accepted report emails are a
// per-entry set and are not required to equal the DKIM organisation.
//
// Evidence: every entry cites real report emails, with the upstream repository and commit, and the date it was re-read here. Fixtures copied
// into this repository are in test/fixtures/third-party/ (see THIRD_PARTY.md). Nothing here is guessed.

export interface RegistryEvidence {
  /** A repository path (copied, test/fixtures/third-party/...) or an upstream location read but not copied. */
  ref: string;
  /** What was observed. */
  note: string;
  copied: boolean;
}

export interface KnownReporter {
  id: string;
  /** Shown to the owner ("Google"). */
  label: string;
  /** Organisational domains the passing DKIM signature may have (`d=` reduced to its organisational domain). */
  dkimOrgs: readonly string[];
  /** From address: exact, or `local@*.example.net` (one or more labels in place of `*`). Lowercase. */
  from: readonly string[];
  /** Accepted `report_metadata/email` values (exact, lowercase). */
  reportEmails: readonly string[];
  /** Or any address under one of these domains. */
  reportEmailDomains?: readonly string[];
  /** A fact to say plainly when it is not confirmed. */
  caveat?: string;
  evidence: readonly RegistryEvidence[];
  verified: string;
}

const VERIFIED = '2026-11-14';
const MOX = 'test/fixtures/third-party/mox (mjl-/mox@b32f0de)';
const FREITAG = 'test/fixtures/third-party/freitagsrunde (freitagsrunde/dmarc-report-aggregator@1967d79)';

export const KNOWN_REPORTERS: readonly KnownReporter[] = [
  {
    id: 'google', label: 'Google', dkimOrgs: ['google.com'], from: ['noreply-dmarc-support@google.com'], reportEmails: ['noreply-dmarc-support@google.com'], verified: VERIFIED,
    evidence: [{ ref: `${MOX}/google.eml`, note: 'From noreply-dmarc-support@google.com; DKIM d=google.com (pass); report_metadata/email the same', copied: true }],
  },
  {
    id: 'microsoft', label: 'Microsoft', dkimOrgs: ['microsoft.com'], from: ['dmarcreport@microsoft.com'], reportEmails: ['dmarcreport@microsoft.com'], verified: VERIFIED,
    evidence: [{ ref: `${MOX}/outlook.eml`, note: 'From "DMARC Aggregate Report" <dmarcreport@microsoft.com>; DKIM d=notification.microsoft.com (pass), organisational domain microsoft.com; metadata dmarcreport@microsoft.com', copied: true }],
  },
  {
    id: 'yahoo', label: 'Yahoo (and AOL)', dkimOrgs: ['yahoo.com'], from: ['noreply@dmarc.yahoo.com'], reportEmails: ['dmarchelp@yahooinc.com', 'postmaster@dmarc.yahoo.com'], verified: VERIFIED,
    caveat: 'also sends AOL\'s reports (Submitter: aol.com); the report email changed from postmaster@dmarc.yahoo.com (2019) to dmarchelp@yahooinc.com (2023)',
    evidence: [
      { ref: `${MOX}/yahoo.eml`, note: '2019: From noreply@dmarc.yahoo.com; DKIM d=yahoo.com (pass); metadata postmaster@dmarc.yahoo.com', copied: true },
      { ref: `${FREITAG}/yahoo.eml, aol.eml`, note: '2023: same From; metadata dmarchelp@yahooinc.com (headers stripped, so DKIM not observed in these)', copied: true },
    ],
  },
  {
    id: 'mailru', label: 'Mail.ru', dkimOrgs: ['mail.ru'], from: ['dmarc_support@corp.mail.ru'], reportEmails: ['dmarc_support@corp.mail.ru'], verified: VERIFIED,
    evidence: [{ ref: `${MOX}/mailru.eml`, note: 'From dmarc_support@corp.mail.ru; DKIM d=corp.mail.ru (pass); metadata the same', copied: true }],
  },
  {
    id: 'amazon-ses', label: 'Amazon SES', dkimOrgs: ['amazonses.com'], from: ['postmaster@amazonses.com'], reportEmails: ['postmaster@amazonses.com'], verified: VERIFIED,
    caveat: 'amazonses.com is a shared sending domain: only the exact From address matches',
    evidence: [{ ref: 'tadamcz/mail-auth@29cea4c resources/dmarc-feedback/104.eml (Stalwart test data, 2022; read, not copied: licence not confirmed)', note: 'From postmaster@amazonses.com; DKIM d=amazonses.com; metadata postmaster@amazonses.com', copied: false }],
  },
  {
    // Only the region that was OBSERVED (au-1) is listed: Mimecast has other regions (us-1, eu-1, ...), but no report from them has been seen, so they are stored as
    // unknown and listed as candidates until an operator confirms one (INTAKE_KNOWN_REPORTERS).
    id: 'mimecast', label: 'Mimecast', dkimOrgs: ['mimecastreport.com'], from: ['no-reply@au-1.mimecastreport.com'], reportEmails: ['no-reply@au-1.mimecastreport.com'], verified: VERIFIED,
    caveat: 'only the au-1 region was observed (From and report email no-reply@au-1.mimecastreport.com); other regions are stored as unknown until confirmed',
    evidence: [{ ref: 'test/fixtures/third-party/parsedmarc/mimecast-weird-gzip.eml (domainaware/parsedmarc@70a0ea0, Apache-2.0)', note: 'From no-reply@au-1.mimecastreport.com; DKIM d=au-1.mimecastreport.com (pass); Submitter mimecast.org; the report XML extracts with the hardened extractor (the gzip framing is malformed) and report_metadata/email is no-reply@au-1.mimecastreport.com', copied: true }],
  },
  {
    id: 'xs4all', label: 'XS4ALL', dkimOrgs: ['xs4all.net'], from: ['noreply@dmarc-reports.xs4all.net'], reportEmails: ['noreply@dmarc-reports.xs4all.net'], verified: VERIFIED,
    evidence: [{ ref: `${MOX}/xs4all.eml`, note: 'From noreply@dmarc-reports.xs4all.net; DKIM d=dmarc-reports.xs4all.net (pass); metadata the same', copied: true }],
  },
  {
    id: 'fastmail', label: 'Fastmail', dkimOrgs: ['fastmaildmarc.com'], from: ['reports@fastmaildmarc.com'], reportEmails: ['reports@fastmaildmarc.com'], verified: VERIFIED,
    caveat: 'the DKIM signing domain was NOT observed (the sample\'s headers were stripped); it is set to fastmaildmarc.com, which is the only domain that can authenticate this From address',
    evidence: [{ ref: `${FREITAG}/fastmail.eml`, note: 'From reports@fastmaildmarc.com; metadata reports@fastmaildmarc.com; Submitter fastmail.com (no DKIM or Authentication-Results in the file)', copied: true }],
  },
];

/** Named (by the owner, or in the research) but NOT verified against a real report email, so not included. */
export const NAMED_BUT_UNVERIFIED: ReadonlyArray<{ org: string; why: string }> = [
  { org: 'Comcast', why: 'no fixture; a 2016 forum post shows dmarc-support@alerts.comcast.net, but no DKIM or report email was observed' },
  { org: 'Yandex', why: 'no report email found' },
  { org: 'Zoho', why: 'noreply-dmarc@zoho.com appears only as XML metadata in Zoho\'s own sample; no carrier headers' },
  { org: 'GMX / web.de / mail.com', why: 'announced reports exist, but no report email found' },
  { org: 'Seznam', why: 'its help page names abuse@seznam.cz as the sender; no carrier DKIM identity or report email was observed' },
  { org: 'Apple / iCloud', why: 'no report email found' },
  { org: 'Proofpoint', why: 'no report email found' },
  { org: 'Cisco / IronPort', why: 'the one sample came from a host-specific MAILER-DAEMON address, not a stable From' },
  { org: 'LinkedIn, QQ, Naver, Orange, Free, Ziggo', why: 'no report email found' },
];

// ── parsing and matching ────────────────────────────────────

export interface RegistryEnv {
  /**
   * Extra registry entries, one per `;` or newline, each `id|label|dkim-org[,dkim-org]|from[,from]|report-email[,report-email]` (lowercase). A from
   * pattern may be `local@*.example.net`. Example: `acme|Acme Receiver|acme-mail.com|dmarc@acme-mail.com|dmarc@acme-mail.com`.
   */
  INTAKE_KNOWN_REPORTERS?: string;
  /** Built-in entry ids to switch off, comma or space separated (`yahoo,fastmail`). */
  INTAKE_KNOWN_REPORTERS_DISABLE?: string;
}

const ADDRESS_RE = /^[a-z0-9._%+-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const FROM_RE = /^[a-z0-9._%+-]+@(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface ParsedRegistry { entries: KnownReporter[]; issues: string[] }

/** The ids and labels of the built-in entries (also the disabled ones): reserved, an operator entry may not reuse either. */
const RESERVED_IDS: ReadonlySet<string> = new Set(KNOWN_REPORTERS.map((e) => e.id));
const RESERVED_LABELS: ReadonlySet<string> = new Set(KNOWN_REPORTERS.map((e) => e.label.toLowerCase()));

/**
 * The reporters whose counted reports carry the "safe to enforce" advice: the two receivers that see most of the mail. Keyed on the BUILT-IN entry's id only;
 * an operator entry can never take one of these ids (parseOperatorEntries refuses it), and its label is never consulted.
 */
export const MAJOR_REPORTER_IDS: readonly string[] = ['google', 'microsoft'];
export const isMajorReporter = (identity: string): boolean => MAJOR_REPORTER_IDS.includes(identity) && RESERVED_IDS.has(identity);

/**
 * Parse INTAKE_KNOWN_REPORTERS. A malformed entry is ignored and named in `issues`. An operator id that is a built-in id (google, microsoft, yahoo, ...), or
 * that appears more than once in the operator's own list, is refused (every entry carrying it): the id is the identity counted reports are stored under, and
 * `evil.com` must never count as Google. An operator label equal to a built-in label is refused too (it would show as that reporter).
 */
export function parseOperatorEntries(raw: string | undefined): ParsedRegistry {
  const entries: KnownReporter[] = [];
  const issues: string[] = [];
  for (const line of (raw ?? '').split(/[;\n]+/).map((l) => l.trim()).filter(Boolean)) {
    const [id, label, dkim, from, emails] = line.split('|').map((p) => p.trim().toLowerCase());
    const list = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const dkimOrgs = list(dkim), froms = list(from), reportEmails = list(emails);
    if (!id || !/^[a-z0-9-]+$/.test(id) || !label || !dkimOrgs.length || !froms.length || !reportEmails.length) { issues.push(`${line}: expected id|label|dkim-org,…|from,…|report-email,…`); continue; }
    if (!dkimOrgs.every((d) => DOMAIN_RE.test(d)) || !froms.every((a) => FROM_RE.test(a)) || !reportEmails.every((a) => ADDRESS_RE.test(a))) { issues.push(`${line}: invalid domain or address`); continue; }
    if (RESERVED_IDS.has(id)) { issues.push(`${line}: id "${id}" is a built-in reporter id and cannot be reused (to replace a built-in entry, disable it with INTAKE_KNOWN_REPORTERS_DISABLE and use another id)`); continue; }
    if (RESERVED_LABELS.has(label)) { issues.push(`${line}: label "${label}" is a built-in reporter's name and cannot be reused`); continue; }
    entries.push({ id, label: (label.charAt(0).toUpperCase() + label.slice(1)), dkimOrgs, from: froms, reportEmails, verified: 'operator', evidence: [{ ref: 'INTAKE_KNOWN_REPORTERS', note: 'added by the operator', copied: false }] });
  }
  // The same id twice in the operator's list is ambiguous (which entry is it?): refuse every entry with that id.
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  const dup = new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id));
  for (const id of dup) issues.push(`id "${id}" appears ${seen.get(id)} times in INTAKE_KNOWN_REPORTERS: every entry with it is ignored`);
  return { entries: entries.filter((e) => !dup.has(e.id)), issues };
}

/** The built-in entries minus the disabled ones, plus the operator's. */
export function effectiveRegistry(env: RegistryEnv): KnownReporter[] {
  const off = new Set((env.INTAKE_KNOWN_REPORTERS_DISABLE ?? '').split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean));
  return [...KNOWN_REPORTERS.filter((e) => !off.has(e.id)), ...parseOperatorEntries(env.INTAKE_KNOWN_REPORTERS).entries];
}

const fromMatches = (pattern: string, address: string): boolean => {
  if (!pattern.includes('*')) return pattern === address;
  const [local, domain] = pattern.split('@');
  const [aLocal, aDomain] = [address.slice(0, address.lastIndexOf('@')), address.slice(address.lastIndexOf('@') + 1)];
  const suffix = domain.slice(2); // after "*."
  return local === aLocal && aDomain.endsWith('.' + suffix) && aDomain.length > suffix.length + 1;
};

/** The registry entries whose DKIM organisation and From address match this authenticated carrier (before the report email is known). */
export function registryCandidates(dkimOrg: string | null, fromAddress: string | null, env: RegistryEnv): KnownReporter[] {
  if (!dkimOrg || !fromAddress) return [];
  const from = fromAddress.toLowerCase();
  return effectiveRegistry(env).filter((e) => e.dkimOrgs.includes(dkimOrg.toLowerCase()) && e.from.some((p) => fromMatches(p, from)));
}

/** Is the report's own `report_metadata/email` in the entry's accepted set? (The report's org_name is never consulted.) */
export function reportEmailAccepted(entry: KnownReporter, reportEmail: string | null | undefined): boolean {
  const e = (reportEmail ?? '').trim().toLowerCase();
  if (!e.includes('@')) return false;
  if (entry.reportEmails.includes(e)) return true;
  const domain = e.slice(e.lastIndexOf('@') + 1);
  return (entry.reportEmailDomains ?? []).some((d) => domain === d || domain.endsWith('.' + d));
}
