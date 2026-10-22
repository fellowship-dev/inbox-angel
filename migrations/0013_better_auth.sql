-- Migration 0013: Better Auth tables (sessions, credentials/OAuth links, verification tokens,
-- rate limits) and per-user API keys. Existing users and password hashes are carried over.
--
-- Password hashes keep their `saltHex:hashHex` PBKDF2 format; the Worker configures Better Auth
-- with the same hasher, so existing passwords verify unchanged (no rehash needed).
-- Sessions stored in users.session_token are NOT carried over: everyone signs in once more.
-- password_reset_tokens is left in place but unused; outstanding reset links stop working.

-- ── users: columns Better Auth expects ────────────────────────
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN image TEXT;
ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE users SET updated_at = created_at;

-- ── sessions ──────────────────────────────────────────────────
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

-- ── auth_accounts: one row per login method (credential password or OAuth provider) ──
-- Not to be confused with `accounts`, the tenant table.
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

-- Carry existing password logins over (Better Auth: providerId 'credential', provider account id = user id).
INSERT INTO auth_accounts (id, user_id, provider_account_id, provider_id, password, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, id, 'credential', password_hash, created_at, created_at
FROM users
WHERE password_hash IS NOT NULL AND password_hash != '';

-- ── verifications: password-reset and similar one-time tokens ─
CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_verifications_identifier ON verifications(identifier);

-- ── auth_rate_limits: Better Auth's D1-backed limiter (Workers isolates share no memory) ──
CREATE TABLE auth_rate_limits (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);

-- ── api_keys: per-user keys, scoped to one account, hashed at rest ──
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_api_keys_account ON api_keys(account_id);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
