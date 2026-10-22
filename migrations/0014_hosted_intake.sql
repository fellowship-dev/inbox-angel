-- Migration 0014: hosted (SaaS) intake. Additive only: self-host installs get empty tables.
--
--   intake_tokens   per-domain token behind rua+<token>@ / tls-rpt+<token>@ (SHA-256 only, rotatable)
--   hosted_domains  a domain's records in the operator's hosted-records zone + pointer verification
--   hosted_zones    record counts per hosted zone (quota warning, daily diff)
--   canary_tokens   expiring single-use addresses for the anonymous free check

CREATE TABLE intake_tokens (
  domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  prev_token_hash TEXT,
  prev_expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  rotated_at INTEGER
);
CREATE INDEX idx_intake_tokens_account ON intake_tokens(account_id);
CREATE INDEX idx_intake_tokens_prev ON intake_tokens(prev_token_hash);

CREATE TABLE hosted_domains (
  domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
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
CREATE INDEX idx_hosted_domains_account ON hosted_domains(account_id);

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
