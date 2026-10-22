# InboxAngel database schema

`src/schema.ts` is the source of truth. This file records **what the database looked like
before `@inbox-angel/db`** (the inventory the schema was written from), then what changed.

## 1. Inventory: the schema as of v1.2.0 (before this package)

Two things created tables and columns, and neither was complete:

* `migrations/*.sql`, applied by `wrangler d1 migrations apply` (tracked in `d1_migrations` by **file name**);
* `ensureMigrated()` in `src/db/migrate.ts`, which ran 16 numbered SQL steps on the first request of every
  Worker instance (tracked in `_migrations` by **number**), swallowing `ALTER TABLE` errors.

| Object | Created by | Notes |
|---|---|---|
| `domains` (base), `check_results`, `aggregate_reports`, `report_records` | `0001_initial.sql` **and** runtime v1 | identical DDL, both `IF NOT EXISTS` |
| `domains.dns_record_id` | `0002` **and** runtime v2 | duplicate: whichever ran second failed with "duplicate column" |
| `check_results.session_token` + index | `0003` **and** runtime v3 | duplicate |
| `monitor_subscriptions` | `0004` **and** runtime v4 | `IF NOT EXISTS` |
| `domains.rollout_rec_policy`, `rollout_rec_pct` | `0005_rollout_stage.sql` | **files only** |
| `domains.parent_id` + index | `0005_subdomain_parent.sql` | **files only** |
| `domains.is_default` + partial unique index, backfill | `0006_add_is_default.sql` | **files only** |
| `settings`, `users`, `invites`, `password_reset_tokens` | runtime v5–v8 | **runtime only** |
| `domains.alerts_enabled` | runtime v9 | **runtime only** |
| `ip_info`, `report_records.{reverse_dns,base_domain,country_code,org}` | runtime v10 | **runtime only** |
| `check_results.spf_lookup_count` | runtime v11 | **runtime only** |
| `spf_flatten_config` | runtime v12 | **runtime only** |
| `domains.spf_lookup_count` | runtime v13 | **runtime only** |
| `mta_sts_config` | runtime v14 | **runtime only** |
| `tls_reports` | runtime v15 | **runtime only** |
| `audit_log` | runtime v16 | **runtime only** |
| `_migrations` | runtime | bookkeeping, now unused (left in place) |

### Three migrations called `0005`

Git history shows **three** files have been numbered `0005_*`:

* `0005_rollout_stage.sql` (kept)
* `0005_subdomain_parent.sql` (kept)
* `0005_add_is_default.sql` — **renamed to `0006_add_is_default.sql`** in a merge.

`wrangler` identifies migrations by name, so an install that applied the old name has a row for a file that
no longer exists and would re-run `0006` ("duplicate column name: is_default"). Both remaining `0005_*`
files must keep their names (renaming them would re-run them on every install that has them).
`src/adopt.js` resolves all of this by looking at the database's actual columns — see `UPGRADING.md`.

### Legacy leftovers (not in `schema.ts`)

`0001_initial.sql` was edited in place twice (single-tenant clean-up, March 2026). Installs created before
that may still carry a `domains.dkim_configured` column (harmless: `NOT NULL DEFAULT 0`) and `customer_id`
columns/`customers` table from the original multi-tenant prototype. `customer_id` is `NOT NULL` without a default, so such databases already fail on main and are unsupported (manual path in `UPGRADING.md`); `dkim_configured` is harmless and left alone.

### Bugs found while inventorying (fixed)

* `getHeartbeatStats` queried `spf_flatten_configs` and `mta_sts_configs` (plural). The tables are singular,
  so the daily telemetry heartbeat's batch always failed. The new query uses the real names.

### Known and deliberately unchanged

* `getCheckSummary` (PDF export) multiplies report totals by the number of records per report because it
  `SUM`s over a join. Kept as-is; see `test/unit/checkSummary.test.ts`.
* `index.ts` stores MTA-STS MX hosts as a comma list while the column default is a JSON array.

## 2. Current schema (after migration `0012_accounts.sql`)

Tenancy: `accounts` + `memberships` are new. Every tenant-owned table has `account_id TEXT NOT NULL DEFAULT 'acct_default'`.
Self-hosted installs have one account, `acct_default`. `domains.domain` stays **globally** unique.

| Table | Account-scoped | Notes |
|---|---|---|
| `accounts` | — | `id`, `name`, `created_at`. Row `acct_default` is created by `0012`. |
| `memberships` | `account_id` | PK `(account_id, user_id)`, `role` ∈ `owner`/`admin`/`member` |
| `users` | global | one person may belong to several accounts |
| `domains` | ✔ | `domain` UNIQUE; one `is_default` per account (`idx_domains_is_default` on `account_id`) |
| `aggregate_reports`, `report_records`, `tls_reports` | ✔ | `account_id` denormalised onto `report_records` so every query has a direct predicate |
| `spf_flatten_config`, `mta_sts_config` | ✔ | keyed by `domain_id` |
| `monitor_subscriptions` | ✔ | `UNIQUE(account_id, email, domain)` |
| `settings` | ✔ | PK `(account_id, key)` |
| `invites`, `audit_log` | ✔ | |
| `check_results` | global | anonymous free-check results |
| `ip_info` | global | shared public IP-metadata cache |
| `password_reset_tokens` | global | keyed by `user_id`; unused since 0013 (see `verifications`) |
| `sessions`, `auth_accounts`, `verifications`, `auth_rate_limits` | global | Better Auth (0013). `auth_accounts` = login methods per user — not the tenant `accounts` table. Camel-case properties in `schema.ts`; `users` has a second view in `auth-schema.ts` |
| `intake_tokens` | ✔ | 0014: per-domain report token (SHA-256 only, rotatable, previous hash valid 72 h); looked up by hash before the account is known (`queries/intake.ts`) |
| `hosted_domains` | ✔ | 0014: a domain's opaque `hosted_id`, its records in the hosted zone, and the last pointer verification |
| `hosted_zones`, `canary_tokens` | global | 0014: record counts of the operator's hosted-records zone; expiring single-use free-check addresses |
| `api_keys` | ✔ | per-user keys, SHA-256 at rest; looked up by hash before the account is known (`queries/auth.ts`) |

`ACCOUNT_OWNED_TABLES` and `GLOBAL_TABLES` in `schema.ts` encode this split; `test/db/account-predicates.test.ts`
fails if SQL in `src/` touches an owned table without an account predicate.

### Why `account_id` has a default and no foreign key (on the altered tables)

SQLite cannot `ADD COLUMN ... NOT NULL REFERENCES` unless the default is `NULL`, and the alternative —
rebuilding `domains`/`aggregate_reports` — would fire `ON DELETE CASCADE` on their children (D1 cannot turn
foreign keys off). So `0012` adds `account_id TEXT NOT NULL DEFAULT 'acct_default'` in place (a metadata-only change)
and the query helpers always set it explicitly. `settings` and `monitor_subscriptions`, which nothing references,
were rebuilt and *do* have the foreign key. Hosted multi-tenancy can tighten this in a later migration.

## 3. Changing the schema

1. Edit `src/schema.ts`.
2. `npm run db:generate` (drizzle-kit) writes the SQL diff to `packages/db/drizzle/`.
3. Review it, add backfills, and save it as the next `migrations/NNNN_name.sql`.
4. Bump `REQUIRED_MIGRATION` in `src/ready.ts`; regenerate the baseline
   (`rm -r packages/db/drizzle && npm run db:generate -- --name baseline`).
5. `npm test` — `schema-drift`, `drizzle-baseline` and the upgrade tests tell you if you missed something.
