import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainReport } from './checker.ts';

export function parseJsonl<T>(text: string): T[] {
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
}

/** Merge reports from several shards: last write wins per domain, stable order by domain. */
export function mergeReports(lists: DomainReport[][]): DomainReport[] {
  const byDomain = new Map<string, DomainReport>();
  for (const list of lists) for (const r of list) {
    const prev = byDomain.get(r.domain);
    // Prefer a clean result over an errored one, otherwise the later check.
    const keepPrev = prev && prev.errors.length === 0 && r.errors.length > 0;
    if (!keepPrev) byDomain.set(r.domain, r);
  }
  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

export function readJsonlFile(path: string): DomainReport[] {
  return existsSync(path) ? parseJsonl<DomainReport>(readFileSync(path, 'utf8')) : [];
}

export function shardResultFiles(dir: string): string[] {
  return readdirSync(dir).filter(f => /^results\.\d+of\d+\.jsonl$/.test(f)).sort().map(f => join(dir, f));
}
