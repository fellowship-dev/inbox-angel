// SPF (RFC 7208): parsing, static evaluation of DNS-lookup cost, and flatten preview.
//
// This is a *static analyser*, not a full check_host(): without a connecting IP it
// walks every mechanism that could be evaluated and reports the worst-case cost.

import { normalizeName, type Resolver } from './doh';

// ── Types ────────────────────────────────────────────────────

export type SpfQualifier = '+' | '-' | '~' | '?';

export interface SpfTerm {
  raw: string;
  kind: 'mechanism' | 'modifier';
  /** all | include | a | mx | ptr | ip4 | ip6 | exists | redirect | exp | <unknown> */
  name: string;
  qualifier: SpfQualifier;
  /** domain-spec / network / modifier value (without cidr for a/mx) */
  value: string | null;
  cidr4?: number;
  cidr6?: number;
}

export interface SpfRecord {
  raw: string;
  /** Lowercased tokens after v=spf1 (kept for display / back-compat). */
  mechanisms: string[];
  terms: SpfTerm[];
  verdict: 'strict' | 'soft' | 'open' | 'missing';
  lookup_count?: number;
}

export type SpfIssueCode =
  | 'multiple-records'
  | 'lookup-limit'
  | 'void-lookup-limit'
  | 'mx-name-limit'
  | 'loop'
  | 'include-no-record'
  | 'redirect-no-record'
  | 'syntax'
  | 'depth-limit'
  | 'dns-error';

export interface SpfIssue {
  code: SpfIssueCode;
  domain: string;
  message: string;
}

export type SpfStatus =
  /** a valid record exists and evaluates within RFC limits */
  | 'ok'
  /** the domain has no SPF record (authoritative NXDOMAIN/NODATA or no v=spf1 TXT) */
  | 'none'
  /** RFC 7208 "permerror": record(s) can never evaluate successfully */
  | 'permerror'
  /** we could not determine the answer because DNS failed (RFC "temperror") */
  | 'temperror';

export interface SpfAnalysis {
  domain: string;
  status: SpfStatus;
  record: SpfRecord | null;
  /** DNS-querying terms counted per RFC 7208 §4.6.4 (limit 10). */
  lookupCount: number;
  /** void lookups (NXDOMAIN / empty answers) counted per §4.6.4 (limit 2). */
  voidLookupCount: number;
  lookupLimitExceeded: boolean;
  voidLimitExceeded: boolean;
  issues: SpfIssue[];
  /** every include:/redirect= domain reached, depth-first */
  includes: string[];
}

export const SPF_LOOKUP_LIMIT = 10;
export const SPF_VOID_LIMIT = 2;
export const SPF_MX_NAME_LIMIT = 10;
const MAX_DEPTH = 12; // hard recursion guard; real chains are shallower than the 10-lookup cap

// ── Parsing ──────────────────────────────────────────────────

/** True when a TXT string is an SPF record: `v=spf1` followed by a space or end. */
export function isSpfRecord(txt: string): boolean {
  return /^v=spf1(\s|$)/i.test(txt.trim());
}

const MECHANISMS = new Set(['all', 'include', 'a', 'mx', 'ptr', 'ip4', 'ip6', 'exists']);

function parseCidr(s: string): { host: string; cidr4?: number; cidr6?: number } {
  // a/24, a//64, a/24//64, a:domain/24
  const m = s.match(/^([^/]*)(?:\/(\d+))?(?:\/\/(\d+))?$/);
  if (!m) return { host: s };
  return {
    host: m[1],
    ...(m[2] !== undefined ? { cidr4: parseInt(m[2], 10) } : {}),
    ...(m[3] !== undefined ? { cidr6: parseInt(m[3], 10) } : {}),
  };
}

export function parseSpfTerms(raw: string): SpfTerm[] {
  const tokens = raw.trim().split(/\s+/).slice(1); // drop v=spf1
  const terms: SpfTerm[] = [];
  for (const token of tokens) {
    if (!token) continue;
    // A modifier is name=value where name is alpha-start [alnum._-]* and not a qualifier-prefixed mechanism
    const mod = token.match(/^([A-Za-z][A-Za-z0-9._-]*)=(.*)$/);
    if (mod) {
      terms.push({ raw: token, kind: 'modifier', name: mod[1].toLowerCase(), qualifier: '+', value: mod[2] });
      continue;
    }
    let qualifier: SpfQualifier = '+';
    let rest = token;
    if ('+-~?'.includes(rest[0])) {
      qualifier = rest[0] as SpfQualifier;
      rest = rest.slice(1);
    }
    const m = rest.match(/^([A-Za-z0-9]+)(?:([:/])(.*))?$/);
    if (!m) {
      terms.push({ raw: token, kind: 'mechanism', name: rest.toLowerCase(), qualifier, value: null });
      continue;
    }
    const name = m[1].toLowerCase();
    const term: SpfTerm = { raw: token, kind: 'mechanism', name, qualifier, value: null };
    if (m[2] === ':') {
      if (name === 'a' || name === 'mx') {
        const { host, cidr4, cidr6 } = parseCidr(m[3]);
        term.value = host;
        if (cidr4 !== undefined) term.cidr4 = cidr4;
        if (cidr6 !== undefined) term.cidr6 = cidr6;
      } else {
        term.value = m[3];
      }
    } else if (m[2] === '/' && (name === 'a' || name === 'mx')) {
      const { cidr4, cidr6 } = parseCidr('/' + m[3]);
      if (cidr4 !== undefined) term.cidr4 = cidr4;
      if (cidr6 !== undefined) term.cidr6 = cidr6;
    }
    terms.push(term);
  }
  return terms;
}

export function parseSpfRecord(raw: string): SpfRecord {
  const terms = parseSpfTerms(raw);
  const mechanisms = raw
    .trim()
    .split(/\s+/)
    .filter(p => !/^v=spf1$/i.test(p))
    .map(p => p.toLowerCase());

  const all = terms.find(t => t.kind === 'mechanism' && t.name === 'all');
  let verdict: SpfRecord['verdict'] = 'missing';
  if (all) {
    if (all.qualifier === '-') verdict = 'strict';
    else if (all.qualifier === '~') verdict = 'soft';
    else verdict = 'open'; // +all or ?all
  }
  return { raw, mechanisms, terms, verdict };
}

/** Does this term cost a DNS lookup under RFC 7208 §4.6.4? */
export function termCountsAsLookup(term: SpfTerm): boolean {
  if (term.kind === 'modifier') return term.name === 'redirect';
  return ['include', 'a', 'mx', 'ptr', 'exists'].includes(term.name);
}

function hasMacro(s: string | null): boolean {
  return !!s && s.includes('%');
}

// ── Analysis ─────────────────────────────────────────────────

interface Ctx {
  resolver: Resolver;
  lookups: number;
  voids: number;
  issues: SpfIssue[];
  includes: string[];
  dnsError: boolean;
  cache: Map<string, Promise<TxtFetch>>;
}

type TxtFetch =
  | { kind: 'record'; raw: string }
  | { kind: 'none' }
  | { kind: 'multiple'; count: number }
  | { kind: 'error'; error: string };

function fetchSpfTxt(ctx: Ctx, domain: string): Promise<TxtFetch> {
  const key = normalizeName(domain);
  let p = ctx.cache.get(key);
  if (!p) {
    p = ctx.resolver.txt(key).then((r): TxtFetch => {
      if (r.status === 'error') return { kind: 'error', error: r.error ?? 'DNS error' };
      const spf = r.records.filter(isSpfRecord);
      if (spf.length === 0) return { kind: 'none' };
      if (spf.length > 1) return { kind: 'multiple', count: spf.length };
      return { kind: 'record', raw: spf[0].trim() };
    });
    ctx.cache.set(key, p);
  }
  return p;
}

function addIssue(ctx: Ctx, code: SpfIssueCode, domain: string, message: string) {
  ctx.issues.push({ code, domain, message });
}

function noteDnsError(ctx: Ctx, domain: string, error: string) {
  ctx.dnsError = true;
  addIssue(ctx, 'dns-error', domain, error);
}

function countVoid(ctx: Ctx, domain: string, what: string) {
  ctx.voids++;
  if (ctx.voids === SPF_VOID_LIMIT + 1) {
    addIssue(ctx, 'void-lookup-limit', domain, `More than ${SPF_VOID_LIMIT} void lookups (${what} returned no data); RFC 7208 §4.6.4 requires permerror`);
  }
}

function countLookup(ctx: Ctx, domain: string, term: string): boolean {
  ctx.lookups++;
  if (ctx.lookups === SPF_LOOKUP_LIMIT + 1) {
    addIssue(ctx, 'lookup-limit', domain, `More than ${SPF_LOOKUP_LIMIT} DNS-querying terms (exceeded at "${term}"); RFC 7208 §4.6.4 requires permerror`);
  }
  return ctx.lookups <= SPF_LOOKUP_LIMIT;
}

async function walk(ctx: Ctx, domain: string, raw: string, path: string[], depth: number): Promise<void> {
  const record = parseSpfRecord(raw);
  const hasAll = record.terms.some(t => t.kind === 'mechanism' && t.name === 'all');

  for (const t of record.terms) {
    if (t.kind === 'mechanism' && !MECHANISMS.has(t.name)) {
      addIssue(ctx, 'syntax', domain, `Unknown mechanism "${t.raw}"`);
      continue;
    }
    // redirect= is ignored when an `all` mechanism is present (RFC 7208 §6.1), so it never costs a lookup.
    if (t.kind === 'modifier' && t.name === 'redirect' && hasAll) continue;
    if (!termCountsAsLookup(t)) continue;

    if (!countLookup(ctx, domain, t.raw)) return; // already permerror – stop spending queries

    const isRef = t.name === 'include' || t.name === 'redirect';
    if (isRef) {
      const target = t.value ? normalizeName(t.value) : '';
      if (!target) {
        addIssue(ctx, 'syntax', domain, `"${t.raw}" has no target domain`);
        continue;
      }
      if (hasMacro(target)) continue; // macro-expanded at evaluation time; cannot be followed statically
      ctx.includes.push(target);
      if (path.includes(target)) {
        addIssue(ctx, 'loop', domain, `SPF loop: ${[...path, target].join(' → ')}`);
        continue;
      }
      if (depth + 1 > MAX_DEPTH) {
        addIssue(ctx, 'depth-limit', domain, `SPF nesting deeper than ${MAX_DEPTH}`);
        continue;
      }
      const sub = await fetchSpfTxt(ctx, target);
      const noRecord = t.name === 'include' ? 'include-no-record' : 'redirect-no-record';
      if (sub.kind === 'error') noteDnsError(ctx, target, `${sub.error} while resolving ${t.raw}`);
      else if (sub.kind === 'none') {
        addIssue(ctx, noRecord, target, `${t.raw} points at ${target}, which publishes no SPF record (permerror)`);
        countVoid(ctx, target, `TXT ${target}`);
      } else if (sub.kind === 'multiple') {
        addIssue(ctx, 'multiple-records', target, `${target} publishes ${sub.count} SPF records (permerror)`);
      } else {
        await walk(ctx, target, sub.raw, [...path, target], depth + 1);
      }
      continue;
    }

    if (t.name === 'a') {
      const target = hasMacro(t.value) ? null : normalizeName(t.value || domain);
      if (target) {
        const [a, aaaa] = await Promise.all([ctx.resolver.resolve(target, 'A'), ctx.resolver.resolve(target, 'AAAA')]);
        if (a.status === 'error') noteDnsError(ctx, target, `${a.error} resolving A for ${t.raw}`);
        else if (aaaa.status === 'error') noteDnsError(ctx, target, `${aaaa.error} resolving AAAA for ${t.raw}`);
        else if (a.status !== 'ok' && aaaa.status !== 'ok') countVoid(ctx, target, `A/AAAA ${target}`);
      }
    } else if (t.name === 'mx') {
      const target = hasMacro(t.value) ? null : normalizeName(t.value || domain);
      if (target) {
        const mx = await ctx.resolver.resolve(target, 'MX');
        if (mx.status === 'error') noteDnsError(ctx, target, `${mx.error} resolving MX for ${t.raw}`);
        else if (mx.status !== 'ok') countVoid(ctx, target, `MX ${target}`);
        else if (mx.answers.length > SPF_MX_NAME_LIMIT) {
          addIssue(ctx, 'mx-name-limit', target, `${t.raw} resolves ${mx.answers.length} MX hosts; more than ${SPF_MX_NAME_LIMIT} is a permerror (RFC 7208 §4.6.4)`);
        }
      }
    } else if (t.name === 'exists') {
      const target = hasMacro(t.value) ? null : t.value ? normalizeName(t.value) : null;
      if (target) {
        const e = await ctx.resolver.resolve(target, 'A');
        if (e.status === 'error') noteDnsError(ctx, target, `${e.error} resolving ${t.raw}`);
        else if (e.status !== 'ok') countVoid(ctx, target, `A ${target}`);
      }
    }
    // ptr: counts as a lookup but is never resolved statically (needs a client IP)
  }
}

const FATAL_CODES = new Set<SpfIssueCode>([
  'multiple-records', 'lookup-limit', 'void-lookup-limit', 'mx-name-limit', 'loop',
  'include-no-record', 'redirect-no-record', 'depth-limit', 'syntax',
]);

function finish(ctx: Ctx, domain: string, record: SpfRecord | null, hardStatus?: SpfStatus): SpfAnalysis {
  let status: SpfStatus;
  if (hardStatus) status = hardStatus;
  else if (ctx.issues.some(i => FATAL_CODES.has(i.code))) status = 'permerror';
  else if (ctx.dnsError) status = 'temperror';
  else status = 'ok';
  return {
    domain,
    status,
    record: record ? { ...record, lookup_count: ctx.lookups } : null,
    lookupCount: ctx.lookups,
    voidLookupCount: ctx.voids,
    lookupLimitExceeded: ctx.lookups > SPF_LOOKUP_LIMIT,
    voidLimitExceeded: ctx.voids > SPF_VOID_LIMIT,
    issues: ctx.issues,
    includes: ctx.includes,
  };
}

/**
 * Fetch the SPF record published at `domain` and statically evaluate it.
 * DNS failures yield `temperror` (never `none`).
 */
export async function analyzeSpf(domain: string, resolver: Resolver): Promise<SpfAnalysis> {
  const name = normalizeName(domain);
  const ctx: Ctx = { resolver, lookups: 0, voids: 0, issues: [], includes: [], dnsError: false, cache: new Map() };
  const root = await fetchSpfTxt(ctx, name);
  if (root.kind === 'error') {
    noteDnsError(ctx, name, root.error);
    return finish(ctx, name, null, 'temperror');
  }
  if (root.kind === 'none') return finish(ctx, name, null, 'none');
  if (root.kind === 'multiple') {
    addIssue(ctx, 'multiple-records', name, `${name} publishes ${root.count} SPF records; RFC 7208 §4.5 requires permerror`);
    return finish(ctx, name, null, 'permerror');
  }
  await walk(ctx, name, root.raw, [name], 0);
  return finish(ctx, name, parseSpfRecord(root.raw));
}

/**
 * Evaluate a not-yet-published SPF record string (root level parsed locally, includes
 * resolved via DNS). `domain` is the name the record would be published at (loop detection / a,mx defaults).
 */
export async function analyzeSpfRecord(record: string, resolver: Resolver, domain = ''): Promise<SpfAnalysis> {
  const name = normalizeName(domain);
  const ctx: Ctx = { resolver, lookups: 0, voids: 0, issues: [], includes: [], dnsError: false, cache: new Map() };
  if (!isSpfRecord(record)) {
    addIssue(ctx, 'syntax', name, 'Record must start with v=spf1');
    return finish(ctx, name, null, 'permerror');
  }
  await walk(ctx, name, record.trim(), name ? [name] : [], 0);
  return finish(ctx, name, parseSpfRecord(record.trim()));
}

// ── Flatten preview ──────────────────────────────────────────

export interface CollectResult {
  /** all resolved ip4:/ip6: entries (deduplicated, original text incl. qualifier) */
  ips: string[];
  /** mechanisms that cannot be flattened and are kept verbatim: a, mx, ptr, exists, non-pass includes */
  extra: string[];
  /** terminal all-mechanism of the root record (`~all` default when none) */
  allQualifier: string;
  /** anything that makes the result unsafe to publish (DNS errors, loops, multiple records) */
  errors: SpfIssue[];
}

/**
 * Resolve include:/redirect= chains into ip4:/ip6: entries.
 * If `errors` is non-empty the result is INCOMPLETE and must not be published.
 */
export async function collectIps(domain: string, resolver: Resolver): Promise<CollectResult> {
  const out: CollectResult = { ips: [], extra: [], allQualifier: '~all', errors: [] };
  const seenIps = new Set<string>();
  const seenExtra = new Set<string>();
  const cache = new Map<string, Promise<TxtFetch>>();
  const ctx: Ctx = { resolver, lookups: 0, voids: 0, issues: out.errors, includes: [], dnsError: false, cache };

  // Returns the effective terminal `all` token of the policy chain (record + redirects), or null.
  // `policy` is false while walking include: targets, whose `all` never defines the policy.
  async function visit(d: string, path: string[], policy: boolean): Promise<string | null> {
    const res = await fetchSpfTxt(ctx, d);
    if (res.kind === 'error') { addIssue(ctx, 'dns-error', d, res.error); return null; }
    if (res.kind === 'none') {
      if (path.length > 1) addIssue(ctx, 'include-no-record', d, `${d} publishes no SPF record`);
      return null;
    }
    if (res.kind === 'multiple') { addIssue(ctx, 'multiple-records', d, `${d} publishes ${res.count} SPF records`); return null; }

    const rec = parseSpfRecord(res.raw);
    const hasAll = rec.terms.some(t => t.kind === 'mechanism' && t.name === 'all');
    let allToken: string | null = null;
    const keep = (raw: string) => {
      const k = raw.toLowerCase();
      if (!seenExtra.has(k)) { seenExtra.add(k); out.extra.push(k); }
    };
    for (const t of rec.terms) {
      if (t.kind === 'modifier') {
        if (t.name === 'redirect' && !hasAll && t.value) {
          const target = normalizeName(t.value);
          if (hasMacro(target)) { keep(t.raw); continue; }
          if (path.includes(target)) addIssue(ctx, 'loop', d, `SPF loop: ${[...path, target].join(' → ')}`);
          else allToken = await visit(target, [...path, target], policy);
        }
        continue;
      }
      if (t.name === 'ip4' || t.name === 'ip6') {
        const entry = (t.qualifier === '+' ? '' : t.qualifier) + `${t.name}:${t.value ?? ''}`;
        const k = entry.toLowerCase();
        if (!seenIps.has(k)) { seenIps.add(k); out.ips.push(entry); }
      } else if (t.name === 'include') {
        const target = t.value ? normalizeName(t.value) : '';
        if (!target || hasMacro(target) || t.qualifier !== '+') keep(t.raw);
        else if (path.includes(target)) addIssue(ctx, 'loop', d, `SPF loop: ${[...path, target].join(' → ')}`);
        else await visit(target, [...path, target], false);
      } else if (t.name === 'all') {
        if (policy) allToken = t.raw.toLowerCase();
      } else if (['a', 'mx', 'ptr', 'exists'].includes(t.name)) {
        keep(t.raw);
      }
    }
    return allToken;
  }

  const rootName = normalizeName(domain);
  const all = await visit(rootName, [rootName], true);
  if (all) out.allQualifier = all;
  return out;
}

export function buildFlatRecord(ips: string[], extra: string[], allQualifier: string): string {
  const seen = new Set<string>();
  const deduped = ips.filter(ip => (seen.has(ip) ? false : (seen.add(ip), true)));
  return ['v=spf1', ...deduped, ...extra, allQualifier].join(' ');
}

export interface FlattenPreview {
  flattenedRecord: string;
  ipCount: number;
  /** DNS-querying terms left in the flattened record (a/mx/ptr/exists kept verbatim) */
  remainingLookups: number;
  /** TXT strings are 255 bytes; longer records must be split into several strings */
  needsSplitting: boolean;
  /** UDP-safe limit is ~450 bytes; beyond ~512 many resolvers truncate */
  tooLongForUdp: boolean;
  /** true when DNS errors/loops occurred – DO NOT publish */
  incomplete: boolean;
  errors: SpfIssue[];
}

export async function previewFlatten(domain: string, resolver: Resolver): Promise<FlattenPreview> {
  const { ips, extra, allQualifier, errors } = await collectIps(domain, resolver);
  const flattenedRecord = buildFlatRecord(ips, extra, allQualifier);
  const bytes = new TextEncoder().encode(flattenedRecord).length;
  return {
    flattenedRecord,
    ipCount: ips.length,
    remainingLookups: extra.length,
    needsSplitting: bytes > 255,
    tooLongForUdp: bytes > 450,
    incomplete: errors.length > 0,
    errors,
  };
}
