-- Migration 0008: domain-level alerts toggle (was ensureMigrated v9).
-- Skipped by `npm run migrate` on installs that already have the column.
ALTER TABLE domains ADD COLUMN alerts_enabled INTEGER NOT NULL DEFAULT 1;
