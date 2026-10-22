# Code Structure

Architecture and module responsibilities for Inbox Angel (repo `fellowship-dev/inbox-angel`; the Cloudflare Worker script is still named `inbox-angel-worker` by default).

---

## core

The core layer is the Worker entrypoint plus two cross-cutting utilities: environment resolution and telemetry.

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

All handlers run `ensureMigrated(env.DB)` before business logic to guarantee the D1 schema is up to date.

---

### `src/env-utils.ts` — Environment Cache

Provides a lazy-loaded, module-scoped cache for all resolved configuration values. The cache lives for the lifetime of the Worker instance (shared across requests within the same isolate — not persisted between isolates or cold starts).

**Why a module-level cache?**  
D1 and CF API calls are expensive. `enrichEnv()` is called at the top of every request and cron handler. The cache means only the first call per isolate does any I/O.

**Public getters**

| Function | Returns |
|----------|---------|
| `getZoneId()` | CF zone ID for the base domain |
| `getAccountId()` | CF account ID |
| `getBaseDomain()` | The configured base domain (e.g. `acme.com`) |
| `getWorkersSubdomain()` | CF Workers subdomain (e.g. `fellowshipdev`) |
| `reportsDomain()` | Reports subdomain (e.g. `reports.acme.com`) |
| `fromEmail()` | Outbound from address (e.g. `noreply@reports.acme.com`) |
| `brandLogoUrl()` | Optional brand logo URL for HTML emails |
| `brandColor()` | Brand accent hex color — defaults to `#4F46E5` |

**`enrichEnv(env, db?)`** — main entry point

Call once at the top of request/cron handlers before reading any config value. Resolution order:

1. **Module cache** — hot path, no I/O if already warm
2. **D1 settings table** — reads `base_domain`, `zone_id`, `account_id`, `reports_domain`, `from_email`, `workers_subdomain`, `brand_logo_url`, `brand_color`
3. **Domains table fallback** — if `base_domain` is absent from settings, falls back to `domains WHERE is_default = 1`
4. **CF zones API** — resolves `zone_id` + `account_id` if still missing; retries with apex domain if the configured domain is a subdomain
5. **CF workers/subdomain API** — resolves `workers_subdomain` if still missing
6. **Derived defaults** — `reports_domain = reports.{base_domain}`, `from_email = noreply@reports.{base_domain}`
7. **Persist to D1** — writes resolved `zone_id`, `account_id`, and `workers_subdomain` back to D1 so subsequent cold starts skip the API calls

**`resetEnvCache()`**

Clears all module-level caches. Called by the setup wizard after the user configures a new `base_domain` so the next request re-resolves everything from scratch.

---

### `src/telemetry.ts` — Anonymous Telemetry

Optional, opt-in telemetry. Disabled by default. Users opt in through the dashboard settings page, which writes `telemetry_opted_in = "true"` to the D1 settings table.

**Privacy guarantees**
- Anonymous ID: `SHA-256(account_id + worker_name)[:16]` — a one-way hash, cannot be reversed
- Collected: event type, typed properties (counts, statuses), worker version, anonymous ID, unix timestamp
- Never collected: domain names, email addresses, IP addresses, report contents

**`track(env, props)`**

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

The opt-in state is cached in a module-level variable to avoid a D1 query on every event call.

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
