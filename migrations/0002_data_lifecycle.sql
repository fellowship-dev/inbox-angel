-- Data lifecycle: retention indexes, and the tombstones that let a Cloudflare revocation be retried
-- after the workspace that owned the connection is gone.

-- A remote revoke that failed while a workspace was being deleted. The sealed token is kept (still
-- encrypted, bound to the workspace and connection by its AAD) only so the daily cron can retry
-- revoking the grant; the row is deleted on success, or after too many attempts.
CREATE TABLE revocation_tombstones (
  id TEXT PRIMARY KEY,
  deleted_workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  cf_account_id TEXT,
  token_envelope TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_revocation_tombstones_created ON revocation_tombstones(created_at);

-- The retention job scans these by age once a day.
CREATE INDEX idx_agg_reports_date_end ON aggregate_reports(date_end);
CREATE INDEX idx_agg_reports_raw_xml ON aggregate_reports(created_at) WHERE raw_xml IS NOT NULL;
CREATE INDEX idx_tls_reports_date_end ON tls_reports(date_end);
CREATE INDEX idx_tls_reports_raw_json ON tls_reports(created_at) WHERE raw_json IS NOT NULL;
CREATE INDEX idx_ip_info_fetched ON ip_info(fetched_at);
CREATE INDEX idx_check_results_created ON check_results(created_at);
CREATE INDEX idx_invites_expires ON invites(expires_at);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
