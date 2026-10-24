-- Trust follow-ups: a domain evicted from its (unproven, legacy) holder is detached, not deleted, so the evicted
-- workspace keeps its report history for 30 days (export); the daily retention job then purges it.
-- Additive only.
ALTER TABLE domains ADD COLUMN evicted_at INTEGER;       -- unix seconds; set => the domain is detached and hidden
ALTER TABLE domains ADD COLUMN evicted_name TEXT;        -- the name it had; `domain` is rewritten so the name is free
CREATE INDEX idx_domains_evicted ON domains(evicted_at) WHERE evicted_at IS NOT NULL;
