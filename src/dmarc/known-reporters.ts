// Known aggregate-report senders: the maintained list that decides which authenticated reports COUNT (hosted default).
//
// Why a list: a DMARC report address is public (it is in the customer's DMARC record), and anyone can register a domain, sign mail
// with valid DKIM and send an authenticated report claiming 100% pass. Authentication proves WHO sent a report, not that the
// sender is an established receiver. A report counts only when the AUTHENTICATED sending identity (the From header that passed
// aligned DKIM/SPF/DMARC, src/dmarc/reporter-auth.ts) matches an entry here. The report's own org_name/email are never consulted:
// they are text the sender wrote.
//
// Two match kinds:
//   address  the From address, exactly (lowercase). REQUIRED on mailbox-provider domains, where any member of the public can get an
//            authenticated mailbox: a domain entry there would let any free-mail user forge a counted report.
//   domain   the From domain or a subdomain of it. Only for domains that give no mailbox to arbitrary users.
//
// Every entry carries its sources. Evidence rules: a real From header or a provider's own statement of the address, with the page and
// the date retrieved; the repository's report fixtures show only the XML metadata (`report_metadata/email`), which is supporting
// evidence for the name of an organisation, not for the From header. Nothing here is guessed: what could not be verified is listed in
// NAMED_BUT_UNVERIFIED and left out. Operators extend or trim the list with INTAKE_KNOWN_REPORTERS / INTAKE_KNOWN_REPORTERS_REMOVE
// (docs/hosted.md) without a code change.

export type MatchKind = 'address' | 'domain';

export interface KnownReporterSource {
  type: 'url' | 'fixture';
  /** The page (URL) or the repository path. */
  ref: string;
  /** When it was read (YYYY-MM-DD); for a dated mail-list post, the post's own date is in `note`. */
  retrieved: string;
  /** What it shows, in one line. */
  note: string;
}

export interface KnownReporter {
  id: string;
  /** Organisation name, shown to the owner ("Google"). */
  org: string;
  kind: MatchKind;
  values: readonly string[];
  sources: readonly KnownReporterSource[];
}

const RETRIEVED = '2026-11-14';

export const KNOWN_REPORTERS: readonly KnownReporter[] = [
  {
    id: 'google', org: 'Google', kind: 'address', values: ['noreply-dmarc-support@google.com'],
    sources: [
      { type: 'url', ref: 'https://community.shopify.com/t/jeden-tag-dmarc-emails-von-google/325586', retrieved: RETRIEVED, note: 'forum post by Jxvtin, 2024-05-23, names the sender address of the daily Google reports' },
      { type: 'fixture', ref: 'test/fixtures/extract-nice.xml', retrieved: RETRIEVED, note: 'a real Google report: <org_name>google.com</org_name>, <email>noreply-dmarc-support@google.com</email> (metadata)' },
    ],
  },
  {
    id: 'microsoft', org: 'Microsoft (Outlook.com)', kind: 'address', values: ['dmarcreport@microsoft.com'],
    sources: [
      { type: 'url', ref: 'https://www.uriports.com/blog/microsoft-dmarc-aggregate-reports/', retrieved: RETRIEVED, note: 'post of 2021-08-16: Microsoft "has been sending us DMARC aggregated reports from dmarcreport@microsoft.com"' },
      { type: 'fixture', ref: 'test/fixtures/outlook.xml', retrieved: RETRIEVED, note: 'a real Outlook.com report: <org_name>Outlook.com</org_name>, <email>dmarcreport@microsoft.com</email> (metadata)' },
    ],
  },
  {
    id: 'yahoo', org: 'Yahoo', kind: 'address', values: ['noreply@dmarc.yahoo.com'],
    sources: [
      { type: 'url', ref: 'https://lists.debian.org/debian-user/2018/07/msg00645.html', retrieved: RETRIEVED, note: 'debian-user post of 2018-07-16 shows the header "From: noreply@dmarc.yahoo.com" on a Yahoo report (Submitter: yahoo.ro)' },
      { type: 'url', ref: 'https://www.mail-archive.com/dmarc@ietf.org/msg12561.html', retrieved: RETRIEVED, note: 'IETF dmarc list, J. Levine 2024-12-07 quoting D. K.: the reports are "DKIM signed by yahoo.com, on behalf of all the other yahoo ccTLDs"' },
    ],
  },
  {
    id: 'fastmail', org: 'Fastmail', kind: 'address', values: ['reports@fastmaildmarc.com'],
    sources: [
      { type: 'url', ref: 'https://lists.humbug.org.au/mailman/pipermail/admin/2023-October/004576.html', retrieved: RETRIEVED, note: 'mailing-list post of 2023-10-10 forwarding a Fastmail report (Submitter: fastmail.com) from "reports at fastmaildmarc.com"' },
      { type: 'fixture', ref: 'test/fixtures/fastmail.xml.gz', retrieved: RETRIEVED, note: 'a real Fastmail report: <org_name>FastMail Pty Ltd</org_name>, <email>reports@fastmaildmarc.com</email> (metadata)' },
    ],
  },
  {
    id: 'comcast', org: 'Comcast', kind: 'address', values: ['dmarc-support@alerts.comcast.net'],
    sources: [
      { type: 'url', ref: 'https://portal.smartertools.com/community/a87891/how-to-parse-dmarc-feedback-from-comcast.aspx', retrieved: RETRIEVED, note: 'forum post of 2016-05-18 shows "Comcast DMARC Report Generator <dmarc-support@alerts.comcast.net>" (old: if Comcast changes the address, its reports are stored, not counted, until the entry is updated)' },
    ],
  },
  {
    id: 'seznam', org: 'Seznam', kind: 'address', values: ['abuse@seznam.cz'],
    sources: [
      { type: 'url', ref: 'https://o-seznam.cz/napoveda/email/profi/zaznamy-pro-autentifikaci-posty/dmarc/', retrieved: RETRIEVED, note: 'Seznam help: "Reporty posíláme z adresy abuse@seznam.cz ve formátu XML." (we send the reports from abuse@seznam.cz)' },
      { type: 'url', ref: 'https://lists.debian.org/debian-user/2018/07/msg00645.html', retrieved: RETRIEVED, note: 'debian-user post of 2018-07-16 shows "From: Seznam.cz <abuse@seznam.cz>" on a Seznam report (Submitter: seznam.cz)' },
    ],
  },
];

/** Organisations the product owner named, or that came up, whose sender could not be verified from real evidence. Not included. */
export const NAMED_BUT_UNVERIFIED: ReadonlyArray<{ org: string; why: string }> = [
  { org: 'Apple / iCloud', why: 'no page or header found that shows the From address of its reports' },
  { org: 'Mimecast', why: 'reports seen with Submitter mimecast.org, but no From address verified' },
  { org: 'Proofpoint', why: 'no example report or documentation found' },
  { org: 'Cisco / IronPort hosted', why: 'a report on the IETF list came from MAILER-DAEMON@rcdn-inbound-b.cisco.com (a host-specific envelope sender), not a stable address' },
  { org: 'Amazon SES', why: 'postmaster@amazonses.com appears in search results only; the page could not be retrieved, and amazonses.com is a shared sending domain' },
  { org: 'Zoho', why: 'noreply-dmarc@zoho.com appears only as XML metadata in Zoho\'s own sample; its From header could not be verified (the complaint page was refused)' },
  { org: 'Mail.ru', why: 'dmarc_support@corp.mail.ru is named by a third-party site only; the Mail.ru help page does not state it' },
  { org: 'Yandex', why: 'no source for the sender address found' },
  { org: 'GMX / web.de / mail.com (United Internet)', why: 'GMX announced aggregate reports (newsroom.gmx.net, 2024-12-17) but no page or header names the From address' },
  { org: 'Yahoo (yahooinc.com variants)', why: 'dmarchelp@yahooinc.com appears only on a third-party "community-captured" list' },
];

/**
 * Domains where any member of the public can get a mailbox that authenticates (free mail) or send as the domain through a shared
 * service. No `domain` entry may name one of these, in the file or in an operator's INTAKE_KNOWN_REPORTERS: it would let any free-mail
 * user forge a counted report. Listed by organisational domain.
 */
export const SHARED_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  'yahoo.com', 'yahoo.co.jp', 'yahoo.co.uk', 'yahoo.ro', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'rocketmail.com', 'yahooinc.com', 'aol.com', 'aim.com', 'verizon.net', 'att.net', 'sbcglobal.net',
  'comcast.net', 'xfinity.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com',
  'gmx.net', 'gmx.de', 'gmx.com', 'gmx.at', 'gmx.ch', 'web.de', 'mail.com', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'yandex.ru', 'yandex.com', 'yandex.net', 'ya.ru',
  'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'daum.net', 'hanmail.net', 'seznam.cz', 'email.cz', 'post.cz', 'proton.me', 'protonmail.com', 'pm.me',
  'zoho.com', 'zohomail.com', 'fastmail.com', 'fastmail.fm', 'hey.com', 'tutanota.com', 'tuta.io',
  'amazonses.com', 'sendgrid.net', 'mailgun.org', 'mandrillapp.com', 'postmarkapp.com', 'sparkpostmail.com', 'mailchimp.com',
]);

// ── matching ────────────────────────────────────────────────

export interface KnownReporterEnv {
  /** Operator additions: comma, space or semicolon separated `domain:example.net` and `address:dmarc@example.org`. */
  INTAKE_KNOWN_REPORTERS?: string;
  /** Operator removals: entry ids (`yahoo`) or values (`noreply@dmarc.yahoo.com`), same separators. */
  INTAKE_KNOWN_REPORTERS_REMOVE?: string;
}

export interface Matcher { org: string; kind: MatchKind; value: string }

export interface ParsedList { entries: Matcher[]; issues: string[] }

const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Is `domain` (or the domain it is a subdomain of) a shared-mailbox domain? */
export function isSharedMailboxDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, '');
  for (const s of SHARED_MAILBOX_DOMAINS) if (d === s || d.endsWith('.' + s)) return true;
  return false;
}

/** Parse INTAKE_KNOWN_REPORTERS. A malformed entry, and a `domain:` entry naming a shared-mailbox domain, is ignored and reported in `issues`. */
export function parseKnownReporterList(raw: string | undefined): ParsedList {
  const entries: Matcher[] = [];
  const issues: string[] = [];
  for (const token of (raw ?? '').split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const colon = token.indexOf(':');
    const kind = colon > 0 ? token.slice(0, colon) : '';
    const value = colon > 0 ? token.slice(colon + 1) : '';
    if (kind === 'address' && ADDRESS_RE.test(value)) entries.push({ org: value.split('@')[1], kind: 'address', value });
    else if (kind === 'domain' && DOMAIN_RE.test(value)) {
      if (isSharedMailboxDomain(value)) issues.push(`${token}: a mailbox-provider domain cannot be listed as a domain (use address:)`);
      else entries.push({ org: value, kind: 'domain', value });
    } else issues.push(`${token}: expected domain:<domain> or address:<address>`);
  }
  return { entries, issues };
}

/** The built-in entries minus the operator's removals, plus the operator's additions. */
export function effectiveKnownReporters(env: KnownReporterEnv): Matcher[] {
  const removed = new Set((env.INTAKE_KNOWN_REPORTERS_REMOVE ?? '').split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean));
  const out: Matcher[] = [];
  for (const e of KNOWN_REPORTERS) {
    if (removed.has(e.id)) continue;
    for (const v of e.values) if (!removed.has(v)) out.push({ org: e.org, kind: e.kind, value: v });
  }
  return [...out, ...parseKnownReporterList(env.INTAKE_KNOWN_REPORTERS).entries];
}

/**
 * Does the authenticated From address match a known reporter? Address entries: exact. Domain entries: the From domain, or a subdomain
 * of it. Returns the organisation name, or null. The caller passes only an address that passed aligned authentication.
 */
export function matchKnownReporter(fromAddress: string | null, env: KnownReporterEnv): { org: string } | null {
  if (!fromAddress) return null;
  const from = fromAddress.trim().toLowerCase();
  const at = from.lastIndexOf('@');
  if (at < 1) return null;
  const domain = from.slice(at + 1);
  for (const m of effectiveKnownReporters(env)) {
    if (m.kind === 'address' ? from === m.value : domain === m.value || domain.endsWith('.' + m.value)) return { org: m.org };
  }
  return null;
}
