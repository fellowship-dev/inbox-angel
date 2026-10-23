-- Trust hardening: domain ownership claims, reporter authentication, intake usage.
-- Self-contained: additive only (new table/columns), so the previous Worker keeps running during the migrate.

-- A domain a workspace has asked to monitor but not yet proven it controls. `domains` only ever holds verified
-- domains (so its global UNIQUE(domain) means "first to verify wins"); everything downstream of `domains`
-- (reports, stats, DNS writes, hosted records, check results) therefore never sees a pending claim.
CREATE TABLE domain_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  token TEXT NOT NULL,                         -- value of the TXT record _inboxangel.<domain>
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | lost (another workspace verified it first)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_checked_at INTEGER,
  last_error TEXT,
  UNIQUE (workspace_id, domain),
  CONSTRAINT domain_claims_status_check CHECK (status IN ('pending', 'lost'))
);

CREATE INDEX idx_domain_claims_domain ON domain_claims(domain);

-- How a verified domain was proven: selfhost | cloudflare | txt | parent | legacy (rows from before this migration).
ALTER TABLE domains ADD COLUMN verified_via TEXT NOT NULL DEFAULT 'legacy';

-- Whether the report email itself passed DMARC-aligned authentication for the reporter's organisation domain.
-- pass | fail | none. NULL: not recorded (reports from before this migration, or self-host intake without the header).
ALTER TABLE aggregate_reports ADD COLUMN reporter_auth TEXT;
ALTER TABLE aggregate_reports ADD COLUMN reporter_auth_domain TEXT;

-- Per-token (per-domain) intake accounting, one row per UTC day.
CREATE TABLE intake_usage (
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                           -- YYYY-MM-DD (UTC)
  reporter TEXT NOT NULL DEFAULT '',           -- authenticated reporter org domain; '' = the shared unauthenticated bucket
  reports INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain_id, day, reporter)
);

-- Self-host has no outbound verification mail to rely on: everyone already on the implicit workspace counts as verified,
-- so Google/GitHub sign-in can link to their account. (Hosted users live in workspaces of their own and must verify.)
UPDATE users SET email_verified = 1
  WHERE email_verified = 0 AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.workspace_id = 'ws_default');
