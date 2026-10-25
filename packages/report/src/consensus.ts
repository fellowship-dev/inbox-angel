// Finding consensus across checkDomain() runs against different DoH resolvers (KTD3).
//
// Per finding id: confirmed when at least two runs produce it and no run whose lookup for that record completed
// contradicts it; a run whose lookup errored counts as neither side. No run producing it, with at least two completed
// lookups, is a confirmed absence. Everything else is unconfirmed: shown as such, never stated as fact.

import type { DomainReport } from '@inbox-angel/dns-checks';
import { build, type Finding } from './findings';

type Check = DomainReport['errors'][number]['check'];

export type ConsensusStatus = 'confirmed' | 'unconfirmed' | 'absent';

export interface ConsensusResult {
  id: string;
  status: ConsensusStatus;
  /** Runs that produced the finding. */
  produced: number;
  /** Runs whose lookup completed and did not produce it. */
  contradicted: number;
  /** Runs whose lookup for this record errored and did not produce it: neither side. */
  errored: number;
  /** The finding as the first producing run saw it, redacted; absent when no run produced it. */
  finding?: Finding;
}

/** The checks each finding's verdict rests on. */
function checksFor(id: string): Check[] {
  if (id === 'dkim-not-found-for-sender') return ['dkim', 'spf'];
  if (id === 'mta-sts-missing') return ['mta-sts', 'mx'];
  if (id.startsWith('bimi-blocked-by-dmarc')) return ['dmarc', 'mx'];
  if (id.startsWith('bimi-')) return ['bimi', 'mx'];
  if (id.startsWith('dmarc-')) return ['dmarc'];
  if (id.startsWith('spf-') || id === 'multiple-spf') return ['spf'];
  return ['mx', 'spf', 'dmarc', 'dkim', 'mta-sts', 'bimi'];
}

/** Whether this run could have produced or ruled out the finding. */
function lookupCompleted(r: DomainReport, id: string): boolean {
  const deps = checksFor(id);
  if (r.errors.some(e => deps.includes(e.check))) return false;
  // a BIMI asset that could not be fetched says nothing about it
  if (id === 'bimi-logo-invalid' && r.bimi.logo.status === 'unreachable') return false;
  if (id === 'bimi-no-certificate' && r.bimi.vmc.status === 'unreachable') return false;
  return true;
}

/**
 * Combine up to three runs of the same domain. Covers every id any run produced plus `ids` (e.g. the findings a
 * follow-up re-checks), in first-seen order.
 */
export function consensus(runs: readonly DomainReport[], checkedAt: string, ids: readonly string[] = []): ConsensusResult[] {
  const perRun = runs.map(r => ({ report: r, findings: build(r, checkedAt).findings }));
  const order: string[] = [];
  for (const { findings } of perRun) for (const f of findings) if (!order.includes(f.id)) order.push(f.id);
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return order.map(id => {
    let produced = 0, contradicted = 0, errored = 0;
    let finding: Finding | undefined;
    for (const { report, findings } of perRun) {
      const hit = findings.find(f => f.id === id);
      if (hit) { produced++; finding ??= hit; }
      else if (lookupCompleted(report, id)) contradicted++;
      else errored++;
    }
    const status: ConsensusStatus = produced >= 2 && contradicted === 0 ? 'confirmed'
      : produced === 0 && contradicted >= 2 ? 'absent' : 'unconfirmed';
    return { id, status, produced, contradicted, errored, ...(finding ? { finding } : {}) };
  });
}
