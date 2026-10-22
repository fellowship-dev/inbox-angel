# Upgrading an existing install to the account-aware schema

**Short version:** run `npm run migrate` (not bare `wrangler d1 migrations apply`) **before** the new Worker
serves traffic. `npm run deploy` now does this for you.

```sh
git pull && npm install
npm run migrate        # adopt existing history, then wrangler d1 migrations apply DB --remote
npm run deploy         # also runs the migrate step first
```

Local dev database: `npm run migrate:local`. To see what would happen without changing anything:
`node packages/db/scripts/migrate.mjs --remote --dry-run`.

## What changed

Until now the Worker created and altered tables itself on the first request (`ensureMigrated`). That is gone:
**`wrangler d1 migrations apply` is the only way the schema changes.** If the Worker starts against a database
that has not been migrated it answers `503` with "Database schema is out of date … run `npm run migrate`"
(cron and email handlers log the same message) instead of failing on missing columns.

The upgrade (migrations `0007`–`0012`):

1. creates, if missing, the tables the Worker used to create at runtime (`0007`) and adds the columns it used to add (`0008`–`0011`);
2. creates the implicit account `acct_default` and a `memberships` row for every user (earliest admin = `owner`);
3. adds `account_id` to all tenant-owned tables, backfilled to `acct_default`;
4. gives `settings` and `monitor_subscriptions` per-account keys, and makes "one default domain" per account;
5. drops the legacy `auto_api_key` setting and promotes a v0.9.x settings-based login to a user, as `ensureMigrated` did.

Nothing is deleted. Row counts are verified by the upgrade tests.

## Why `npm run migrate` and not just `wrangler d1 migrations apply`

`wrangler` decides what to run by **file name**. Installs from before this change break that in three ways:

* **Three migrations have been called `0005_*`.** `0005_add_is_default.sql` was renamed `0006_add_is_default.sql` in a merge.
  If you applied it under the old name, plain `wrangler` runs `0006` again and fails with *duplicate column name: is_default*.
* **The Worker added columns itself** (`alerts_enabled`, `spf_lookup_count`, the `report_records` enrichment columns…).
  `0008`–`0011` add them, and SQLite has no `ADD COLUMN IF NOT EXISTS`, so they would fail on any database that already has them.
* **Installs that never ran `npm run migrate`** have no `d1_migrations` history at all, although `0001`–`0004`'s effects exist.

Before applying, `npm run migrate` inspects the database and records in `d1_migrations` every migration whose
effect is already present (`ADOPTION_RULES` in `src/adopt.js`), so `wrangler` skips exactly those. It prints what it
records. On a fresh database it records nothing. It is safe to run repeatedly.

If you run bare `wrangler d1 migrations apply` on an install that needs adopting you get one of the "duplicate
column name" errors above; nothing is half-applied (each migration file runs as one transaction — checked on local D1). Run `npm run migrate` and continue.
`0012` also refuses to run (with a `baseline_ok` constraint error) if the columns it depends on are missing.

## Rollback

Take a backup first: `wrangler d1 export inbox-angel --remote --output backup.sql`.
The old Worker cannot run against the new schema (its inserts into `settings`/`monitor_subscriptions` use the old keys),
so roll back by restoring the backup together with the previous Worker version.

## Requirements

* Node ≥ 20 for `npm run migrate` (plain ESM, no build step); `engines` pins this. Any default Workers Builds / Deploy-button Node works.
* `wrangler` ≥ 4.

## Unusual databases

* **Databases created before March 2026 (the multi-tenant prototype) are not supported and are already broken on main.** Their `customer_id` columns are `NOT NULL` with no default, so inserts from the current app fail. Manual path: `wrangler d1 export` a backup, then recreate the database with `npm run migrate` on an empty one and re-import your rows into the current columns (`domains`, `aggregate_reports`, `report_records`), dropping `customer_id`/`customers`/`dkim_configured`.
* A database with a half-applied `0011` (only some of the four columns) is repaired by the adoption step.

## 0013: Better Auth

Migration `0013_better_auth.sql` adds `sessions`, `auth_accounts`, `verifications`, `auth_rate_limits` and `api_keys`,
and `email_verified`/`image`/`updated_at` on `users`.

* Every user with a `password_hash` gets a `credential` row in `auth_accounts` with the **same hash string**. The Worker keeps the
  existing PBKDF2 hasher (`saltHex:hashHex`), so passwords verify unchanged; no rehash step.
* **Sessions are not carried over.** `users.session_token` is no longer read (the column stays); everyone signs in once more.
* `password_reset_tokens` stays but is unused; outstanding reset links stop working. Reset tokens now live in `verifications`.
* Roles come from `memberships` (0012). Members are read-only in the API.
* Roll back by restoring the backup with the previous Worker, as for 0012.

## 0014: hosted intake

Migration `0014_hosted_intake.sql` adds `intake_tokens`, `hosted_domains`, `hosted_zones` and `canary_tokens`. Purely additive; self-host installs
never write to them (they only matter with `MODE=saas`). Roll back by restoring the backup with the previous Worker.
