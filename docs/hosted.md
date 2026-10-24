# Hosted InboxAngel (`MODE=saas`)

How the hosted service routes reports, hands out records and verifies customers. Everything here applies only when
`MODE=saas` **and** `SAAS_ENABLED=1`. Self-host (`rua@reports.<base>`, your own Email Routing) is untouched.

> **Rollout warning: existing `MODE=saas` deployments.** Before this change `MODE=saas` inbound mail silently went to the default workspace. Now, without `SAAS_ENABLED=1` (and `INTAKE_DOMAIN`, `CANARY_DOMAIN`), **every inbound message makes the Worker throw**, so senders see temporary failures and retry. Set `SAAS_ENABLED=1`, `INTAKE_DOMAIN` and `CANARY_DOMAIN` *before* deploying this version, and apply migration 0014. Mail addressed without a valid token is rejected, not filed anywhere.

Contents: [Overview](#overview) · [Operator setup](#operator-setup) · [Customer setup](#customer-setup) · [How it works](#how-it-works) · [API](#api) · [Limits](#limits-and-quotas)

## Overview

| Piece | Address / name | Lives in |
|-------|----------------|----------|
| DMARC aggregate reports | `rua+<token>@rua.inboxangel.io` | Email Routing → this Worker |
| TLS-RPT reports | `tls-rpt+<token>@rua.inboxangel.io` | Email Routing → this Worker |
| Free check ("canary") | `check+<token>@canary.inboxangel.io` | Email Routing → this Worker |
| Hosted DMARC | `<id>._dmarc.h.inboxangel.io` TXT | the records zone |
| Hosted SPF (flattened) | `<id>._spf.h.inboxangel.io` TXT | the records zone |
| Hosted TLS-RPT | `<id>._tlsrpt.h.inboxangel.io` TXT | the records zone |
| Hosted MTA-STS | `mta-sts.<id>.h.inboxangel.io` TXT (`v=STSv1; id=…`) + proxied AAAA (policy host) | the records zone |

`<id>` is 16 random base32 characters, stored per domain and **never derived from the customer's domain**.
The token is 160 random bits (32 base32 characters), per domain, stored only as a SHA-256, rotatable.

## Operator setup

Nothing below is done by the code; it is what the deployment needs. Do it once.

### 1. Environment

In `wrangler.jsonc` `vars` (or the dashboard):

| Variable | Value | |
|----------|-------|-|
| `MODE` | `saas` | |
| `SAAS_ENABLED` | `1` | explicit opt-in; without it the API answers 503 and inbound mail is **deferred** (the Worker throws, senders retry) |
| `INTAKE_DOMAIN` | `rua.inboxangel.io` | |
| `CANARY_DOMAIN` | `canary.inboxangel.io` | |
| `HOSTED_RECORDS_ZONE` | `inboxangel.io` | zone that holds the hosted records |
| `HOSTED_RECORDS_LABEL` | `h` | the single label every hosted record lives under (default `h`) |
| `INTAKE_MAX_REPORTS_PER_DAY` | `50` | optional: reports accepted per intake token **per authenticated reporter domain** per UTC day (over-cap mail is rejected, nothing ingested). A message is attributed to a reporter by an aligned-looking `dkim`/`spf`/`dmarc` pass in its `Authentication-Results` header (checked before parsing) |
| `INTAKE_MAX_BYTES_PER_DAY` | `52428800` | optional: raw message bytes per token per authenticated reporter domain per UTC day (50 MiB) |
| `INTAKE_MAX_REPORTERS_PER_DAY` | `100` | optional: distinct authenticated reporter domains with their own slot per token per UTC day. Well-known reporters (google.com, yahoo.com, microsoft.com…) never use a slot; when the slots are full the least-used unknown reporter makes room instead of the new one being refused |
| `INTAKE_MAX_TOTAL_REPORTS_PER_DAY`, `INTAKE_MAX_TOTAL_BYTES_PER_DAY` | `1000`, 1 GiB | optional: a token's daily total across proven reporters that are not well known, so reporters coming and going through the slots cannot each bring a fresh allowance. Well-known reporters are outside it |
| `INTAKE_MAX_UNAUTH_REPORTS_PER_DAY` | `200` | optional: messages the receiver did not prove, per claimed sender domain (SMTP envelope sender) per token per UTC day. Unproven mail never uses a proven reporter's allowance |
| `INTAKE_MAX_UNAUTH_BYTES_PER_DAY` | `1073741824` | optional: raw bytes of one such bucket (1 GiB) |
| `INTAKE_MAX_UNAUTH_SENDERS_PER_DAY` | `50` | optional: claimed sender domains with their own bucket per token per day; the rest share one overflow bucket (never refused outright) |
| `AUTHSERV_ID`, `AUTHSERV_HEADER` | unset | the receiver's authserv-id and header kind (`ar`/`arc`), see docs/email-funnel.md. **Until both are set nothing is proven**: reports are still accepted, flagged `none` and charged to the unproven buckets above. The defaults are deliberately generous (genuine reporters send 1–2 reports a day) so a spoofed envelope sender needs ~200 messages a day to starve one reporter; setting the two variables removes that weakness |
| `INTAKE_MAX_RECORDS_PER_REPORT` | `20000` | optional: records in one aggregate report; checked before any per-record IP lookup |
| `INTAKE_MAX_NEW_IPS_PER_REPORT` | `50` | optional: uncached source IPs enriched (DNS/geo lookups) per report; further records are stored without enrichment |
| `HOSTED_MAX_DOMAINS_PER_WORKSPACE` | `10` | optional: domains per workspace that may use hosted records (enabling more answers 429) |

A report's `policy_published` domain must be the token's domain or a subdomain of it; it is filed under the token's domain, or under the subdomain's own row if the same workspace has that subdomain as a verified domain. Each stored report also records whether its
email passed DMARC-aligned authentication for the reporting organisation (`reporter_auth`: `pass`, `fail` or `none`).

Secret: `wrangler secret put HOSTED_RECORDS_TOKEN` (see [token scopes](#3-the-records-token)).

Apply migration `0014_hosted_intake.sql` (`npm run migrate`) before enabling anything.

### 2. Email Routing (inbound)

Subdomains cannot have a catch-all, so each base address gets **one rule**; the `+<token>` part is sub-addressing
that the Worker reads itself.

1. Enable Email Routing for the **subdomains** `rua.inboxangel.io` and `canary.inboxangel.io` (Email Routing → Settings → add subdomain; this adds their MX/SPF records).
2. Create custom addresses with action **Send to a Worker** → this Worker:

   | Address | |
   |---------|-|
   | `rua@rua.inboxangel.io` | DMARC |
   | `tls-rpt@rua.inboxangel.io` | TLS-RPT |
   | `check@canary.inboxangel.io` | free check |

3. Check it: send a mail to `rua+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@rua.inboxangel.io` and look for
   `[intake] rejected {"reason":"Unknown intake token",…}` in the Worker logs. If nothing arrives, Email Routing is not matching
   `+` sub-addresses for you; the rules above are then not enough and this needs revisiting (it cannot be tested from the repo).

### 3. The records token

`HOSTED_RECORDS_TOKEN` is separate from the deploy token, from `CLOUDFLARE_API_TOKEN` (self-host) and from any tenant credential.
Create it at *My Profile → API Tokens → Custom token*:

* **Zone → DNS → Edit**
* **Zone → Zone → Read** (the Worker looks the zone up by name)
* Zone Resources: **Include → Specific zone → `inboxangel.io`** (nothing else; no account permissions)

The writer refuses any record name outside `*.h.inboxangel.io` (and any type other than TXT/AAAA) before it makes a request, and
re-reads a record before changing or deleting it to be sure it sits at the expected hosted name. The token scope is the second fence, not the only one.

### 4. The records zone

* `inboxangel.io` on **Cloudflare Pro** (3,500 records; see [limits](#limits-and-quotas)). A free zone created since September 2024 holds only **200** records, which is about 40 domains with MTA-STS (5 records each) or 66 without (3 each) before the zone's existing records are counted, so it is not an option. (Free zones created earlier may still have the old 1,000-record limit; do not rely on it.)
* One-time authorisation record so receivers will send reports for *any* customer domain to `rua.inboxangel.io` (RFC 7489 §7.1, external destination verification).
  A wildcard covers every customer:

  ```
  *._report._dmarc.rua.inboxangel.io.   TXT   "v=DMARC1"
  ```

  Put it in the zone for `inboxangel.io` (outside `*.h.`, so the writer never touches it).
* MTA-STS policy hosts: the Worker serves `https://mta-sts.<id>.h.inboxangel.io/.well-known/mta-sts.txt` and
  `https://mta-sts.<customer domain>/.well-known/mta-sts.txt`. Add a Worker route `*.h.inboxangel.io/*`, and for the customer-hostname form
  use Cloudflare for SaaS (custom hostnames with a fallback origin) so `mta-sts.customer.com` gets a certificate.

### 5. Crons

The daily hosted job runs inside the existing `0 11 * * *` trigger (after the per-workspace work), so `wrangler.jsonc` needs no new trigger:

1. **Zone reconcile**: lists the whole records zone, stores the record count (quota), warns at 3,200, and diffs it against the database:
   expected records that are missing and records under `*.h.` that no domain owns are **reported, never fixed or deleted**.
   Records outside `*.h.` are only counted and fingerprinted; a change since yesterday is logged (`records outside h.inboxangel.io changed`). The job issues only `GET`s.
2. **MTA-STS MX refresh** for hosted domains (never publishes a policy with no MX hosts).
3. **SPF refresh**: re-flattens every hosted SPF from its stored source and updates the record if the providers' ranges moved. A source that cannot be fully resolved leaves the current record alone.
4. **Pointer verification** for every hosted domain.
5. Forgets expired canary addresses.

### Adding a second records zone later

`configuredZones()` in `src/hosted/zones.ts` is the only place that knows which zones exist, and each hosted domain stores its `zone_key`.
Returning a second `{ key, name }` makes new domains fill it once the first is full; the writer, quota logic and existing domains do not change. What a second zone still needs:
the pointer instructions name `h.<zone>` from config, so they must read the domain's own zone (`zoneSlot(env, zone_key)`), and `HOSTED_RECORDS_TOKEN` must cover it.

## Trust model: who can do what

**Email verification.** A hosted account has no session until its email is verified, and API keys of unverified users are refused. Sign-up sends a
link; login before verifying answers `403 email_not_verified` (and sends a fresh link). Verifying never signs anyone in: the password chosen
before the address was proven is discarded, every session of that user ends, and the person who clicked the link sets their own password (so
registering someone else's address gains nothing). An invite link alone does not grant membership: the invitee signs up (or in), verifies, and accepts while
signed in as the invited address. First OAuth link ends the user's other sessions.

**Bot check (required).** Hosted sign-up fails closed (503) unless `TURNSTILE_SECRET_KEY` is set; `TURNSTILE_SITE_KEY` is the public key served to the sign-up page. OAuth logins link to an
existing account only when both the local account's email and the provider's are verified, and an OAuth sign-up matches a
pending invite only on a provider-verified email. Verification mail uses the platform sender (`from_email` setting of the
default workspace) over `SEND_EMAIL`; without it the link is written to the Worker log. Self-host is unchanged: the owner
is marked verified at setup.

**Domain ownership.** A domain a workspace adds is a *claim* (`domain_claims`) until proven; it is not in `domains`, so
it has no reports, stats, check results, hosted records or DNS writes, and it never blocks another workspace. It is
verified by any of: (a) its zone is on the allow-list of one of the workspace's active Cloudflare connections, (b) the
workspace already verified a parent domain, (c) the TXT record `_inboxangel.<domain>` holds `inboxangel-verify=<token>`
(the "Verify" button re-checks). The first workspace to verify owns the name; other pending claims on it become `lost`.
A workspace may hold 25 pending claims. Domains that existed before this feature are `verified_via=legacy`: they keep working for their holder, but never block a verified claim — a successful TXT, Cloudflare or parent proof evicts the legacy holder (audit-logged as `domain.evicted`), and a legacy domain proves nothing about its subdomains. The Cloudflare proof re-checks the zone with Cloudflare at verify time (must still be active and have the same name).

**Roles.** Owners and admins manage; members are read-only. Only owners can invite admins. Owners and admins list
(`GET /api/team/invites`) and revoke (`DELETE /api/team/invites/:id`) pending invites; removing a member revokes the
invites they sent.

**Browser session.** The dashboard authenticates with an HttpOnly, SameSite=Lax (Secure on https) cookie; browsers are never
sent the session token. Scripts and API keys use bearer tokens (`X-Api-Key`).

**Not available when hosted:** `POST /api/setup/email-routing`, `/api/setup/custom-domain`, `/api/settings/register-destination`
(they act on a whole Cloudflare account and are self-host setup steps).

## Customer setup

Enable hosted records for a domain (dashboard, or `POST /api/domains/:id/hosted`). The response shows the intake addresses **once**; they are already
published in the hosted records. Then the customer adds pointers in their own DNS, and nothing else, ever:

| Record | Name | Value |
|--------|------|-------|
| CNAME | `_dmarc.customer.com` | `<id>._dmarc.h.inboxangel.io` |
| TXT (edit the existing SPF) | `customer.com` | add `include:<id>._spf.h.inboxangel.io` |
| CNAME | `_smtp._tls.customer.com` | `<id>._tlsrpt.h.inboxangel.io` |
| CNAME *(only if MTA-STS is hosted)* | `_mta-sts.customer.com` | `mta-sts.<id>.h.inboxangel.io` |
| CNAME *(only if MTA-STS is hosted)* | `mta-sts.customer.com` | `mta-sts.<id>.h.inboxangel.io` |

Notes for the customer:

* **SPF:** keep a single `v=spf1` record. Replace the includes InboxAngel flattened with `include:<id>._spf.h.inboxangel.io`; the hosted record is built from the SPF
  the domain published when hosting was enabled (or the `spf_record` given then) and carries no DNS lookups of its own beyond what could not be flattened.
* **DMARC:** the hosted record starts at the domain's stored policy (`p=none` by default). Moving a hosted domain through the rollout steps (`rollout-advance`) does not rewrite the hosted record yet.
* A `CNAME` cannot sit next to other records at the same name. If `_dmarc.customer.com` already has a TXT, remove it when adding the CNAME.
* InboxAngel checks the pointers daily and on demand (`POST …/hosted/verify`). Each is `ok`, `missing`, `wrong` (something else is there) or `error` (could not be read; the previous status is kept).
  A hosted record counts toward the domain's **Level** only once its pointer is `ok` (`level_inputs` in the status response).
* Token rotation (`POST …/hosted/rotate-token`) edits the hosted records; the customer changes nothing. The previous token keeps being accepted for 72 hours.

## How it works

**Inbound mail** (`src/hosted/intake.ts`): the Worker parses `base+tag@host`.

1. `rua+`/`tls-rpt+` at `INTAKE_DOMAIN`: the tag is hashed and looked up (`intake_tokens`); it resolves to workspace + domain. The `TenantContext` is built for that workspace. **There is no default-workspace fallback in `saas`**: `resolveInboundWorkspace` throws.
2. The report is parsed with the existing parsers (gzip, zip, plain), capped at 25 MiB for the message and 25 MiB decompressed. Inflation runs in ~1 KB input slices with the running total checked after each, so a hostile gzip is stopped near the cap instead of after a full inflate. A zip must hold at most 2 entries; only its first `.xml`/`.json` entry is read.
3. The report's own domain (`policy_published.domain`, TLS-RPT `policy-domain`) must be the **token's domain or one of its subdomains** (registrable-domain aware; a public suffix never matches) and is filed under the token's domain (or under the subdomain's own row when the same workspace has it verified). Any other domain is rejected for good and nothing is stored, **including another domain of the same workspace**. Subdomains need no registration of their own.
4. `check+` at `CANARY_DOMAIN`: see below.

| Outcome | Behaviour |
|---------|-----------|
| unknown/expired token, malformed token, unknown base address or host | `setReject` (permanent 5xx), logged `[intake] rejected {reason, …}` |
| report for a domain the workspace does not own (spoof) | `setReject`, logged with the workspace |
| malformed or oversized attachment, no policies in a TLS-RPT | `setReject`, logged |
| schema not migrated, or hosted env missing | the Worker **throws**: the sender retries later and the report is not lost |

**Canary:** `POST /api/check-sessions` issues `check+<token>@canary.inboxangel.io`, valid for 1 hour and one email (hash stored). The email resolves to an anonymous session (`__anonymous__`, no workspace, no rows),
the fixed free-check reply is sent, and the result lands in the global `check_results` where the browser polls it by the same token (`GET /api/check-sessions/:token`).
Free-check senders are also enrolled in the onboarding sequence and every non-transactional email carries an unsubscribe link: see [email-funnel.md](email-funnel.md).
Rate limits (shared `auth_rate_limits` counters, 1-hour windows): 5 per **authenticated** sender domain (a passing DMARC/DKIM/SPF result in the `Authentication-Results` header Cloudflare adds, reduced to its registrable domain), 20 for senders that authenticate as nothing (one shared bucket), and 500 overall. The `From` header is never used as a key, so a spoofed From cannot use up a real domain's allowance; the cost of that is that unauthenticated senders compete for one small bucket.

**MTA-STS host** (`src/hosted/policy-host.ts`): `mta-sts.<id>.h.<zone>` → the tenant whose hosted id is `<id>`; `mta-sts.<customer domain>` → the tenant hosting that domain; anything else 404. Never the implicit workspace in `saas`.

## API

All under `/api/domains/:id/hosted`, authenticated like every other route and scoped to the caller's workspace (another workspace's domain id is a `404`). Writes need an owner/admin; members can `GET`.
`404` when hosted mode is off.

| Method & path | Body | Response |
|---------------|------|----------|
| `GET /api/domains/:id/hosted` | | `{ enabled: false }` or a **status** |
| `POST /api/domains/:id/hosted` | `{ spf_record?: string, mta_sts?: boolean }` | `201 { hosted: <status>, addresses: { rua, tls_rpt } }`. Addresses are shown once |
| `DELETE /api/domains/:id/hosted` | | `{ ok: true }`; removes the hosted records |
| `POST /api/domains/:id/hosted/rotate-token` | | `{ addresses: { rua, tls_rpt } }` (shown once) |
| `POST /api/domains/:id/hosted/verify` | | a **status**, after checking the pointers now |

**Status:**

```jsonc
{
  "enabled": true,
  "hosted_id": "k3j2h4g5f6d7s8a9",
  "mta_sts": true,
  "records": { "dmarc": "<id>._dmarc.h.inboxangel.io", "spf": "…", "tls_rpt": "…", "mta_sts": "mta-sts.<id>.h.inboxangel.io" },
  "pointers": [ { "purpose": "dmarc", "type": "CNAME", "name": "_dmarc.customer.com", "value": "<id>._dmarc.h.inboxangel.io" }, … ],
  "pointer_status": { "dmarc": "ok", "spf": "missing", "mta_sts": null, "tls_rpt": "wrong", "checked_at": 1800000000 },
  "level_inputs": { "dmarc_published": true, "spf_published": false, "mta_sts_published": false }
}
```

MTA-STS on a hosted domain: `POST /api/domains/:id/mta-sts` answers `409` (use `mta_sts: true` above); `PATCH` (mode, `refresh_mx`) and `DELETE` act on the hosted records through the hosted writer (`DELETE` removes only the MTA-STS records); the legacy daily MX job skips hosted domains and the hosted daily job refreshes them. `DELETE /api/domains/:id` removes the hosted records and quota first; if that DNS cleanup fails the domain is **not** deleted (`502`).

Errors: `409` already enabled · `422` SPF cannot be resolved, no MX for MTA-STS, several SPF records · `502` Cloudflare/DNS failure · `507` records zone full.
Enabling is all-or-nothing: if Cloudflare fails part-way, the records already written are removed.

`POST /api/check-sessions` (public) returns `{ token, email, expires_at }` in `saas` (`email` is the `check+…@canary…` address).

## Data retention

The hosted service stores no raw report XML (`RAW_XML_RETENTION_DAYS=0` is the hosted default) and deletes aggregate data after 13 months. The full table, the environment variables and what a deleted workspace or account takes with it are in [data-retention.md](data-retention.md).

## Limits and quotas

| | |
|-|-|
| Records per hosted domain | 3 (DMARC, SPF, TLS-RPT), 5 with MTA-STS |
| Zone limit | 3,500 on Pro, about 700 domains at 5 records each or 1,160 at 3 (counts **every** record in the zone, including the ones that are not hosted); warning logged from 3,200; enabling is refused (`507`) if the records would not fit |
| Report size | 25 MiB raw and 25 MiB decompressed |
| Token rotation grace | 72 h |
| Canary | 1 hour, one email; 5 per authenticated sender domain, 20 unauthenticated, 500 overall, per hour |
