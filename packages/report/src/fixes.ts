// Fix catalog lookup: finding x provider x DNS host -> plain-English title, why it matters, record(s) and DIY steps.
// Port of unzip-inboxangel outreach-tools/fixes.py.
//
// The most specific matching catalog entry wins. Record values are templates filled from the domain's real data
// ({domain}, plus the derived values below). A step "@dns_host" expands to the DNS host's steps (Cloudflare, else
// generic). A fix is `exact` when every record value is fully determined by what was observed: nothing is left for the
// customer to copy from a provider dashboard. Only exact fixes may be written inline in a first email.

import type { DetectedProvider, DnsHost } from '@inbox-angel/dns-checks';
import { CATALOG, DNS_HOST_STEPS, type CatalogEntry, type CatalogFile, type DnsHostCatalog } from './catalog/index';
import type { Facts, Finding } from './findings';

type Values = Record<string, string | boolean>;

export interface FixRecord {
  /** Fully qualified name. */
  name: string;
  /** Name relative to the zone (`@` for the apex). */
  host: string;
  type: string;
  value: string;
  note: string;
}

export interface Fix {
  finding: string;
  title: string;
  why: string;
  records: FixRecord[];
  steps: string[];
  exact: boolean;
  provider: DetectedProvider | null;
  dnsHost: DnsHost;
  dnsHostLabel: string | null;
  needsFromProvider: string[];
  caveat: string | null;
  optionalNext: string | null;
  hints: string[];
  sources: string[];
  /** false when no catalog entry matched and the fix is the generic fallback. */
  catalog: boolean;
}

/** DNS host ids that have their own catalog steps; every other host gets the generic steps. */
const CATALOG_HOSTS = new Set(['cloudflare']);
const PLACEHOLDER = /<[^>]+>|\{[a-z_]+\}/;
const UNFILLED = /\{[a-z_]+\}/;
const ALL_TERM = /^[+\-~?]?all$/i;

export function relName(fqdn: string, domain: string): string {
  if (fqdn === domain) return '@';
  return fqdn.endsWith('.' + domain) ? fqdn.slice(0, -domain.length - 1) : fqdn;
}

const spfTerms = (raw: string | null) => (raw ? raw.split(/\s+/).filter(Boolean).slice(1) : []);
const tagKey = (part: string) => part.split('=')[0].trim().toLowerCase();
const tagValue = (part: string) => (part.includes('=') ? part.slice(part.indexOf('=') + 1).trim() : '');

/** The current DMARC record with p=quarantine (or the stricter reject already set), pct=100 and no non-enforcing sp=; every other tag is kept. */
export function enforcedDmarc(raw: string | null, domain: string): string {
  const parts = (raw ?? '').split(';').map(p => p.trim()).filter(Boolean);
  const tags: Record<string, string> = {};
  for (const p of parts) tags[tagKey(p)] = tagValue(p);
  const policy = (tags.p ?? '').toLowerCase();
  const chosen = policy === 'quarantine' || policy === 'reject' ? policy : 'quarantine';
  // an existing sp=none (or any non-enforcing sp) would keep BIMI blocked: drop it so subdomains follow p
  const keep = parts.filter(p => !['v', 'p', 'pct'].includes(tagKey(p))
    && !(tagKey(p) === 'sp' && !['quarantine', 'reject'].includes(tagValue(p).toLowerCase())));
  if (!keep.some(p => tagKey(p) === 'rua')) keep.push(`rua=mailto:dmarc@${domain}`);
  return ['v=DMARC1', `p=${chosen}`, 'pct=100', ...keep].join('; ');
}

/** Values computed from the observed records. A missing key means no exact value is possible. */
export function derived(findingId: string, facts: Facts): Values {
  const v: Values = { domain: facts.domain };
  const { spf, dmarc } = facts;
  if (findingId === 'spf-open' && spf.raw) {
    const raw = spf.raw.trim();
    const term = raw.match(/(^|\s)([+?]?all)\s*$/i)?.[2] ?? 'all';
    v.all_term = term;
    v.all_meaning = term.startsWith('?') ? 'takes no position on which servers may send as the domain (neutral)' : 'allows any server to send as the domain';
    v.spf_current = raw;
    const others = spfTerms(raw).filter(t => !ALL_TERM.test(t));
    v.has_other_terms = others.length > 0;
    if (others.length) v.spf_value = raw.replace(/(^|\s)[+?]?all\s*$/i, '$1~all'); // a bare "v=spf1 +all" must not become "v=spf1 ~all", which authorises nobody
  } else if (findingId === 'spf-no-all' && spf.raw && !spf.raw.toLowerCase().includes('redirect=')) {
    v.spf_value = spf.raw.trim() + ' ~all';
  } else if (findingId === 'multiple-spf' && spf.raws.length > 1 && !spf.raws.some(r => r.toLowerCase().includes('redirect='))) {
    const terms: string[] = [];
    for (const r of spf.raws) for (const t of spfTerms(r)) if (!ALL_TERM.test(t) && !terms.includes(t)) terms.push(t);
    const strict = spf.raws.every(r => r.trim().toLowerCase().endsWith('-all'));
    v.spf_value = ['v=spf1', ...terms, strict ? '-all' : '~all'].join(' ');
  }
  if (findingId === 'dmarc-multiple' && dmarc.raws.length) v.dmarc_value = dmarc.raws[0];
  if (findingId === 'dmarc-p-none-no-rua' && dmarc.raw) v.dmarc_value = dmarc.raw.replace(/[; ]+$/, '') + `; rua=mailto:dmarc@${facts.domain}`;
  // no record yet: start with dmarc-missing, never publish enforcement from scratch
  if ((findingId === 'bimi-blocked-by-dmarc-none' || findingId === 'bimi-blocked-by-dmarc-pct') && dmarc.raw) v.dmarc_enforce_value = enforcedDmarc(dmarc.raw, facts.domain);
  if (findingId === 'spf-permerror' || findingId === 'spf-over-10-lookups') {
    v.spf_current = spf.raw ?? '';
    v.lookups = spf.lookupCount ? String(spf.lookupCount) : '';
    v.includes = spf.includes.join(', ');
  }
  return v;
}

/** The detected provider this finding's fix should be specific to, or null. */
export function providerFor(finding: Finding, facts: Facts): DetectedProvider | null {
  if (finding.id === 'dkim-not-found-for-sender') return facts.senderProviders.find(p => p.id === finding.provider) ?? null;
  if (finding.id === 'spf-missing') return facts.mailboxProviders[0] ?? null;
  return null;
}

function whenOk(entry: CatalogEntry, values: Values): boolean {
  const cond = entry.when;
  if (!cond) return true;
  return cond.startsWith('!') ? !values[cond.slice(1)] : Boolean(values[cond]);
}

/** The most specific entry: a provider match outranks a DNS-host match; `*` matches anything. */
export function pickEntry(file: CatalogFile | undefined, providerId: string | null, dnsHostId: string | null, values: Values = {}): CatalogEntry | null {
  if (!file) return null;
  const host = dnsHostId && CATALOG_HOSTS.has(dnsHostId) ? dnsHostId : null;
  let best: CatalogEntry | null = null;
  let bestScore = -1;
  for (const e of file.entries) {
    if ((e.provider !== '*' && e.provider !== providerId) || (e.dns_host !== '*' && e.dns_host !== host) || !whenOk(e, values)) continue;
    const score = (providerId && e.provider === providerId ? 2 : 0) + (host && e.dns_host === host ? 1 : 0);
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return best;
}

export function fillText(text: string, values: Values): string {
  return text.replace(/\{([a-z_0-9]+)\}/g, (m, key: string) => (key in values ? String(values[key]) : m));
}

function expandSteps(steps: string[], records: FixRecord[], hostKey: keyof DnsHostCatalog['hosts'], hosts: DnsHostCatalog, values: Values): string[] {
  const out: string[] = [];
  const hostSteps = (hosts.hosts[hostKey] ?? hosts.hosts.generic).steps;
  for (const s of steps) {
    if (s !== '@dns_host') { out.push(fillText(s, values)); continue; }
    for (const rec of records) {
      const v = { ...values, rec_name: rec.host, rec_fqdn: rec.name, rec_type: rec.type, rec_value: rec.value };
      for (const x of hostSteps) {
        const [text, types] = typeof x === 'string' ? [x, null] : [x.text, x.types];
        if (types === null || types.includes(rec.type)) out.push(fillText(text, v)); // e.g. the proxy step is for CNAME records only
      }
    }
  }
  return out;
}

/** Everything the report and pitch need for one finding on one domain. Pass facts from `build` so nothing carries a mailbox address. */
export function fill(finding: Finding, facts: Facts, catalog: Readonly<Record<string, CatalogFile>> = CATALOG, hosts: DnsHostCatalog = DNS_HOST_STEPS): Fix {
  const prov = providerFor(finding, facts);
  const values: Values = { ...derived(finding.id, facts), provider: prov ? prov.name : 'your mail service' };
  const entry = pickEntry(catalog[finding.id], prov?.id ?? null, facts.dnsHost.id, values);
  const base = { finding: finding.id, provider: prov, dnsHost: facts.dnsHost };
  if (!entry) {
    return {
      ...base, title: finding.title, why: '', records: [], steps: ["Check your provider's DNS settings page."], exact: false, dnsHostLabel: null,
      needsFromProvider: [], caveat: null, optionalNext: null, hints: [], sources: [], catalog: false,
    };
  }
  const hostKey = CATALOG_HOSTS.has(facts.dnsHost.id) ? (facts.dnsHost.id as 'cloudflare') : 'generic';
  const records: FixRecord[] = [];
  let exact = entry.exact;
  for (const r of entry.records) {
    const value = fillText(r.value, values);
    const name = fillText(r.name, values);
    if (UNFILLED.test(value)) { exact = false; continue; } // a value we could not derive from the observed records: no record to show
    if (PLACEHOLDER.test(value)) exact = false; // a <placeholder> the customer fills in: shown, but not exact
    records.push({ name, host: relName(name, facts.domain), type: r.type, value, note: fillText(r.note, values) });
  }
  const meta = hosts.hosts[hostKey];
  const detected = new Set([...facts.senderProviders, ...facts.mailboxProviders].map(p => p.id));
  return {
    ...base, title: fillText(entry.title, values), why: fillText(entry.why, values), records,
    steps: expandSteps(entry.steps, records, hostKey, hosts, values),
    exact: exact && records.length > 0, dnsHostLabel: meta.label,
    needsFromProvider: entry.needs_from_provider ?? [], caveat: entry.caveat ?? null,
    optionalNext: entry.optional_next === undefined ? null : fillText(entry.optional_next, values),
    hints: Object.entries(entry.provider_hints ?? {}).filter(([pid]) => detected.has(pid)).map(([, t]) => t),
    sources: [...entry.sources, ...meta.sources], catalog: true,
  };
}
