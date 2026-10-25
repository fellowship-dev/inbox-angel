-- No implicit conversion of broad prelaunch credentials. Keep audit/history rows and require new consent.
UPDATE api_keys SET revoked_at = unixepoch() WHERE revoked_at IS NULL;
CREATE TABLE products (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL, archived_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE product_domains (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
 PRIMARY KEY(product_id, domain_id)
);
CREATE TABLE access_principals (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, disabled_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE access_grants (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 principal_id TEXT NOT NULL REFERENCES access_principals(id) ON DELETE CASCADE,
 product_id TEXT REFERENCES products(id) ON DELETE CASCADE, domain TEXT,
 actions TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
 created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE access_credentials (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 principal_id TEXT NOT NULL REFERENCES access_principals(id) ON DELETE CASCADE,
 name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
 expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER,
 created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
