import type { ReportVisibilityFields } from './uncounted';
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

export interface DomainStats extends ReportVisibilityFields {
  domain: string;
  days: number;
  stats: DailyStat[];
}

/** A domain someone asked to monitor but has not proven they own (SaaS). `lost`: another workspace verified it first. */
export interface DomainClaim {
  id: number | string;
  domain: string;
  status: 'pending' | 'lost';
  txt_name: string;
  txt_value: string;
  created_at: number;
  last_checked_at: number | null;
  last_error: string | null;
}

/** POST /api/domains answers 202 with this when ownership still has to be proven. */
export interface PendingDomainResult {
  pending: true;
  claim: DomainClaim;
  domain: null;
}

export interface AddDomainResult {
  domain: Domain;
  rua_hint: string;
  manual_dns?: boolean;
  dns_instructions?: string;
  parent_context?: ParentContext;
  /** The workspace already had the domain (a repeat verify or add): nothing new was verified. */
  resumed?: boolean;
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
  /** Did the report email itself pass DMARC-aligned auth? null = reported before this was recorded. */
  reporter_auth?: 'pass' | 'fail' | 'none' | null;
  reporter_auth_domain?: string | null;
  /** Why the sender was not authenticated (a reason code), or null. */
  reporter_auth_reason?: string | null;
  /** What the intake decided: counted (authenticated and known), unknown (authenticated, not known), unauthenticated. Null: stored before senders were checked. */
  reporter_tier?: 'counted' | 'unknown' | 'unauthenticated' | null;
  /** The known-reporters organisation that matched. */
  reporter_known_as?: string | null;
  /** Does this report feed the numbers (REPORT_COUNTING)? Absent on older servers. */
  counted?: boolean;
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
    // No rua_address here: the API sends it once, at the top level, and it is empty without a reports domain.
    auth_record?: {
      found: boolean;
      record_name: string | null;
    };
    /**
     * The policy that applies (RFC 7489): the domain's own record, else its organizational domain's (`inherited_from`).
     * Null when DNS could not say; absent from older servers. Never offer a record weaker than this policy.
     */
    effective?: { policy: string | null; inherited_from: string | null; issue: string | null; /** The inherited record's text (its pct= matters), null when not inherited. */ record?: string | null } | null;
  };
  /** DNS said the name itself does not exist (NXDOMAIN). */
  nxdomain?: boolean;
  spf: {
    record: string | null;
    lookup_count: number | null;
    flattening_active: boolean;
  };
  dkim: {
    selectors: { name: string; record: string }[];
    source: 'cf' | 'doh';
    /** Every name under _domainkey answers with the same TXT record: `selectors` is empty because public DNS cannot say which exist. */
    wildcard?: boolean;
    wildcard_record?: string;
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
  /** Checks whose DNS lookup failed ("spf: …", "dmarc: …", "mx: …", "dkim <selector>: …"). Their values are unknown, not absent. */
  dns_errors?: string[];
}

export interface DomainCheckSummary extends ReportVisibilityFields {
  domain_id: number;
  domain: string;
  dmarc_policy: string | null;
  spf_record: string | null;
  /** Unix seconds both records were last read from DNS; null: never. */
  dns_checked_at: number | null;
  /** Unix seconds of the last attempt, and its result: 'ok' | 'failed' | 'nxdomain'. Null: never attempted. */
  dns_check_attempted_at: number | null;
  dns_check_status: string | null;
  /** Why DMARC gave no usable policy: 'multiple' | 'invalid'. */
  dmarc_issue: string | null;
  /** The organizational domain dmarc_policy was inherited from (the domain has no record of its own). */
  dmarc_inherited_from: string | null;
  /** Status of the last check that read both records: 'ok' | 'nxdomain'. Unlike dns_check_status it survives a failed attempt. */
  dns_last_good_status: string | null;
  total_messages: number;
  pass_messages: number;
  fail_messages: number;
  dkim_total: number;
  dkim_pass: number;
  spf_total: number;
  spf_pass: number;
  mta_sts_enabled: number; // 0 | 1
  mta_sts_mode: string | null;
  /** SPF DNS lookups at the last refresh; null: not counted. */
  spf_lookup_count?: number | null;
  /** pct= and sp= of the DMARC record that applies, from the last read (0012). Null or absent: not read yet. */
  dmarc_pct?: number | null;
  dmarc_sp?: string | null;
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
  /** Null (with `workspace_id` null) for a verified login that belongs to no workspace yet. */
  role: Role | null;
  workspace_id: string | null;
  kind: 'instance' | 'api_key' | 'session';
  /** Set (with `workspace_id: null`) for a verified login that belongs to no workspace yet: the invitations waiting for its email. */
  pending_invites?: Array<{ token: string; role: string; invited_by: string; workspace_id: string; workspace_name: string | null }>;
  /** Runs this instance (OWNER_EMAIL, or the self-host owner): sees the leads page. */
  instance_owner?: boolean;
}

/** GET /api/leads (instance owner only) */
export interface LeadRow {
  id: number;
  email: string;
  domain: string;
  source: string;
  level: 'protected' | 'at_risk' | 'exposed' | null;
  step: number;
  steps_total: number;
  status: 'active' | 'completed' | 'unsubscribed' | 'bounced' | 'replied' | 'booked' | 'converted';
  next_send_at: number | null;
  last_sent_at: number | null;
  created_at: number;
  last_activity_at: number;
}

export interface LeadsResponse {
  leads: LeadRow[];
  counts: Record<string, number>;
  delivery: { enabled: boolean; can_send: boolean; provider: string | null; blockers: string[]; warnings: string[] };
}

/** GET /api/auth/status (public) */
export interface AuthStatus {
  configured: boolean;
  mode: 'self-host' | 'saas';
  /** Self-host only, present when HOSTED_SERVICE_URL is set: the hosted free tier's https URL. */
  hosted_service_url?: string;
  signup_open: boolean;
  /** False when the instance cannot sign anybody in (hosted without bot protection); `signup_unavailable_reason` says why, for sign-up and sign-in alike. */
  signin_available: boolean;
  signup_unavailable_reason?: 'bot_protection_not_configured';
  oauth_providers: string[];
  prefill: { name: string; email: string };
  telemetry_default: boolean;
  turnstile_site_key: string | null;
  custom_domain: string | null;
  base_domain: string | null;
  has_domain: boolean;
  /** Hosted only: the https booking link behind "Talk to Max". Null (or absent) = show no link anywhere. */
  help_url?: string | null;
  /** False when the free email check cannot work here (hosted without a canary domain): its menu item is hidden. */
  email_check?: boolean;
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

/** GET /api/agents/status: can agents connect to this instance, and at which MCP server URL. */
export interface AgentStatus {
  available: boolean;
  server_url: string | null;
}

/** GET /api/instance/preflight (instance owner only): configuration problems by setting name, never a value. */
export interface PreflightItem {
  id: 'mode' | 'auth_url' | 'oauth_storage' | 'booking_link' | 'mail_sender' | 'bot_check' | 'client_registration' | 'rate_limits';
  severity: 'action' | 'note';
  setting: string;
  message: string;
}
export interface Preflight {
  mode: 'self-host' | 'saas';
  agents: AgentStatus;
  items: PreflightItem[];
}
