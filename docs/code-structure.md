# Code Structure

Architecture and module responsibilities for Inbox Angel (repo `fellowship-dev/inbox-angel`; the Cloudflare Worker script is still named `inbox-angel-worker` by default).

---

## core

The core layer is the Worker entrypoint plus two cross-cutting pieces: the per-request tenant context and telemetry.

### `src/index.ts` — Worker Entrypoint

Exports the `Env` interface that describes every Cloudflare binding and secret the Worker depends on:

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | `D1Database` | Persistent storage (settings, domains, subscriptions, audit log) |
| `ASSETS` | `Fetcher` | Serves the dashboard SPA for all non-API routes |
| `SEND_EMAIL` | `SendEmail` | CF Email Workers outbound binding for notification emails |
| `AUTH_LIMITER` | Rate limiter | 10 req/min per key — protects auth endpoints |
| `API_LIMITER` | Rate limiter | 200 req/min global — protects all API routes |
| `CLOUDFLARE_API_TOKEN` | secret | EMAIL token — DNS writes and email routing |
| `API_KEY` | secret (optional) | Static API key auth for headless integrations |
| `WORKER_NAME` | var | Defaults to `"inbox-angel-worker"` |
| `MODE` | var (optional) | `selfhost` (default) or `saas` |

Three handlers are exported:

**`fetch(request, env, ctx)`** — HTTP handler

Routing priority (evaluated top to bottom):

1. If `env.DB` is missing → return setup page (503 HTML with wrangler setup instructions)
2. `mta-sts.*` hostname + `/.well-known/mta-sts.txt` path → serve MTA-STS policy file (RFC 8461)
3. `/health` or `/api/*` → `handleApi()` (dashboard API, DNS provisioning)
4. Anything else → `env.ASSETS.fetch(request)` (dashboard SPA)

**`email(message, env, ctx)`** — Email Worker handler

Routes inbound emails (DMARC RUA reports + free one-shot checks) to `handleEmail()`.

**`scheduled(event, env, ctx)`** — Cron dispatcher

Keyed on `event.cron` (the expression string from `wrangler.jsonc`):

| Cron | Time | Task |
|------|------|------|
| `0 11 * * *` | 11am UTC daily | `instance.heartbeat` telemetry event |
| `0 9 * * 1` | 9am UTC Monday | Weekly digest emails via `sendWeeklyDigests()` |
| `0 10 * * *` | 10am UTC daily | SPF flatten refresh — re-flattens all enabled domains via CF DNS |
| `0 8 * * *` | 8am UTC daily (default) | Monitor check + SPF lookup count refresh + rollback regression check + MTA-STS MX refresh |

All handlers run `assertSchemaReady(env.DB)` (from `@inbox-angel/db`) before business logic: the Worker no longer changes the schema, it only checks that `npm run migrate` has been run. Schema, migrations and queries live in `packages/db`.

---

### `src/tenancy/` — Tenant context and Cloudflare client

Everything one request (or one cron workspace) needs is built per request and thrown away with it. There is **no module-level per-tenant state** in `src/` (`test/tenancy/guards.test.ts` enforces it), so concurrent requests for different workspaces in one isolate cannot see each other's zones, settings or branding.

| File | Role |
|------|------|
| `mode.ts` | `MODE=selfhost\|saas` from env; defaults to `selfhost` |
| `resolver.ts` | `WorkspaceResolver` seam `(request, env) => {workspaceId, userId?, role?} \| null`. The self-host resolver always returns the implicit workspace (`ws_default`); the auth lane plugs in a session-based one. Also `listCronWorkspaces` (self-host: just the one) |
| `context.ts` | `TenantContext`: `workspaceId`, `mode`, `settings` (base/reports domain, from address, branding, stored zone), `scope` (workspace-scoped queries), `cf()` (the Cloudflare client factory), `zoneFor(domain)` |
| `load.ts` | `loadTenant(env, workspace)` reads the tenant's settings from D1, derives defaults, resolves the base domain's zone once and persists it. Replaces the old `enrichEnv()` cache |
| `cf-client.ts` | `CfClient`: the only code that talks to `api.cloudflare.com` |

**`CfClient`** is bound to one token. `zoneFor(domain)` finds the zone of *that* domain by its registrable name (`a.b.acme.com` → `acme.com`; shortest candidate first, so `co.uk` style suffixes are skipped) and caches answers for the client's lifetime, which is one request. Every DNS write (apply-dmarc, apply-spf, the SPF flattener, MTA-STS, DMARC mode change) targets the zone of the domain it is for. Records under the reports domain (the `_report._dmarc` authorisation record, Email Routing, null-sender records) go to the reports domain's zone. Failures are typed: `CfNetworkError`, `CfAuthError` (401/403), `CfNotFoundError`, `CfApiError`, `CfZoneNotFoundError`, `CfNotConfiguredError`. The token is held in a private field and never appears in errors, JSON, `inspect` output or logs.

**Crons** (`src/cron.ts`) fan out over the workspaces, each in its own `try`, so one workspace's Cloudflare 403 doesn't stop the others.

**Credentials:** self-host uses the `CLOUDFLARE_API_TOKEN` secret. In `saas` mode no token is used until per-workspace credentials exist (`loadTenant`'s `cfToken` option is the seam); the operator's token is never shared across tenants.

| Env | Purpose |
|-----|---------|
| `MODE` | `selfhost` (default) or `saas` |
| `WORKER_NAME` | Worker script name; defaults to `inbox-angel-worker` (existing installs) |

---

### `src/connections/` — Cloudflare connections (OAuth + pasted tokens)

One Inbox Angel workspace holds several Cloudflare connections; each domain is linked to the one that manages its zone. `crypto.ts` seals tokens (AES-GCM, versioned key id), `oauth.ts` is the PKCE protocol and signed state, `service.ts` stores, refreshes, restricts (zone allow-list) and revokes, `routes.ts` is `/api/cloudflare/*` and `PUT /api/domains/:id/connection`, `relay.ts` is the optional self-host redirect relay (inert unless configured). `TenantContext.cfFor(domain)` is how the rest of the Worker gets a client. See [cloudflare-oauth.md](cloudflare-oauth.md).

### `src/hosted/` — Hosted (SaaS) intake and records

Only active with `MODE=saas` + `SAAS_ENABLED=1`; see [hosted.md](hosted.md). `intake.ts` routes `rua+<token>@` / `tls-rpt+<token>@` mail to the token's workspace (no default-workspace fallback), `canary.ts` handles the anonymous `check+<token>@`, `records.ts` is the name-guarded writer for `*.h.<zone>`, `zones.ts` tracks the 3,500-record quota and is the shard seam, `pointers.ts` verifies the customer's CNAME/SPF pointers, `service.ts` + `routes.ts` are `/api/domains/:id/hosted`, `cron.ts` is the daily zone diff.

---

### `src/telemetry.ts` — Anonymous Telemetry

Optional, opt-in telemetry. Disabled by default. Users opt in through the dashboard settings page, which writes `telemetry_opted_in = "true"` to the D1 settings table.

**Privacy guarantees**
- Anonymous ID: `SHA-256(cloudflare_account_id + worker_name)[:16]` (saas also mixes in the tenant's workspace id) — a one-way hash, cannot be reversed
- Collected: event type, typed properties (counts, statuses), worker version, anonymous ID, unix timestamp
- Never collected: domain names, email addresses, IP addresses, report contents

**`track(tenant, props)`**

Fire-and-forget. Never throws. Silently no-ops if telemetry is disabled or if the fetch fails.

**`TelemetryProps`** — typed union of all valid events:

| Event | When fired |
|-------|-----------|
| `instance.born` | First setup completion |
| `instance.heartbeat` | Daily cron — includes domain/report counts and instance age |
| `domain.add` / `domain.remove` | Domain management |
| `domain.dns_verified` | DNS verification passed |
| `domain.dmarc_mode_change` | DMARC policy changed (from/to recorded) |
| `spf_flatten.enable` / `.disable` | SPF flatten toggle |
| `mta_sts.enable` / `.disable` / `.mode_change` | MTA-STS toggle or mode change |
| `check.created` / `check.received` | Free one-shot email check |
| `report.received` / `tls-rpt.received` | DMARC or TLS report ingested |

The opt-in state is read once per `TenantContext` (not cached at module level, so it can't leak between workspaces).

---

## packages/dns-checks

Pure DNS and email-authentication logic (SPF, DKIM, DMARC, MTA-STS, BIMI, MX, provider detection,
`checkDomain()` with a Levels 0–3 grade). No D1, no Cloudflare zone API, no env globals; `fetch` is
injectable. See `packages/dns-checks/README.md`.

The worker imports it by relative path and only adds the Cloudflare/D1 side:

| Worker module | Role |
|---------------|------|
| `src/email/dns-check.ts` | Adapter: binds the package to global `fetch`. `null` = authoritatively absent; a DNS failure **throws** `DnsLookupError` |
| `src/email/spf-flattener.ts` | `collectIps` (throws on incomplete resolution) + Cloudflare DNS PATCH/restore |
| `src/email/mta-sts.ts` | `discoverMxHosts` / `detectExistingMtaStsMode` (throw on DNS error) + Cloudflare provisioning |
| `src/monitor/check.ts` | Diffs baselines; a failed lookup keeps the old baseline and reports no change |

Public Suffix List data comes from the `tldts` dependency; update it with `npm update tldts`.
