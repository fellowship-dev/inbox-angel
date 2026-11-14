// DMARC aggregate report types — ported from parsedmarc/types.py

export type AlignmentMode = 'r' | 's'; // relaxed | strict
export type DmarcResult = 'pass' | 'fail';
export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'permerror' | 'temperror';
export type DkimResult = 'pass' | 'fail' | 'policy' | 'neutral' | 'none' | 'temperror' | 'permerror';
export type Disposition = 'none' | 'quarantine' | 'reject';

export interface ReportMetadata {
  org_name: string;
  org_email: string;
  org_extra_contact_info: string | null;
  report_id: string;
  begin_date: string;         // ISO-8601 UTC
  end_date: string;           // ISO-8601 UTC
  errors: string[];
}

export interface PolicyPublished {
  domain: string;
  adkim: AlignmentMode;
  aspf: AlignmentMode;
  p: Disposition;
  sp: Disposition;
  pct: number;
  fo: string;
}

export interface PolicyOverrideReason {
  type: string;
  comment: string | null;
}

export interface PolicyEvaluated {
  disposition: Disposition;
  dkim: DmarcResult;
  spf: DmarcResult;
  policy_override_reasons: PolicyOverrideReason[];
}

export interface Alignment {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
}

export interface DkimAuthResult {
  domain: string;
  selector: string;
  result: DkimResult;
}

export interface SpfAuthResult {
  domain: string;
  scope: string;
  result: SpfResult;
}

export interface AuthResults {
  dkim: DkimAuthResult[];
  spf: SpfAuthResult[];
}

export interface Identifiers {
  header_from: string;
  envelope_from: string | null;
  envelope_to: string | null;
}

// IP enrichment — reverse DNS + ASN/org/country via free DNS services
export interface IpInfo {
  ip: string;
  reverse_dns: string | null;
  base_domain: string | null;
  country_code: string | null;
  country_name: string | null; // not populated (no geo DB) — kept for compat
  subdivision: string | null;  // not populated
  city: string | null;         // not populated
  org: string | null;          // e.g. "GOOGLE", "AMAZON-02"
  asn: string | null;          // e.g. "15169"
}

export interface ReportRecord {
  source: IpInfo;
  count: number;
  alignment: Alignment;
  policy_evaluated: PolicyEvaluated;
  identifiers: Identifiers;
  auth_results: AuthResults;
}

export interface AggregateReport {
  xml_schema: string;
  report_metadata: ReportMetadata;
  policy_published: PolicyPublished;
  records: ReportRecord[];
}

export class InvalidAggregateReport extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAggregateReport';
  }
}

/** A report refused for a specific, reportable reason (src/hosted/reasons.ts): the sender is told which, and it is never retried. */
export class ReportRejected extends InvalidAggregateReport {
  constructor(readonly code: 'xml_invalid' | 'too_many_records' | 'field_too_long' | 'date_range_invalid', message: string) {
    super(message);
    this.name = 'ReportRejected';
  }
}

/** Thrown from the parse gate to end processing of a report that is understood but must not be stored (a duplicate, an over-cap report). */
export class ParseStop extends Error {
  constructor(readonly outcome: 'duplicate' | 'refused', readonly code: string, message = code) {
    super(message);
    this.name = 'ParseStop';
  }
}
