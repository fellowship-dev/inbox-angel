-- Hosted report intake hardening (G4 atomic storage, G5 proven reports, G6 caps and counters, G7 failure markers).
-- Additive only: nullable or defaulted columns, new tables, new indexes. Existing rows keep working unchanged.
--
-- aggregate_reports.ingest_token          random id of the storing attempt. The records of a report are inserted in the same
--                                         db.batch() as the report row, joined on this token, so a re-delivery (different token)
--                                         inserts no records and a failed batch leaves nothing behind. NULL: stored before 0011.
-- aggregate_reports.record_count          rows stored in report_records for this report. NULL: stored before 0011.
-- aggregate_reports.reporter_auth_reason  why reporter_auth is not 'pass' (a reason code), or NULL.
-- aggregate_reports.reporter_tier         what the intake decided about the sender: 'counted' (authenticated AND a known reporter),
--                                         'unknown' (authenticated, not a known reporter: stored, not counted) or 'unauthenticated'
--                                         (stored only where an operator chose to keep such mail, e.g. self-host). NULL: stored before 0011.
--                                         reporter_auth_domain is the AUTHENTICATED sending domain (never the report's own org_name/email).
-- aggregate_reports.reporter_known_as     the organisation name of the known-reporters entry that matched ('Google'), for 'counted'.
--
-- intake_quota        counters per scope and UTC day: 'a:<domain_id>' (one report address), 'k:<domain_id>' (all mail from unknown
--                     reporters to one address), 'w:<workspace_id>', '*' (the whole instance). Not tenant data: a counter, no content.
-- workspace_storage   report_records rows a workspace holds right now (the storage cap compares against it), kept in step by the
--                     store batch and the retention sweep, recounted by the daily job.
-- intake_unknown_reporters  authenticated sending domains that are not known reporters, instance-wide: how many reports, first and last
--                     seen. A list for the instance owner so the known-reporters list can grow; no report content, no customer.
-- intake_failures     mail that reached a report address and was not stored, counted per domain, UTC day and reason. This is what the
--                     owner sees as "N reports could not be processed"; one row per (domain, day, reason), never one per message.
ALTER TABLE aggregate_reports ADD COLUMN ingest_token TEXT;
ALTER TABLE aggregate_reports ADD COLUMN record_count INTEGER;
ALTER TABLE aggregate_reports ADD COLUMN reporter_auth_reason TEXT;
ALTER TABLE aggregate_reports ADD COLUMN reporter_tier TEXT;
ALTER TABLE aggregate_reports ADD COLUMN reporter_known_as TEXT;

CREATE TABLE intake_quota (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);

CREATE TABLE workspace_storage (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reports INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  reconciled_at INTEGER
);

CREATE TABLE intake_failures (
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  reason TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (domain_id, day, reason)
);

CREATE INDEX idx_intake_usage_day ON intake_usage(day);
CREATE INDEX idx_intake_quota_day ON intake_quota(day);
CREATE INDEX idx_intake_failures_day ON intake_failures(day);
CREATE INDEX idx_agg_reports_tier ON aggregate_reports(workspace_id, reporter_tier, date_begin);

CREATE TABLE intake_unknown_reporters (
  reporter TEXT PRIMARY KEY NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
