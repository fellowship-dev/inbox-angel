-- Migration 0007: tables that used to be created at runtime by ensureMigrated()
-- (src/db/migrate.ts, versions 5-8, 10, 12, 14-16). Now owned by this migration
-- history. Every statement is IF NOT EXISTS, so it is a no-op on installs where
-- the Worker already created them.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  session_token TEXT,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_token);

CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id);

CREATE TABLE IF NOT EXISTS ip_info (
  ip TEXT PRIMARY KEY,
  reverse_dns TEXT,
  base_domain TEXT,
  country_code TEXT,
  org TEXT,
  asn TEXT,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS spf_flatten_config (
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
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS mta_sts_config (
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
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tls_reports (
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
  UNIQUE(domain_id, org_name, date_begin)
);
CREATE INDEX IF NOT EXISTS idx_tls_reports_domain ON tls_reports(domain_id, date_begin);

CREATE TABLE IF NOT EXISTS audit_log (
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
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id);
