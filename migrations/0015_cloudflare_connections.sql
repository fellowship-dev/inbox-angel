-- Migration 0015: Cloudflare connections. Additive only.
--
--   cloudflare_connections       a Cloudflare account an Inbox Angel account connected (OAuth or pasted token);
--                                the token is stored only as an AES-GCM envelope
--   cloudflare_connection_zones  the zones Inbox Angel may manage through a connection (the owner's allow-list)
--   cloudflare_connection_blocked_zones  child zones of an allowed zone that are not on the list (their names are refused)
--   domains.cf_connection_id     the connection that manages the domain's zone (NULL: self-host env token, or none)

CREATE TABLE cloudflare_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
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
CREATE INDEX idx_cf_connections_account ON cloudflare_connections(account_id);

CREATE TABLE cloudflare_connection_zones (
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  cf_account_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (connection_id, zone_id)
);
CREATE INDEX idx_cf_connection_zones_account ON cloudflare_connection_zones(account_id);

CREATE TABLE cloudflare_connection_blocked_zones (
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (connection_id, zone_id)
);
CREATE INDEX idx_cf_connection_blocked_account ON cloudflare_connection_blocked_zones(account_id);

ALTER TABLE domains ADD COLUMN cf_connection_id TEXT REFERENCES cloudflare_connections(id) ON DELETE SET NULL;
CREATE INDEX idx_domains_cf_connection ON domains(cf_connection_id);
