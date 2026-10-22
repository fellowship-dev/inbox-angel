import { createHash } from 'node:crypto';

export interface RawSeed { domain: string; source: string; ref: string }
export interface Seed { domain: string; sources: string[] }

const h = (s: string) => createHash('sha1').update(s).digest('hex');

/** Refs that indicate a topical match for the audit (Resend / Supabase / auth / email stack). */
export const PRIORITY_REF = /^(kw:(resend|supabase|transactional email|magic link|auth)|resend|supabase)/i;
export const GITHUB_QUOTA = 500;

/**
 * Dedupe by domain (already registrable) and cap to `target`. Order of preference:
 * 1. domains seen by 2+ sources, or topical keyword hits;
 * 2. GitHub homepages up to GITHUB_QUOTA;
 * 3. remaining HN domains, alternating sources, in stable hash order (deterministic, no cherry-picking).
 */
export function selectSeeds(raw: RawSeed[], target: number): Seed[] {
  const by = new Map<string, { sources: Set<string>; priority: boolean }>();
  for (const r of raw) {
    const e = by.get(r.domain) ?? { sources: new Set<string>(), priority: false };
    e.sources.add(r.source);
    if (PRIORITY_REF.test(r.ref) || /resend|supabase/i.test(r.ref)) e.priority = true;
    by.set(r.domain, e);
  }
  const all = [...by].map(([domain, e]) => ({ domain, sources: [...e.sources].sort(), priority: e.priority }));
  all.sort((a, b) => h(a.domain).localeCompare(h(b.domain)));

  const chosen = new Map<string, Seed>();
  const take = (d: { domain: string; sources: string[] }) => { if (chosen.size < target && !chosen.has(d.domain)) chosen.set(d.domain, { domain: d.domain, sources: d.sources }); };

  all.filter(d => d.sources.length > 1 || d.priority).forEach(take);
  all.filter(d => d.sources.includes('github')).slice(0, Math.max(0, GITHUB_QUOTA - [...chosen.values()].filter(s => s.sources.includes('github')).length)).forEach(take);

  const rest = all.filter(d => !chosen.has(d.domain));
  const queues = ['hn-show', 'hn-workingon'].map(src => rest.filter(d => d.sources.includes(src)));
  for (let i = 0; chosen.size < target && queues.some(q => i < q.length); i++) for (const q of queues) if (q[i]) take(q[i]);
  // Anything left (other sources) fills the remainder.
  rest.forEach(take);

  return [...chosen.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

export function sourceMix(seeds: Seed[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const s of seeds) m[s.sources.join('+')] = (m[s.sources.join('+')] ?? 0) + 1;
  return m;
}
