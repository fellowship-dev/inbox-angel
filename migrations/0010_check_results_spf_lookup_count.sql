-- Migration 0010: SPF lookup count on free-check results (was ensureMigrated v11).
ALTER TABLE check_results ADD COLUMN spf_lookup_count INTEGER;
