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

/** Dates describe report-start buckets, not proof that all mail or every interval was observed. */
export interface EvidenceProvenance {
  report_count: number;
  truncated: boolean;
  observations: Array<{
    id: number;
    source_report_id: string | null;
    reporter: string;
    date_begin: number;
    date_end: number;
    received_at: number;
    receipt_age_seconds: number;
    total_count: number;
    pass_count: number;
    fail_count: number;
  }>;
  coverage: {
    date_basis: 'report-start-utc';
    observed_dates: string[];
    missing_dates: string[];
    complete_mail_population: false;
  };
  freshness: {
    latest_period_end: number | null;
    latest_received_at: number | null;
    period_end_age_seconds: number | null;
    receipt_age_seconds: number | null;
  };
}
