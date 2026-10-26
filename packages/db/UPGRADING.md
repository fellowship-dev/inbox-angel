# Migrations and upgrading

**Short version:** run `npm run migrate` **before** the new Worker serves traffic. `npm run deploy` does this for you.

```sh
git pull && npm install
npm run migrate        # wrangler d1 migrations apply DB --remote
npm run deploy         # also runs the migrate step first
```

Local dev database: `npm run migrate:local`.

## Access and metrics upgrade

Migrations `0006_access_grants.sql` and `0007_metrics.sql` are additive. Apply them before serving the new Worker. `0006` revokes legacy broad `api_keys` while preserving their rows, existing users/memberships, domains and report history; it adds products, mappings, principals, grants and hashed credentials. `0007` adds Google connection/observation storage. This upgrade does not require a data reset.

Existing owners sign in and issue replacement finite product/domain/action grants and one-time `ias_…` credentials through Settings. Old `ia_…` keys and `API_KEY` environment authority no longer authenticate. Test each integration's permitted report and sibling-resource denial before declaring the conversion complete. See [agent operations](../../docs/agent-operations.md#upgrade-from-broad-prelaunch-keys) for namespace/origin setup, private bootstrap custody and rotation. Do not use the historical pre-baseline boundary below as a reason to recreate a current database.

## History was reset before the first release

The migration history was **squashed into a single baseline before the first release**, and the tenant concept was renamed
from "account" to **workspace** in the same change (`workspaces`, `workspace_id`, `ws_default`). There were no installs
to carry forward, so there is no upgrade path from the pre-release schemas and no adoption/repair machinery: a database
created before the reset must be recreated (`wrangler d1 export` a backup if you need its rows, then migrate an empty database).

`migrations/0001_baseline.sql` creates the complete original schema (later files are additive; see each file) and the implicit workspace `ws_default`.

## How it works

* `wrangler d1 migrations apply` runs the unapplied files in `/migrations` in name order, each in one transaction, and records
  them by file name in `d1_migrations`. `npm run migrate` is a thin wrapper around it.
* The Worker never changes the schema. On startup it checks that `REQUIRED_MIGRATION` (`src/ready.ts`: the newest migration
  this build depends on) is recorded in `d1_migrations`; if not it answers `503` with "Database schema is out of date … run
  `npm run migrate`" (cron and email handlers log the same message).
* `test/schema-drift.test.ts` and `test/drizzle-baseline.test.ts` fail if `src/schema.ts` and `/migrations` disagree.

## Adding a migration

See [SCHEMA.md](SCHEMA.md#3-changing-the-schema). Never edit a released migration; add a new numbered file and bump `REQUIRED_MIGRATION`.
Prefer additive changes (new tables, nullable or defaulted columns) so the old Worker keeps running while you migrate.

## Rollback

Take a backup first: `wrangler d1 export inbox-angel --remote --output backup.sql`. The old Worker may not run against a newer
schema, so roll back by restoring the backup together with the previous Worker version.

## Requirements

* A Node version supported by the root `package.json` engines (22.22.2+, 24.15.0+ on the 24 line, or 26+).
* `wrangler` ≥ 4.
