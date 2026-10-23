# InboxAngel database schema

`src/schema.ts` is the source of truth; `/migrations/*.sql` is what `wrangler d1 migrations apply` runs, and the drift tests
keep the two identical. The history was squashed into one baseline before the first release (see `UPGRADING.md`).

## 1. Tenancy

A **workspace** is the container for domains, reports, Cloudflare connections and billing. A **user** (one person, one
login) belongs to workspaces through **memberships** (role `owner` / `admin` / `member`, where members are read-only).
Every workspace-owned table has `workspace_id TEXT NOT NULL DEFAULT 'ws_default'`. Self-hosted installs have one workspace,
`ws_default`. `domains.domain` stays **globally** unique.

| Table | Workspace-scoped | Notes |
|---|---|---|
| `workspaces` | — | `id`, `name`, `created_at`. Row `ws_default` is created by the baseline; hosted sign-ups get `ws_<uuid>`. |
| `memberships` | `workspace_id` | PK `(workspace_id, user_id)`, `role` ∈ `owner`/`admin`/`member` |
| `users` | global | one person may belong to several workspaces |
| `domains` | ✔ | `domain` UNIQUE; one `is_default` per workspace (`idx_domains_is_default` on `workspace_id`) |
| `aggregate_reports`, `report_records`, `tls_reports` | ✔ | `workspace_id` denormalised onto `report_records` so every query has a direct predicate |
| `spf_flatten_config`, `mta_sts_config` | ✔ | keyed by `domain_id` |
| `monitor_subscriptions` | ✔ | `UNIQUE(workspace_id, email, domain)` |
| `settings` | ✔ | PK `(workspace_id, key)` |
| `invites`, `audit_log` | ✔ | |
| `check_results` | global | anonymous free-check results |
| `ip_info` | global | shared public IP-metadata cache |
| `password_reset_tokens` | global | keyed by `user_id`; unused (see `verifications`) |
| `sessions`, `auth_accounts`, `verifications`, `auth_rate_limits` | global | Better Auth. `auth_accounts` = login methods per user (credential / OAuth provider) — **not** the tenant; that is `workspaces`. Camel-case properties in `schema.ts`; `users` has a second view in `auth-schema.ts` |
| `api_keys` | ✔ | per-user keys, SHA-256 at rest; looked up by hash before the workspace is known (`queries/auth.ts`) |
| `intake_tokens` | ✔ | per-domain report token (SHA-256 only, rotatable, previous hash valid 72 h); looked up by hash before the workspace is known (`queries/intake.ts`) |
| `hosted_domains` | ✔ | a domain's opaque `hosted_id`, its records in the hosted zone, and the last pointer verification |
| `cloudflare_connections` | ✔ | a connected Cloudflare account (OAuth or pasted token); the token only as an AES-GCM envelope. `cf_account_id` is the **Cloudflare** account |
| `cloudflare_connection_zones` | ✔ | the zones Inbox Angel may manage through a connection (owner-picked allow-list) |
| `cloudflare_connection_blocked_zones` | ✔ | child zones of an allowed zone that are not on the list (their names are refused, not written to the parent) |
| `hosted_zones`, `canary_tokens` | global | record counts of the operator's hosted-records zone; expiring single-use free-check addresses |

`WORKSPACE_OWNED_TABLES` and `GLOBAL_TABLES` in `schema.ts` encode this split; `test/db/workspace-predicates.test.ts`
fails if SQL in `src/` touches an owned table without a workspace predicate.

### Why `workspace_id` has a default and no foreign key on some tables

On `domains`, `aggregate_reports`, `report_records` and the other tables that grew the column after creation, `workspace_id` is
`TEXT NOT NULL DEFAULT 'ws_default'` without a foreign key (SQLite cannot `ADD COLUMN ... NOT NULL REFERENCES` with a
non-null default, and rebuilding those tables would fire `ON DELETE CASCADE` on their children). The query helpers always set it
explicitly. Newer tables (`settings`, `monitor_subscriptions`, `api_keys`, `cloudflare_*`, …) do have the foreign key.

### Known and deliberately unchanged

* `getCheckSummary` (PDF export) multiplies report totals by the number of records per report because it
  `SUM`s over a join. Kept as-is; see `test/unit/checkSummary.test.ts`.
* `index.ts` stores MTA-STS MX hosts as a comma list while the column default is a JSON array.

## 2. Changing the schema

1. Edit `src/schema.ts`.
2. `npm run db:generate` (drizzle-kit) writes the SQL diff to `packages/db/drizzle/`.
3. Review it, add backfills, and save it as the next `migrations/NNNN_name.sql`.
4. Bump `REQUIRED_MIGRATION` in `src/ready.ts`; regenerate the drizzle baseline
   (`rm -r packages/db/drizzle && npm run db:generate -- --name baseline`).
5. `npm test` — `schema-drift` and `drizzle-baseline` tell you if you missed something.
