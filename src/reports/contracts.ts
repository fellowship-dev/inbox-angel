import type { ReportModel } from '@inbox-angel/report';
import type { getAnalytics } from './analytics';

export interface EvidenceWindow { since: number; until: number }
export interface EvidenceSection<T> {
  status: 'available' | 'unavailable' | 'error';
  reason?: string;
  source: string;
  window: EvidenceWindow;
  population: string;
  data: T | null;
}
export type DomainAnalytics = Awaited<ReturnType<typeof getAnalytics>>;
export interface Remediation {
  finding: string;
  observation: string[];
  impact: string;
  steps: string[];
  prerequisites: string[];
  changes: ReportModel['steps'];
  verification: string[];
}
