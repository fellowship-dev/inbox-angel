CREATE TABLE google_postmaster_connections (
 id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
 token_envelope TEXT,
 status TEXT NOT NULL DEFAULT 'connected',
 last_attempt_at INTEGER,
 last_success_at INTEGER,
 UNIQUE(workspace_id, domain_id)
);
CREATE TABLE metric_observations (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES google_postmaster_connections(id) ON DELETE CASCADE,
 domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
 metric TEXT NOT NULL,
 period_start TEXT NOT NULL,
 period_end TEXT NOT NULL,
 source_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY(connection_id, domain_id, metric, period_start, period_end, source_id)
);
