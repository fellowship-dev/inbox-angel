export interface ParentContext {
  domain: string;
  dmarc_policy: string | null;
  dmarc_sp: string | null;    // effective sp= (null if no DMARC)
  has_dmarc: boolean;
}

export interface Domain {
  id: number;
  domain: string;
  dmarc_policy: 'none' | 'quarantine' | 'reject' | null;
  rua_address: string;
  parent_id: number | null;   // non-null for subdomains
  created_at: number; // unix timestamp
  alerts_enabled: number; // 1 = on, 0 = off
  is_default: number; // 1 = this domain is the reports infrastructure hub
}

export interface DailyStat {
  day: string;
  total: number;
  passed: number;
  failed: number;
}

export interface DomainStats {
  domain: string;
  days: number;
  stats: DailyStat[];
}

export interface AddDomainResult {
  domain: Domain;
  rua_hint: string;
  manual_dns?: boolean;
  dns_instructions?: string;
  parent_context?: ParentContext;
}

export interface FailingSource {
  source_ip: string;
  total: number;
  header_from: string | null;
  base_domain: string | null;
  org: string | null;
}

export interface ReportSource {
  source_ip: string;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  count: number;
  spf_pass: number;
  dkim_pass: number;
  disposition: string;
  reporters: string;
  base_domain: string | null;
  org: string | null;
}

export interface AnomalySource {
  source_ip: string;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  total: number;
  spf_pass: number;
  dkim_pass: number;
  first_seen: string; // YYYY-MM-DD
  last_seen: string;  // YYYY-MM-DD
  base_domain: string | null;
  org: string | null;
}

export interface CheckResult {
  id: number;
  from_email: string;
  from_domain: string;
  spf_result: string | null;
  spf_domain: string | null;
  spf_record: string | null;
  dkim_result: string | null;
  dkim_domain: string | null;
  dmarc_result: string | null;
  dmarc_policy: string | null;
  dmarc_record: string | null;
  overall_status: 'protected' | 'at_risk' | 'exposed';
  session_token: string | null;
  spf_lookup_count: number | null;
  created_at: number;
}

export interface AggregateReport {
  id: number;
  domain: string;
  org_name: string;
  report_id: string;
  date_begin: number; // unix timestamp
  date_end: number;   // unix timestamp
  total_count: number;
  pass_count: number;
  fail_count: number;
}

export interface SpfFlatConfig {
  enabled: number;                 // 0 | 1
  cf_record_id: string | null;
  canonical_record: string;
  flattened_record: string | null;
  ip_count: number | null;
  lookup_count: number | null;
  last_flattened_at: number | null;
  last_error: string | null;
}

export interface SpfFlatStatus {
  available: boolean;
  config: SpfFlatConfig | null;
  lookup_count: number | null;  // from domains.spf_lookup_count — populated on add + daily cron
}

export interface MtaStsConfig {
  domain_id: number;
  enabled: number;
  mode: 'testing' | 'enforce';
  mx_hosts: string;       // comma-separated
  policy_id: string;
  mta_sts_record_id: string | null;
  tls_rpt_record_id: string | null;
  cname_record_id: string | null;
  last_error: string | null;
  updated_at: number;
}

export interface TlsReportSummary {
  total_success: number;
  total_failure: number;
  report_count: number;
}

export interface MtaStsStatus {
  available: boolean;
  config: MtaStsConfig | null;
  summary: TlsReportSummary | null;
}

export interface AuditLogEntry {
  id: number;
  actor_id: string | null;
  actor_email: string | null;
  actor_type: 'user' | 'system';
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_name: string | null;
  before_value: string | null;  // JSON string
  after_value: string | null;   // JSON string
  meta: string | null;          // JSON string
  created_at: number;           // unix timestamp
}

export interface DayReport {
  date: string;
  domain: string;
  summary: { total: number; passed: number; failed: number };
  sources: ReportSource[];
}


export interface OnboardingStatus {
  domain_id: number;
  domain: string;
  rua_address: string;
  cf_available: boolean;
  dmarc: {
    found: boolean;
    has_our_rua: boolean;
    current_record: string | null;
    rua_address: string;
    auth_record?: {
      found: boolean;
      record_name: string | null;
    };
  };
  spf: {
    record: string | null;
    lookup_count: number | null;
    flattening_active: boolean;
  };
  dkim: {
    selectors: { name: string; record: string }[];
    source: 'cf' | 'doh';
  };
  routing: {
    mx_found: boolean;
    destination_verified: boolean;
    destination_debug?: string;
    reports_domain: string | null;
    admin_email: string | null;
    null_sender_spf?: boolean;
    null_sender_dmarc?: boolean;
  };
}

export interface DomainCheckSummary {
  domain_id: number;
  domain: string;
  dmarc_policy: string | null;
  spf_record: string | null;
  total_messages: number;
  pass_messages: number;
  fail_messages: number;
  dkim_total: number;
  dkim_pass: number;
  spf_total: number;
  spf_pass: number;
  mta_sts_enabled: number; // 0 | 1
  mta_sts_mode: string | null;
}

export type WizardStepState = 'not_started' | 'complete' | 'skipped';

export interface WizardState {
  domain: WizardStepState;
  spf: WizardStepState;
  dkim: WizardStepState;
  dmarc: WizardStepState;
  routing: WizardStepState;
}

export type Role = 'owner' | 'admin' | 'member';

/** GET /api/me */
export interface Me {
  user: { id: string; email: string; name: string } | null;
  role: Role;
  account_id: string;
  kind: 'instance' | 'api_key' | 'session';
}

/** GET /api/auth/status (public) */
export interface AuthStatus {
  configured: boolean;
  mode: 'self-host' | 'saas';
  signup_open: boolean;
  oauth_providers: string[];
  prefill: { name: string; email: string };
  telemetry_default: boolean;
  turnstile_site_key: string | null;
  custom_domain: string | null;
  base_domain: string | null;
  has_domain: boolean;
}

/** GET /api/keys: prefixes only, never the secret. */
export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}
