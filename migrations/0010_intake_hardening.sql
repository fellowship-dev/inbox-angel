-- Hosted report intake hardening (G4 atomic storage, G5 proven reports, G6 caps and counters, G7 failure markers).
-- Additive only: nullable or defaulted columns, new tables, new indexes. Existing rows keep working unchanged.
--
-- aggregate_reports.ingest_token          random id of the storing attempt. The records of a report are inserted in the same
--                                         db.batch() as the report row, joined on this token, so a re-delivery (different token)
--                                         inserts no records and a failed batch leaves nothing behind. NULL: stored before 0010.
-- aggregate_reports.record_count          rows stored in report_records for this report. NULL: stored before 0010.
-- aggregate_reports.reporter_auth_reason  why reporter_auth is not 'pass' (a reason code), or NULL.
-- aggregate_reports.reporter_tier         what the intake decided about the sender: 'counted' (carrier authenticated AND a registry reporter),
--                                         'unknown' (authenticated, self-consistent, not in the registry: stored, not counted) or
--                                         'unauthenticated' (stored, not counted, 30-day retention). NULL: stored before 0010.
-- aggregate_reports.reporter_identity     who the intake took the sender to be: the registry id, else the authenticated organisational domain,
--                                         else '~unauth'. NULL: stored before 0010. When set, report_id holds '<identity>|<id from the report>' for
--                                         EVERY tier, counted included (the existing UNIQUE(domain_id, report_id) therefore dedups per reporter: two
--                                         known reporters may reuse one report id, a forger cannot squat a real reporter's id, and a counted report
--                                         supersedes an uncounted one with the same id). A plain report_id with identity NULL, or with the identity
--                                         set by an earlier build, is a legacy row: still recognised as a duplicate on redelivery.
-- aggregate_reports.reporter_known_as     the registry entry's label ('Google'), for 'counted'.--
-- intake_quota        counters per scope and UTC day: 'a:<domain_id>' (one report address), 'k:<domain_id>' (all mail from unknown
--                     reporters to one address), 'w:<workspace_id>', '*' (the whole instance). Not tenant data: a counter, no content.
-- workspace_storage   report_records rows a workspace holds right now, in two separate budgets: records/reports (COUNTED reports; NULL-tier legacy
--                     reports too) and uncounted_records/uncounted_reports (tier 'unknown' or 'unauthenticated', which have their own, much smaller
--                     cap so a stranger's reports can never use up the room a known reporter's report needs). Kept in step by the store batch and
--                     the retention sweep, recounted by the daily job. The instance totals are intake_quota rows ('*','total') and ('*u','total').
-- intake_drops        COUNTED reports that were accepted but not stored because the counted budget was full: one row per (domain, reporter) with the
--                     first drop time, so the owner reads "reports from Google since <time> were not stored". Cleared when a report from that
--                     reporter is stored again.
-- reporter_candidate_days  authenticated senders that are not in the registry, instance-wide, per day and workspace: DKIM organisation, From,
--                     the report's own org_name and email. The instance owner reads it as candidates for the registry (distinct workspaces,
--                     days seen, last seen). No report content, no customer address. Never promoted automatically.
-- intake_failures     mail that reached a report address and was not stored, counted per domain, UTC day and reason. This is what the
--                     owner sees as "N reports could not be processed"; one row per (domain, day, reason), never one per message.
ALTER TABLE aggregate_reports ADD COLUMN ingest_token TEXT;
ALTER TABLE aggregate_reports ADD COLUMN record_count INTEGER;
ALTER TABLE aggregate_reports ADD COLUMN reporter_auth_reason TEXT;
ALTER TABLE aggregate_reports ADD COLUMN reporter_tier TEXT;
ALTER TABLE aggregate_reports ADD COLUMN reporter_known_as TEXT;
ALTER TABLE aggregate_reports ADD COLUMN reporter_identity TEXT;

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
  uncounted_reports INTEGER NOT NULL DEFAULT 0,
  uncounted_records INTEGER NOT NULL DEFAULT 0,
  reconciled_at INTEGER
);

CREATE TABLE intake_drops (
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  reporter TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain_id, reporter)
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

CREATE TABLE reporter_candidate_days (
  dkim_org TEXT NOT NULL,
  from_address TEXT NOT NULL,
  report_email TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  org_name TEXT,
  PRIMARY KEY (dkim_org, from_address, report_email, workspace_id, day)
);
CREATE INDEX idx_reporter_candidate_days_day ON reporter_candidate_days(day);
