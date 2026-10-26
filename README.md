# Inbox Angel

Cloudflare Workers backend for [InboxAngel](https://github.com/Fellowship-dev/inbox-angel).
Self-hostable email authentication platform — DMARC monitoring, SPF management, MTA-STS provisioning, and TLS-RPT reporting, all running on your own Cloudflare account.

---

## What it does

Most domains start at `p=none` — DMARC is watching but not protecting. Getting to `p=reject` means spoofed email claiming to be from your domain gets blocked at delivery. But you can't flip that switch blindly: you need to know that all your legitimate senders are properly authenticated first.

InboxAngel collects DMARC aggregate reports from receiving mail servers worldwide and shows you exactly what's passing, what's failing, and where it's coming from. The dashboard combines observed sender alignment, coverage and readiness before proposing an enforcement change. From there you can go further — SPF flattening, MTA-STS, TLS-RPT — but the core value is getting you from "I don't know" to `p=reject` without breaking your email.

### DMARC monitoring

Mail servers that receive email from your domain send daily XML reports back to InboxAngel. The Worker parses them, stores them in D1, and the dashboard shows trends, failing sources, pass rates, and policy guidance.

```
Receiving mail servers → XML aggregate report → rua@reports.yourdomain.com
  └── Cloudflare Email Worker receives it
        ├── Parses XML: sending IPs, pass/fail per SPF + DKIM + DMARC
        └── Stores in D1 → dashboard shows 30/60-day trends + guidance
```

The dashboard shows observed alignment and readiness with their source windows and missing evidence. A pass rate alone does not establish that every legitimate sender is covered; review the prerequisites before authorizing an enforcement change.

### SPF management

SPF has a hard limit of 10 DNS lookups. Add a third mail provider and you're over — receiving servers return `permerror` and your mail looks unauthenticated. InboxAngel tracks your lookup depth and can flatten your SPF record automatically: it walks the full include chain, resolves everything to raw IPs, and keeps the Cloudflare DNS record up to date daily.

### MTA-STS / TLS-RPT

MTA-STS (RFC 8461) lets you publish a policy that tells sending MTAs to require TLS when delivering to your domain — no opportunistic downgrade. InboxAngel provisions the three required DNS records, serves the policy file at the required `mta-sts.yourdomain.com/.well-known/mta-sts.txt` HTTPS endpoint via Cloudflare Workers, and manages the mode lifecycle: always starts in `testing` (non-enforcing, just signaling), and the dashboard surfaces a graduation prompt once you're ready for `enforce`.

TLS-RPT (RFC 8460) is the reporting side: sending MTAs email JSON reports to `tls-rpt@reports.yourdomain.com` when they encounter TLS failures. InboxAngel parses and stores these, and the MTA-STS card in the dashboard shows a 30-day success/failure count so you know whether enforcement is actually breaking anything.

```
Sending MTA → attempts TLS → policy says "enforce" → must succeed or reject
  └── On failure: MTA sends TLS-RPT JSON report → tls-rpt@reports.yourdomain.com
        └── Worker parses RFC 8460 JSON → stores in D1 → shown in dashboard
```

---

## Self-hosting

### Before you start — create your Cloudflare API token

The Worker needs a token at runtime to manage Email Routing rules and DNS records.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**
2. Give it a name (e.g. `inbox-angel-runtime`)
3. Set these permissions:

| Scope | Resource | Permission |
|---|---|---|
| Account | Account Settings | Read |
| Account | Email Sending | Edit |
| Account | Email Routing Addresses | Edit |
| Zone | Zone | Read |
| Zone | Email Routing Rules | Edit |
| Zone | DNS | Edit |
| Zone | Workers Routes | Edit |

4. Under **Zone Resources**, select the zone where your domain lives
5. Click **Continue to summary** → **Create Token** — copy it

---

### Step 1 — Deploy

**Option A — one click (recommended):**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fellowship-dev/inbox-angel)

The button starts the Worker/D1 deployment and prompts for the runtime API token. Before first-owner setup, also complete the installation-owned OAuth namespace, canonical HTTPS origin and private installer-proof steps in [the operator guide](docs/agent-operations.md#installer-setup). Do not treat a successful deployment as completed setup.

**Option B — CLI:**

```bash
npm install
wrangler secret put CLOUDFLARE_API_TOKEN  # the token you created above
# Create/bind your D1 and OAUTH_KV, set BETTER_AUTH_URL, and upload BOOTSTRAP_SECRET
# using the private-file procedure in docs/agent-operations.md before first setup.
npm run deploy
```

The installation needs `OAUTH_KV`, a canonical HTTPS `BETTER_AUTH_URL` and private `BOOTSTRAP_SECRET`; domain intake and optional Cloudflare DNS/routing configuration are separate setup steps. No Fellowship account, Google connection or outbound mail service is needed for a first live-DNS health report.

**Option C — GitHub Actions (manual):** the `Deploy` workflow (`.github/workflows/deploy.yml`) runs only when you start it from the Actions tab (**Run workflow**); pushes to `main` never deploy. It needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets listed at the top of the workflow.

---

<a id="post-deploy"></a>

### Step 2 — Create your account

Open the canonical HTTPS Worker URL. Enter your email, new password and the installer-held proof in the masked **Installer proof** field. Successful setup consumes the proof and creates the owner; public visitors and social sign-in cannot claim first ownership. Keep proof/password values out of chat, URLs and logs. See [installer setup and recovery](docs/agent-operations.md).

---

### Step 3 — Set up your domain

After creating your account, the setup wizard walks you through five steps:

1. **Domain** — enter your domain (e.g. `yourdomain.com`). Zone ID and Cloudflare account ID are auto-resolved from the Cloudflare API.
2. **SPF** — checks your SPF record and lookup depth
3. **DKIM** — scans for DKIM selectors
4. **DMARC** — shows your current record and recommended changes. Can apply via Cloudflare DNS with one click.
5. **Routing** — sets up MX records and email routing. Registers your email as a verified destination so you can receive alerts and password resets.

Received reports appear after reporting DNS and intake are configured and receivers send them; arrival timing and coverage vary. The shared health report is useful immediately from live DNS and explicitly unavailable history. Review sender evidence and prerequisites before tightening policy toward `p=reject`.

### Free email check: delivering the report

A visitor emails their `check+<token>@<reports domain>` address and gets the report back. The Worker first answers with Cloudflare's `message.reply()`, which Cloudflare only allows when the incoming email has a valid DMARC result, so a sender whose domain has no DMARC (exactly who the check is for) is refused there. The report then goes out as a new email through the `SEND_EMAIL` binding, **only when `AUTHSERV_ID` and `AUTHSERV_HEADER` are set and the receiver's own Authentication-Results show an SPF pass for the envelope sender's domain** (`smtp.mailfrom`); otherwise the sender may be forged and the report would land on someone else, so nothing is sent. For it to reach strangers, **onboard your reports domain as a sending domain in Cloudflare Email Service** (Workers Paid): before onboarding, the binding only reaches verified destination addresses. When the report is not delivered, the reason is logged and the result is stored with `report_sent = 0`. Details: [docs/email-funnel.md](docs/email-funnel.md#free-check-delivery).

| Variable | Free check |
|---|---|
| `MAIL_REPLY_TO` | **Required for replies.** The report ends with "Need help? Any doubts? Reply." and carries this Reply-To (a mailbox someone reads, e.g. routed with Email Routing). Unset: no Reply-To, and the Leads page (`GET /api/leads` → `delivery.warnings`) flags it even when the onboarding sequence is off. |
| `SITE_URL` | Your public marketing site (`https://…`), linked from the report. Unset: no marketing link. `PUBLIC_BASE_URL` stays the Worker's own origin, for unsubscribe and confirmation links. |
| `RETENTION_CHECK_RESULTS_DAYS` | How long check results are kept (default 30). The report states it; a sender enrolled in the follow-up emails is told their address and a result summary are kept for follow-ups until they unsubscribe (then only the address, on a do-not-contact list), a past lead that it is kept up to 12 months after their last check, a suppressed address that it stays on the do-not-contact list. |

---

## Authentication

Auth is [Better Auth](https://www.better-auth.com) on D1 (sessions, logins and reset tokens live in your database).

* **First owner:** email/password setup requires the installation's private, single-use `BOOTSTRAP_SECRET` proof. Without valid proof it stays closed; no shared default password or first-visitor ownership race exists. Social sign-in cannot create the first owner. Further self-host users join by invite.
* **Roles** are per workspace. Owners/admins can perform permitted domain operations; members read. Product grants, credential administration and Google Postmaster connections require a browser **owner**, not merely an admin. Delegated principals remain constrained by their current finite grants.
* **Workspaces:** one login can belong to several workspaces, each with its own domains, reports, members and roles. Switch from the top of the sidebar. Only the self-host instance owner creates further workspaces; only the default workspace uses the server's Cloudflare token. See [workspaces](docs/workspaces.md).
* **GitHub / Google sign-in** appears when its separate credentials are configured (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`). Callbacks are `https://<your-worker>/api/auth/callback/github` and `…/google`. An invited self-host user must satisfy the existing account/invite policy; social login is not bootstrap proof.
* **Interactive agents:** use this installation's HTTPS `/mcp` endpoint, browser sign-in and exact resource/action/expiry consent. The dashboard lists personal connected agents and supports revocation. See [agent setup](docs/agent-operations.md#first-useful-report) and [plugin setup](plugins/inbox-angel/SETUP.md).
* **Product credentials:** owners create named products, domain mappings, service principals and finite grants in Settings. One-time `ias_…` credentials are stored as hashes and cannot create stronger credentials or administer users. Rotation issues a replacement before owner acknowledgement revokes the previous key. Shared sending domains retain shared-domain telemetry coverage.
* **Legacy credentials:** old `ia_…` keys and `API_KEY` env authority are retired. `POST /api/keys` answers `410`; old `/keys` bookmarks go to Settings. Migration `0006_access_grants.sql` revokes broad keys without resetting users, domains or report history. [Convert each integration deliberately](docs/agent-operations.md#upgrade-from-broad-prelaunch-keys).
* **Password reset** uses the configured outbound path. On self-host, Cloudflare Email Routing requires a verified destination; verify and test delivery to the owner separately. First-owner account verification does not prove mail delivery. An installation without a working outbound path has no email-based self-service recovery; preserve owner password/session custody. [Recovery limits](docs/agent-operations.md#owner-recovery-and-acceptance-boundaries) are explicit; the consumed bootstrap proof does not reopen ownership.
* **Security:** auth POSTs (setup, login, logout, reset, invite…) must be `application/json` and, when sent by a browser, same-origin (login-CSRF protection); cookie-authenticated writes must come from the same origin (set `TRUSTED_ORIGINS` for extra ones); login, sign-up and reset are rate-limited per IP in D1; resetting a password signs out every session; password reset never reveals whether an address exists.
* Optional settings: `OWNER_EMAIL`; `MODE=saas` + `SAAS_ENABLED=1` (hosted mode, **not launched**: every sign-up gets its own workspace and everything — data, audit entries, invites and delegated grants — is scoped to the caller's workspace; without `SAAS_ENABLED=1` the Worker answers 503 in `MODE=saas`), `BETTER_AUTH_SECRET` (session signing secret — generated and stored in D1 if unset), `BETTER_AUTH_URL` (canonical HTTPS installation origin), `BOOTSTRAP_SECRET` (private first-owner proof) and `OAUTH_KV` (installation-owned agent OAuth storage). Optional `MCP_DCR_ENABLED=1` enables dynamic registration for clients that require it; client-ID metadata documents are supported by default.

Google Postmaster uses a separate owner-approved read connection and explicit 1–90 day sync. Configure its `GOOGLE_POSTMASTER_CLIENT_ID`, `GOOGLE_POSTMASTER_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY`; Google account sign-in alone grants no metrics. [Source definitions, unavailable states and recovery](docs/agent-operations.md#google-postmaster-is-a-separate-owner-connection) are part of the operator workflow.

## Upgrading

The schema is managed by `packages/db` migrations; the Worker no longer changes it at runtime.

1. Back up D1: `wrangler d1 export inbox-angel --remote --output backup.sql`
2. Run `npm run migrate` before serving the new Worker. The wrapper applies unapplied migration files through Wrangler.
3. Convert retired broad credentials to owner-issued finite grants and credentials. Current access/metrics migrations are additive; no data reset is required. Preserve a database/Worker backup pair for rollback.

Until migrated, the Worker answers 503 and inbound email is refused for retry. Details, rollback and edge cases: [packages/db/UPGRADING.md](packages/db/UPGRADING.md).

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Compute | Cloudflare Workers | Edge runtime, zero cold start |
| Inbound email | Cloudflare Email Workers | Receives `*@reports.<BASE_DOMAIN>` |
| Outbound email | Cloudflare Email Workers | Sends digests and alerts |
| Storage | Cloudflare D1 | SQLite at the edge |
| DNS provisioning | Cloudflare DNS API | Per-domain auth records + SPF + MTA-STS |
| Auth | Better Auth on D1 | Email/password and optional social login; browser OAuth for agents; finite principal grants |
| Frontend | Embedded SPA | React app in `web/` (on `packages/ui`), served as static assets |

---

## Repository layout

The deployable Worker stays at the repo root so the Deploy to Cloudflare button (which clones the whole repo and builds from its root) keeps working with the plain root URL. Shared code lives in npm workspaces:

| Path | What |
|---|---|
| `src/`, `web/`, `migrations/`, `test/`, `e2e/`, `scripts/`, `wrangler.jsonc`, `deploy.json` | The Worker app (root `package.json`) |
| `packages/*` | Workspace packages. `@inbox-angel/dns-checks` (pure SPF/DKIM/DMARC/MTA-STS/BIMI checks) is imported by name from the app and bundled by wrangler |
| `tools/*` | Offline tooling (`tools/audit-fleet`) |

**Why npm workspaces, not pnpm:** the Deploy button and most self-hosters already run `npm install` against a `package-lock.json`. npm needs no extra tool or corepack step, so it carries the least risk. pnpm can be revisited later.

## Local Development

Requires Node.js 22.22.2 or newer (24.15.0+ on the 24 line; odd-numbered 23 and 25 are unsupported). `wrangler` 4.92 and `miniflare` require Node 22 or later; the dashboard test tooling (`jsdom` 30 and its dependencies) sets the 22.22.2 floor.

```bash
npm install             # installs the root app and all workspaces (including web/)
npm run dev:dashboard   # web/ Vite dev server on :5173 (proxies /api to :8787)
npm run test:web        # dashboard component + route tests
npm run dev             # Worker on :8787 (wrangler dev); applies local migrations first
npm test                # unit tests: test/ and packages/*/test
npm run typecheck       # app + shared packages + dashboard typechecks
npm run test:e2e        # Playwright against http://127.0.0.1:8787 (start `npm run dev` first)
```

`npm run dev` builds the dashboard first (`npm install` must have installed the `web/` workspace deps) and applies `migrate:local`; until the local D1 is migrated `/health` answers 503. The current additive access/metrics upgrade preserves existing data. Historical pre-baseline databases have a separate compatibility boundary described in [packages/db/UPGRADING.md](packages/db/UPGRADING.md); preserve their export instead of treating a reset as an upgrade step.

Agent authorization requires a canonical HTTPS origin even for local protocol acceptance. Keep local fixture/protocol proof distinct from deployed desktop-client and live Google acceptance; see [acceptance boundaries](docs/agent-operations.md#owner-recovery-and-acceptance-boundaries).

`test:e2e` targets local `wrangler dev` by default; set `E2E_BASE_URL` to point elsewhere. It is not part of CI. There is no Workers-runtime (`@cloudflare/vitest-pool-workers`) suite yet — the old `test:workers` script just re-ran the node tests, so it was removed. Add a pool-workers config alongside the first real Worker integration test.

---

## DNS Provisioning

Each monitored domain gets a third-party reporting authorization record (RFC 7489 §7.1):

```
company.com._report._dmarc.reports.yourdomain.com  TXT  "v=DMARC1"
```

Without this, receiving mail servers silently reject the external RUA address. The Worker provisions it automatically when you add a domain. If your domain is on external DNS, the dashboard shows the record value to add manually.

---

## Uninstalling

**1. Export your data first**

Dashboard → any domain → Settings → Export. Downloads a full JSON export of all reports, sources, and stats for that domain.

**2. Remove your domains from the dashboard**

Dashboard → each domain → Settings → Delete domain. This removes the DNS authorization records the Worker provisioned.

**3. Update your DMARC records**

Remove the `rua@reports.yourdomain.com` address from each domain's `_dmarc` TXT record.

**4. Delete the Worker and database**

```bash
wrangler delete                   # removes the Worker and its routes
wrangler d1 delete inbox-angel    # permanently deletes the D1 database
```

**5. Clean up email routing**

Cloudflare dashboard → your zone → Email → Routing:
- Delete the catch-all rule pointing to this Worker
- Delete the MX records added for `reports.yourdomain.com`

**6. Delete the API token**

Cloudflare dashboard → My Profile → API Tokens → delete the token you created.

---

## Related

- [RFC 7489](https://datatracker.ietf.org/doc/html/rfc7489) — DMARC
- [RFC 7208](https://datatracker.ietf.org/doc/html/rfc7208) — SPF
- [RFC 8461](https://datatracker.ietf.org/doc/html/rfc8461) — MTA-STS
- [RFC 8460](https://datatracker.ietf.org/doc/html/rfc8460) — TLS-RPT
- [Cloudflare Email Workers](https://developers.cloudflare.com/email-routing/email-workers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
