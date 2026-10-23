-- Inbox Angel baseline schema (history squashed before the first release).
-- Future schema changes are new numbered files in this directory; see packages/db/SCHEMA.md.

CREATE TABLE domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,             -- e.g. "company.com"
  rua_address TEXT NOT NULL,               -- e.g. "abc123@reports.inboxangel.com"
  -- Current DMARC policy (refreshed on each report ingestion)
  dmarc_policy TEXT,                       -- none | quarantine | reject
  dmarc_pct INTEGER,                       -- 0-100
  spf_record TEXT,                         -- raw SPF record
  -- Authorization record provisioned in Cloudflare DNS
  auth_record_provisioned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  dns_record_id TEXT,
  rollout_rec_policy TEXT,
  rollout_rec_pct INTEGER,
  parent_id INTEGER REFERENCES domains(id) ON DELETE SET NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  alerts_enabled INTEGER NOT NULL DEFAULT 1,
  spf_lookup_count INTEGER,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  cf_connection_id TEXT REFERENCES cloudflare_connections(id) ON DELETE SET NULL
);

CREATE INDEX idx_domains_domain ON domains(domain);

CREATE TABLE check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_email TEXT NOT NULL,             -- who sent the check email
  from_domain TEXT NOT NULL,            -- extracted domain
  -- SPF
  spf_result TEXT,                      -- pass | fail | softfail | neutral | none | permerror | temperror
  spf_domain TEXT,                      -- domain that was checked
  spf_record TEXT,                      -- raw TXT record found
  -- DKIM
  dkim_result TEXT,                     -- pass | fail | none
  dkim_domain TEXT,                     -- signing domain (d= tag)
  -- DMARC
  dmarc_result TEXT,                    -- pass | fail | none
  dmarc_policy TEXT,                    -- none | quarantine | reject
  dmarc_record TEXT,                    -- raw TXT record found
  -- Overall
  overall_status TEXT NOT NULL,         -- protected | at_risk | exposed
  report_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  session_token TEXT,
  spf_lookup_count INTEGER
);

CREATE INDEX idx_check_results_domain ON check_results(from_domain);

CREATE TABLE aggregate_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  -- Report metadata (from <report_metadata>)
  org_name TEXT NOT NULL,               -- reporting org (e.g. "Google Inc.")
  report_id TEXT NOT NULL,
  date_begin INTEGER NOT NULL,          -- unix timestamp
  date_end INTEGER NOT NULL,
  -- Summary
  total_count INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  -- Raw XML stored for reprocessing
  raw_xml TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  UNIQUE(domain_id, report_id)          -- deduplicate re-deliveries
);

CREATE INDEX idx_agg_reports_domain ON aggregate_reports(domain_id);

CREATE INDEX idx_agg_reports_date ON aggregate_reports(date_begin);

CREATE TABLE report_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES aggregate_reports(id) ON DELETE CASCADE,
  -- Source
  source_ip TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,     -- message count from this IP
  -- Policy evaluated
  disposition TEXT NOT NULL,            -- none | quarantine | reject
  -- DKIM
  dkim_result TEXT,                     -- pass | fail
  dkim_domain TEXT,
  -- SPF
  spf_result TEXT,                      -- pass | fail
  spf_domain TEXT,
  -- Header from (the domain in From: header)
  header_from TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  reverse_dns TEXT,
  base_domain TEXT,
  country_code TEXT,
  org TEXT,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default'
);

CREATE INDEX idx_records_report ON report_records(report_id);

CREATE INDEX idx_records_ip ON report_records(source_ip);

CREATE INDEX idx_check_results_token ON check_results(session_token);

CREATE INDEX idx_domains_parent ON domains(parent_id);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  session_token TEXT,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_users_email ON users(email);

CREATE INDEX idx_users_session ON users(session_token);

CREATE TABLE invites (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default'
);

CREATE TABLE password_reset_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX idx_prt_user ON password_reset_tokens(user_id);

CREATE TABLE ip_info (
  ip TEXT PRIMARY KEY,
  reverse_dns TEXT,
  base_domain TEXT,
  country_code TEXT,
  org TEXT,
  asn TEXT,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE spf_flatten_config (
  domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  cf_record_id TEXT,
  canonical_record TEXT NOT NULL,
  flattened_record TEXT,
  ip_count INTEGER,
  lookup_count INTEGER,
  last_flattened_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  workspace_id TEXT NOT NULL DEFAULT 'ws_default'
);

CREATE TABLE mta_sts_config (
  domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'testing',
  mx_hosts TEXT NOT NULL DEFAULT '[]',
  max_age INTEGER NOT NULL DEFAULT 86400,
  policy_id TEXT NOT NULL,
  mta_sts_record_id TEXT,
  tls_rpt_record_id TEXT,
  cname_record_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  workspace_id TEXT NOT NULL DEFAULT 'ws_default'
);

CREATE TABLE tls_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  org_name TEXT NOT NULL,
  date_begin INTEGER NOT NULL,
  date_end INTEGER NOT NULL,
  total_success INTEGER NOT NULL DEFAULT 0,
  total_failure INTEGER NOT NULL DEFAULT 0,
  failure_details TEXT,
  raw_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  UNIQUE(domain_id, org_name, date_begin)
);

CREATE INDEX idx_tls_reports_domain ON tls_reports(domain_id, date_begin);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_email TEXT,
  actor_type TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  resource_name TEXT,
  before_value TEXT,
  after_value TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  workspace_id TEXT NOT NULL DEFAULT 'ws_default'
);

CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

CREATE INDEX idx_audit_actor ON audit_log(actor_id);

CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'member'))
);

CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE settings (
  workspace_id TEXT NOT NULL DEFAULT 'ws_default' REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, key)
);

-- A reports domain belongs to one workspace: inbound mail is routed by it.
CREATE UNIQUE INDEX idx_settings_reports_domain ON settings(value) WHERE key = 'reports_domain' AND value <> '';

CREATE TABLE monitor_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  domain TEXT NOT NULL,
  session_token TEXT,
  spf_record TEXT,
  dmarc_policy TEXT,
  dmarc_pct INTEGER,
  dmarc_record TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  workspace_id TEXT NOT NULL DEFAULT 'ws_default' REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, email, domain)
);

CREATE INDEX idx_monitor_active ON monitor_subscriptions(active, last_checked_at);

CREATE INDEX idx_monitor_domain ON monitor_subscriptions(domain);

CREATE UNIQUE INDEX idx_domains_is_default ON domains(workspace_id) WHERE is_default = 1;

CREATE INDEX idx_domains_workspace ON domains(workspace_id);

CREATE INDEX idx_agg_reports_workspace ON aggregate_reports(workspace_id, date_begin);

CREATE INDEX idx_records_workspace ON report_records(workspace_id);

CREATE INDEX idx_tls_reports_workspace ON tls_reports(workspace_id);

CREATE INDEX idx_spf_flatten_workspace ON spf_flatten_config(workspace_id);

CREATE INDEX idx_mta_sts_workspace ON mta_sts_config(workspace_id);

CREATE INDEX idx_invites_workspace ON invites(workspace_id);

CREATE INDEX idx_audit_workspace ON audit_log(workspace_id, created_at DESC);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE auth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_auth_accounts_user ON auth_accounts(user_id);

CREATE UNIQUE INDEX idx_auth_accounts_provider ON auth_accounts(provider_id, provider_account_id);

CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_verifications_identifier ON verifications(identifier);

CREATE TABLE auth_rate_limits (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_api_keys_workspace ON api_keys(workspace_id);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);

CREATE TABLE intake_tokens (
  domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  prev_token_hash TEXT,
  prev_expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  rotated_at INTEGER
);

CREATE INDEX idx_intake_tokens_workspace ON intake_tokens(workspace_id);

CREATE INDEX idx_intake_tokens_prev ON intake_tokens(prev_token_hash);

CREATE TABLE hosted_domains (
  domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hosted_id TEXT NOT NULL UNIQUE,
  zone_key TEXT NOT NULL,
  dmarc_record_id TEXT,
  spf_record_id TEXT,
  mta_sts_txt_record_id TEXT,
  mta_sts_host_record_id TEXT,
  tls_rpt_record_id TEXT,
  spf_source TEXT,
  dmarc_pointer TEXT,
  spf_pointer TEXT,
  mta_sts_pointer TEXT,
  tls_rpt_pointer TEXT,
  pointers_checked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_hosted_domains_workspace ON hosted_domains(workspace_id);

CREATE TABLE hosted_zones (
  zone_key TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  rest_digest TEXT,
  checked_at INTEGER
);

CREATE TABLE canary_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX idx_canary_tokens_expires ON canary_tokens(expires_at);

CREATE TABLE cloudflare_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  cf_account_id TEXT,
  cf_account_name TEXT,
  auth_type TEXT NOT NULL,
  token_envelope TEXT NOT NULL,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  status_detail TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  CONSTRAINT cf_connections_auth_type_check CHECK (auth_type IN ('oauth', 'token')),
  CONSTRAINT cf_connections_status_check CHECK (status IN ('active', 'broken', 'revoked'))
);

CREATE INDEX idx_cf_connections_workspace ON cloudflare_connections(workspace_id);

CREATE TABLE cloudflare_connection_zones (
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  cf_account_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (connection_id, zone_id)
);

CREATE INDEX idx_cf_connection_zones_workspace ON cloudflare_connection_zones(workspace_id);

CREATE TABLE cloudflare_connection_blocked_zones (
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (connection_id, zone_id)
);

CREATE INDEX idx_cf_connection_blocked_workspace ON cloudflare_connection_blocked_zones(workspace_id);

CREATE INDEX idx_domains_cf_connection ON domains(cf_connection_id);

-- The implicit workspace: self-host mode and the first signup land here.
INSERT INTO workspaces (id, name) VALUES ('ws_default', 'Default');
