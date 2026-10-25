// The report model: one versioned object built from the resolver runs, rendered as HTML, JSON and the agent-prompt Markdown.
//
// Findings come from the consensus of the runs (KTD3): `confirmed` findings are facts, `unconfirmed` ones are shown as
// such and never get a fix step. Each finding's fix and derived values are read from the first run that produced it;
// each current-record section (SPF, DMARC, MX, DKIM, MTA-STS, BIMI) from the first run whose lookup for it completed;
// everything else (grade, providers, unchecked) from the run with the fewest failed lookups.
// Everything is redacted (`build`): no DMARC report mailbox read from DNS leaves the process.

import type { DetectedProvider, DnsHost, DomainReport, Grade } from '@inbox-angel/dns-checks';
import { bimiReadiness, type BimiReadiness } from './bimi-readiness';
import { CATALOG } from './catalog/index';
import { consensus } from './consensus';
import { build, type Facts, type Finding } from './findings';
import { derived, fill, type Fix } from './fixes';

export const REPORT_SCHEMA = 'inbox-angel-report/v1' as const;
/** Below this a finding is a hint ("possible"), not a counted problem (Z render_report.py MIN_CONFIDENCE). */
export const MIN_CONFIDENCE = 0.6;
/** Stands for a mailbox address redacted from the report (`redact`). */
export const REDACTED_ADDRESS = '<address>';

export interface BuildReportInput {
  /** checkDomain() of the same domain, one per DoH resolver. */
  runs: readonly DomainReport[];
  /** NS hosts; defaults to the first run whose NS lookup completed. */
  ns?: string[];
  /** DNS host; defaults to the one detected from `ns` in that run. */
  dnsHost?: DnsHost;
  /** Where the report will live (`https://inboxangel.io/r/<token>`); this package does not serve it. */
  reportUrl?: string | null;
  generatedAt: string;
}

export interface ReportFinding extends Finding {
  status: 'confirmed' | 'unconfirmed';
  consensus: { produced: number; contradicted: number; errored: number };
  fix: Fix;
  /** The template values `derived()` computes for this finding (the pitch path fills its sentences from them). */
  derived: Record<string, string | boolean>;
}

/** One DNS change in the agent plan (KTD6). Every string from DNS stays a literal: renderers never turn it into prose. */
export interface PlanStep {
  n: number;
  finding: string;
  action: 'add' | 'replace';
  type: string;
  /** Fully qualified. */
  name: string;
  /** Relative to the zone (`@` for the apex). */
  zoneName: string;
  /** The live records this step replaces (empty for `add`). Several when duplicates are merged into one. */
  expectedCurrent: string[];
  newValue: string;
  /** Catalog placeholders (and the redacted-address marker) in the values: to be filled before the change is made. */
  placeholders: string[];
  verify: { query: string; match: string };
}

/** Z's mail_check.py `facts`, key for key (snake_case), minus the vendor-stuck signal that stays in prospecting. */
export interface ZFacts {
  domain: string;
  checked_at: string;
  source: string;
  grade: Grade;
  /** The DNS host label (as Z's bridge emitted), or null when unrecognised. */
  dns_host: string | null;
  ns: string[];
  mailbox_providers: DetectedProvider[];
  sender_providers: DetectedProvider[];
  mx: Facts['mx'];
  spf: { status: Facts['spf']['status']; raw: string | null; raws: string[]; verdict: Facts['spf']['verdict']; lookup_count: number; includes: string[]; issues: Facts['spf']['issues'] };
  dmarc: { status: Facts['dmarc']['status']; raw: string | null; raws: string[]; policy: string | null; pct: unknown; sp: string | null; rua: string[]; inherited: boolean; found_at: string | null; valid: boolean | null; issues: string[] };
  dkim: { found_selectors: string[]; scanned: number };
  mta_sts: Facts['mtaSts'];
  bimi: { status: Facts['bimi']['status']; raw: string | null; found_at: string | null; logo: Facts['bimi']['logo']; certificate: Facts['bimi']['certificate'] };
  unchecked: string[];
}

export interface ReportModel {
  schema: typeof REPORT_SCHEMA;
  domain: string;
  generatedAt: string;
  reportUrl: string | null;
  /** How many resolver runs the findings were compared across. */
  resolvers: number;
  grade: Grade;
  providers: { mailbox: DetectedProvider[]; sender: DetectedProvider[] };
  dnsHost: DnsHost;
  ns: string[];
  /** Highest impact x confidence first. Findings no run produced are not listed. */
  findings: ReportFinding[];
  steps: PlanStep[];
  /** Records that fail SPF or DMARC parsing: no step touches them; a human decides. */
  malformed: { finding: string; type: string; name: string }[];
  /** Fixes left out of the plan because an earlier step changes the same record; re-check after the plan. */
  deferred: { finding: string; name: string; afterStep: number }[];
  /** null for a domain that handles no mail. */
  bimi: BimiReadiness | null;
  lookupFailed: { check: string; message: string; runs: number }[];
  unchecked: string[];
  facts: ZFacts;
}

export function zFacts(f: Facts): ZFacts {
  return {
    domain: f.domain, checked_at: f.checkedAt, source: f.source, grade: f.grade,
    dns_host: f.dnsHost.id === 'unknown' ? null : f.dnsHost.label, ns: f.ns,
    mailbox_providers: f.mailboxProviders, sender_providers: f.senderProviders, mx: f.mx,
    spf: { status: f.spf.status, raw: f.spf.raw, raws: f.spf.raws, verdict: f.spf.verdict, lookup_count: f.spf.lookupCount, includes: f.spf.includes, issues: f.spf.issues },
    dmarc: {
      status: f.dmarc.status, raw: f.dmarc.raw, raws: f.dmarc.raws, policy: f.dmarc.policy, pct: f.dmarc.pct, sp: f.dmarc.sp, rua: f.dmarc.rua,
      inherited: f.dmarc.inherited, found_at: f.dmarc.foundAt, valid: f.dmarc.valid, issues: f.dmarc.issues,
    },
    dkim: { found_selectors: f.dkim.foundSelectors, scanned: f.dkim.scanned },
    mta_sts: f.mtaSts,
    bimi: { status: f.bimi.status, raw: f.bimi.raw, found_at: f.bimi.foundAt, logo: f.bimi.logo, certificate: f.bimi.certificate },
    unchecked: f.unchecked,
  };
}

/** Placeholders the catalog itself writes (`<...>` in record templates): trusted text, unlike anything read from DNS. */
const KNOWN_PLACEHOLDERS: string[] = [...new Set([
  REDACTED_ADDRESS,
  ...Object.values(CATALOG).flatMap(file => file.entries.flatMap(e => e.records.flatMap(r => [...`${r.name} ${r.value}`.matchAll(/<[^<>]+>/g)].map(m => m[0])))),
])];

const KINDS: [RegExp, string][] = [[/^v=spf1(\s|$)/i, 'v=spf1'], [/^v=dmarc1(;|\s|$)/i, 'v=DMARC1'], [/^v=bimi1(;|\s|$)/i, 'v=BIMI1'], [/^v=stsv1(;|\s|$)/i, 'v=STSv1']];
const kindOf = (value: string) => KINDS.find(([re]) => re.test(value.trim()))?.[1] ?? null;

/** The live records a fix record would replace: same name, same record kind. */
function currentFor(facts: Facts, name: string, type: string, kind: string | null): string[] {
  if (type !== 'TXT' || !kind) return [];
  const d = facts.domain;
  if (kind === 'v=spf1' && name === d) return facts.spf.raws.length ? facts.spf.raws : facts.spf.raw ? [facts.spf.raw] : [];
  if (kind === 'v=DMARC1' && name === `_dmarc.${d}` && facts.dmarc.foundAt === name) return facts.dmarc.raws.length ? facts.dmarc.raws : facts.dmarc.raw ? [facts.dmarc.raw] : [];
  if (kind === 'v=BIMI1' && facts.bimi.foundAt === name && facts.bimi.raw) return [facts.bimi.raw];
  return [];
}

function matchRule(type: string, kind: string | null): string {
  if (kind) return `the answer holds exactly one ${type} record starting with \`${kind}\`, and it equals new_value (ignore the quotes and string splits dig adds)`;
  return `the answer equals new_value (ignore the quotes and string splits dig adds)`;
}

const MALFORMED_BY: Record<string, { type: string; name: (d: string) => string }> = {
  'spf-permerror': { type: 'TXT', name: d => d },
  'dmarc-invalid': { type: 'TXT', name: d => `_dmarc.${d}` },
};

/** Whether a confirmed finding's fix goes into the plan and the HTML step-by-step (Z: serious or exact, with something to do). */
export function planned(f: ReportFinding): boolean {
  return f.status === 'confirmed' && (f.severity !== 'low' || f.fix.exact) && (f.fix.records.length > 0 || f.fix.steps.length > 0);
}

export function buildReport({ runs, ns, dnsHost, reportUrl = null, generatedAt }: BuildReportInput): ReportModel {
  if (runs.length === 0) throw new Error('buildReport needs at least one checkDomain() run');
  const domain = runs[0].domain;
  if (runs.some(r => r.domain !== domain)) throw new Error('buildReport: runs are for different domains');
  const base = runs.reduce((best, r) => (r.errors.length < best.errors.length ? r : best));
  const nsRun = runs.find(r => r.ns.status !== 'error') ?? base;
  const host = dnsHost ?? nsRun.dnsHost;
  const built = runs.map(r => build(r, generatedAt));
  const baseFacts = built[runs.indexOf(base)].facts;
  const shared = { dnsHost: host, ns: ns ?? nsRun.ns.hosts };
  /** Facts of the first run whose lookup for `check` completed (the fewest-errors run when none did). */
  const completed = (check: DomainReport['errors'][number]['check']) =>
    built[runs.findIndex(r => !r.errors.some(e => e.check === check))]?.facts ?? baseFacts;
  const facts: Facts = {
    ...baseFacts, ...shared,
    spf: completed('spf').spf, dmarc: completed('dmarc').dmarc, mx: completed('mx').mx, dkim: completed('dkim').dkim,
    mtaSts: completed('mta-sts').mtaSts, bimi: completed('bimi').bimi,
  };
  /** Facts of the first run that produced `id`: its fix and derived values match the records that finding rests on. */
  const factsFor = (id: string): Facts => {
    const i = built.findIndex(b => b.findings.some(x => x.id === id));
    return i < 0 ? facts : { ...built[i].facts, ...shared };
  };

  const findings: ReportFinding[] = consensus(runs, generatedAt)
    .filter(c => c.status !== 'absent' && c.finding)
    .map(c => ({
      ...c.finding!, status: c.status === 'confirmed' ? 'confirmed' as const : 'unconfirmed' as const,
      consensus: { produced: c.produced, contradicted: c.contradicted, errored: c.errored },
      fix: fill(c.finding!, factsFor(c.id)), derived: derived(c.finding!.id, factsFor(c.id)),
    }))
    .map((f, i) => ({ f, i }))
    .sort((a, b) => b.f.impact * b.f.confidence - a.f.impact * a.f.confidence || a.i - b.i)
    .map(({ f }) => f);

  const malformed = findings.filter(f => MALFORMED_BY[f.id]).map(f => ({ finding: f.id, type: MALFORMED_BY[f.id].type, name: MALFORMED_BY[f.id].name(domain) }));
  const steps: PlanStep[] = [];
  const deferred: ReportModel['deferred'] = [];
  for (const f of findings) {
    if (!planned(f) || f.confidence < MIN_CONFIDENCE) continue;
    for (const rec of f.fix.records) {
      const kind = kindOf(rec.value);
      if (malformed.some(m => m.name === rec.name && m.type === rec.type)) continue; // a record that does not parse: a human decides
      const earlier = steps.find(s => s.name === rec.name && s.type === rec.type && kindOf(s.newValue) === kind);
      if (earlier) { deferred.push({ finding: f.id, name: rec.name, afterStep: earlier.n }); continue; }
      const expectedCurrent = currentFor(facts, rec.name, rec.type, kind);
      const text = [rec.name, rec.value, ...expectedCurrent].join('\n');
      steps.push({
        n: steps.length + 1, finding: f.id, action: expectedCurrent.length ? 'replace' : 'add', type: rec.type, name: rec.name, zoneName: rec.host,
        expectedCurrent, newValue: rec.value, placeholders: KNOWN_PLACEHOLDERS.filter(p => text.includes(p)),
        verify: { query: `dig +short ${rec.type} ${rec.name}`, match: matchRule(rec.type, kind) },
      });
    }
  }

  const failed = new Map<string, { check: string; message: string; runs: number }>();
  for (const r of runs) for (const e of r.errors) {
    const known = failed.get(e.check);
    if (known) known.runs++;
    else failed.set(e.check, { check: e.check, message: e.message, runs: 1 });
  }
  const mailDomain = facts.mx.status === 'found' || facts.senderProviders.length > 0 || facts.mailboxProviders.length > 0;
  return {
    schema: REPORT_SCHEMA, domain, generatedAt, reportUrl, resolvers: runs.length, grade: base.grade,
    providers: { mailbox: facts.mailboxProviders, sender: facts.senderProviders }, dnsHost: host, ns: facts.ns,
    findings, steps, malformed, deferred, bimi: mailDomain ? bimiReadiness(facts) : null,
    lookupFailed: [...failed.values()], unchecked: facts.unchecked, facts: zFacts(facts),
  };
}
