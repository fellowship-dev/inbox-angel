-- Email funnel: free-check leads, the onboarding sequence, the suppression list, and
-- double opt-in for POST /api/monitor.

-- A person who sent a free check and was enrolled in the onboarding sequence. Global (not a tenant's data).
-- `step` is the number of sequence emails already sent; `next_send_at` is when the next one is due.
-- Rows are deleted on unsubscribe (only the suppression hash stays) and 12 months after last activity.
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'free_check',
  check_level TEXT,
  check_summary TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_activity_at INTEGER NOT NULL DEFAULT (unixepoch()),
  step INTEGER NOT NULL DEFAULT 0,
  next_send_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  unsubscribed_at INTEGER,
  last_sent_at INTEGER
);

CREATE INDEX idx_leads_due ON leads(status, next_send_at);

CREATE INDEX idx_leads_activity ON leads(last_activity_at);

-- Addresses that must not receive non-transactional mail. Only a SHA-256 of the normalised address is kept.
CREATE TABLE suppression (
  email_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- NULL = the address owner has not confirmed (no alerts are sent, and the row is deleted after 7 days).
ALTER TABLE monitor_subscriptions ADD COLUMN confirmed_at INTEGER;

-- Subscriptions made from a signed-in dashboard (no check session) belong to an account holder.
UPDATE monitor_subscriptions SET confirmed_at = created_at WHERE session_token IS NULL;
