-- Migration 0012: accounts, memberships, and account_id on every tenant-owned table.
--
-- Self-hosting = one implicit account ('acct_default'); every existing row is
-- backfilled into it. Hosted multi-tenancy (v2) adds more accounts later.
--
-- Requires the baseline produced by 0001-0011 (see packages/db/UPGRADING.md).
-- The guard below fails the whole migration with a readable message otherwise.

-- ── Guard ─────────────────────────────────────────────────────
CREATE TABLE _baseline_guard (
  baseline_ok INTEGER NOT NULL CHECK (baseline_ok = 1)  -- failing here means: run `npm run migrate`, not raw wrangler
);
INSERT INTO _baseline_guard (baseline_ok)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM pragma_table_info('domains') WHERE name IN ('dns_record_id','parent_id','rollout_rec_policy','rollout_rec_pct','is_default','alerts_enabled','spf_lookup_count')) = 7
  AND (SELECT COUNT(*) FROM pragma_table_info('report_records') WHERE name IN ('reverse_dns','base_domain','country_code','org')) = 4
  AND (SELECT COUNT(*) FROM pragma_table_info('check_results') WHERE name IN ('session_token','spf_lookup_count')) = 2
THEN 1 ELSE 0 END;
DROP TABLE _baseline_guard;

-- ── Accounts + memberships ────────────────────────────────────
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The implicit account. Fixed id so the backfill below needs no runtime code.
INSERT INTO accounts (id, name) VALUES ('acct_default', 'Default');

CREATE TABLE memberships (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, user_id),
  CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'member'))
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

-- Backfill: the earliest admin owns the account; other admins stay admins.
INSERT INTO memberships (account_id, user_id, role)
SELECT 'acct_default', u.id,
  CASE
    WHEN u.role = 'admin' AND u.id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, rowid LIMIT 1) THEN 'owner'
    WHEN u.role = 'admin' THEN 'admin'
    ELSE 'member'
  END
FROM users u;

-- ── account_id on tables that other tables cascade from ───────
-- ALTER ... ADD COLUMN with a constant default is metadata-only (no rewrite) and,
-- unlike a table rebuild, cannot trigger ON DELETE CASCADE on child rows.
-- (SQLite forbids REFERENCES on an added NOT NULL column, hence no FK here.)
ALTER TABLE domains ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_default';
ALTER TABLE aggregate_reports ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_default';
ALTER TABLE report_records ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_default';
ALTER TABLE tls_reports ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_default';
ALTER TABLE spf_flatten_config ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_default';
ALTER TABLE mta_sts_config ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_default';
ALTER TABLE invites ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_default';
ALTER TABLE audit_log ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_default';

-- ── Rebuild tables whose keys must become per-account ─────────
-- Nothing references these, so a rebuild is safe.

CREATE TABLE settings_new (
  account_id TEXT NOT NULL DEFAULT 'acct_default' REFERENCES accounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, key)
);
INSERT INTO settings_new (account_id, key, value, updated_at)
SELECT 'acct_default', key, value, updated_at FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

CREATE TABLE monitor_subscriptions_new (
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
  account_id TEXT NOT NULL DEFAULT 'acct_default' REFERENCES accounts(id) ON DELETE CASCADE,
  UNIQUE (account_id, email, domain)
);
INSERT INTO monitor_subscriptions_new
  (id, email, domain, session_token, spf_record, dmarc_policy, dmarc_pct, dmarc_record, active, last_checked_at, created_at, account_id)
SELECT id, email, domain, session_token, spf_record, dmarc_policy, dmarc_pct, dmarc_record, active, last_checked_at, created_at, 'acct_default'
FROM monitor_subscriptions;
DROP TABLE monitor_subscriptions;
ALTER TABLE monitor_subscriptions_new RENAME TO monitor_subscriptions;
CREATE INDEX idx_monitor_active ON monitor_subscriptions(active, last_checked_at);
CREATE INDEX idx_monitor_domain ON monitor_subscriptions(domain);

-- ── Indexes ───────────────────────────────────────────────────
-- One default domain per account (was: one per install).
DROP INDEX IF EXISTS idx_domains_is_default;
CREATE UNIQUE INDEX idx_domains_is_default ON domains(account_id) WHERE is_default = 1;
CREATE INDEX idx_domains_account ON domains(account_id);
CREATE INDEX idx_agg_reports_account ON aggregate_reports(account_id, date_begin);
CREATE INDEX idx_records_account ON report_records(account_id);
CREATE INDEX idx_tls_reports_account ON tls_reports(account_id);
CREATE INDEX idx_spf_flatten_account ON spf_flatten_config(account_id);
CREATE INDEX idx_mta_sts_account ON mta_sts_config(account_id);
CREATE INDEX idx_invites_account ON invites(account_id);
CREATE INDEX idx_audit_account ON audit_log(account_id, created_at DESC);
