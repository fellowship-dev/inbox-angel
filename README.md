# Inbox Angel

Cloudflare Workers backend for [InboxAngel](https://github.com/Fellowship-dev/inbox-angel).
Self-hostable email authentication platform — DMARC monitoring, SPF management, MTA-STS provisioning, and TLS-RPT reporting, all running on your own Cloudflare account.

---

## What it does

Most domains start at `p=none` — DMARC is watching but not protecting. Getting to `p=reject` means spoofed email claiming to be from your domain gets blocked at delivery. But you can't flip that switch blindly: you need to know that all your legitimate senders are properly authenticated first.

InboxAngel collects DMARC aggregate reports from receiving mail servers worldwide and shows you exactly what's passing, what's failing, and where it's coming from. Once your pass rate is consistently high, the dashboard tells you it's safe to enforce. From there you can go further — SPF flattening, MTA-STS, TLS-RPT — but the core value is getting you from "I don't know" to `p=reject` without breaking your email.

### DMARC monitoring

Mail servers that receive email from your domain send daily XML reports back to InboxAngel. The Worker parses them, stores them in D1, and the dashboard shows trends, failing sources, pass rates, and policy guidance.

```
Receiving mail servers → XML aggregate report → rua@reports.yourdomain.com
  └── Cloudflare Email Worker receives it
        ├── Parses XML: sending IPs, pass/fail per SPF + DKIM + DMARC
        └── Stores in D1 → dashboard shows 30/60-day trends + guidance
```

When your pass rate is stable above 95%, the dashboard tells you it's time to tighten policy. It shows you the exact DNS record to update.

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

The button forks the repo, creates a D1 database, and prompts for your API token. That's it — one secret, zero env vars.

**Option B — CLI:**

```bash
npm install && npm install --prefix dashboard
wrangler secret put CLOUDFLARE_API_TOKEN  # the token you created above
npm run deploy
```

No `BASE_DOMAIN`, no `REPORTS_DOMAIN`, no zone IDs — the setup wizard handles all domain configuration after deploy.

---

### Step 2 — Create your account

Open your worker URL. On first visit you'll see a setup form — enter your email and a password.

---

### Step 3 — Set up your domain

After creating your account, the setup wizard walks you through five steps:

1. **Domain** — enter your domain (e.g. `yourdomain.com`). Zone ID and account ID are auto-resolved from the Cloudflare API.
2. **SPF** — checks your SPF record and lookup depth
3. **DKIM** — scans for DKIM selectors
4. **DMARC** — shows your current record and recommended changes. Can apply via Cloudflare DNS with one click.
5. **Routing** — sets up MX records and email routing. Registers your email as a verified destination so you can receive alerts and password resets.

Reports from receiving mail servers worldwide will start arriving within 24 hours. The dashboard shows your pass rate and tells you when it's safe to tighten policy toward `p=reject`.

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Compute | Cloudflare Workers | Edge runtime, zero cold start |
| Inbound email | Cloudflare Email Workers | Receives `*@reports.<BASE_DOMAIN>` |
| Outbound email | Cloudflare Email Workers | Sends digests and alerts |
| Storage | Cloudflare D1 | SQLite at the edge |
| DNS provisioning | Cloudflare DNS API | Per-domain auth records + SPF + MTA-STS |
| Auth | Email + password | Admin account created on first visit |
| Frontend | Embedded SPA | Built from `dashboard/`, served as static assets |

---

## Repository layout

The deployable Worker stays at the repo root so the Deploy to Cloudflare button (which clones the whole repo and builds from its root) keeps working with the plain root URL. Shared code lives in npm workspaces:

| Path | What |
|---|---|
| `src/`, `dashboard/`, `migrations/`, `test/`, `e2e/`, `scripts/`, `wrangler.jsonc`, `deploy.json` | The Worker app (root `package.json`) |
| `packages/*` | Workspace packages. `@inbox-angel/dns-checks` (pure SPF/DKIM/DMARC/MTA-STS/BIMI checks) is imported by name from the app and bundled by wrangler |
| `tools/*` | Offline tooling (`tools/audit-fleet`) |

**Why npm workspaces, not pnpm:** the Deploy button and most self-hosters already run `npm install` against a `package-lock.json`. npm needs no extra tool or corepack step, so it carries the least risk. pnpm can be revisited later.

## Local Development

```bash
npm install             # installs the root app, all workspaces and dashboard/
npm run dev:dashboard   # Vite dev server on :5173
npm run dev             # Worker on :8787 (wrangler dev)
npm test                # unit tests: test/ and packages/*/test
npm run typecheck       # tsc --noEmit (app) + tsc -p packages/dns-checks
npm run test:e2e        # Playwright against http://127.0.0.1:8787 (start `npm run dev` first)
```

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
