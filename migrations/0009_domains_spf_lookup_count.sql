-- Migration 0009: cached SPF lookup depth on the domain row (was ensureMigrated v13).
ALTER TABLE domains ADD COLUMN spf_lookup_count INTEGER;
