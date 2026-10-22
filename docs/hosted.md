# Hosted InboxAngel (`MODE=saas`)

How the hosted service routes reports, hands out records and verifies customers. Everything here applies only when
`MODE=saas` **and** `SAAS_ENABLED=1`. Self-host (`rua@reports.<base>`, your own Email Routing) is untouched.

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

* `inboxangel.io` on **Cloudflare Pro** (3,500 records; see [limits](#limits-and-quotas)). Free is 1,000 and would fill after ~200 domains.
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

The daily hosted job runs inside the existing `0 11 * * *` trigger (after the per-account work), so `wrangler.jsonc` needs no new trigger:

1. **Zone reconcile**: lists the whole records zone, stores the record count (quota), warns at 3,200, and diffs it against the database:
   expected records that are missing and records under `*.h.` that no domain owns are **reported, never fixed or deleted**.
   Records outside `*.h.` are only counted and fingerprinted; a change since yesterday is logged (`records outside h.inboxangel.io changed`). The job issues only `GET`s.
2. **Pointer verification** for every hosted domain.
3. Forgets expired canary addresses.

### Adding a second records zone later

`configuredZones()` in `src/hosted/zones.ts` is the only place that knows which zones exist, and each hosted domain stores its `zone_key`.
Returning a second `{ key, name }` makes new domains fill it once the first is full; the writer, quota logic and existing domains do not change. What a second zone still needs:
the pointer instructions name `h.<zone>` from config, so they must read the domain's own zone (`zoneSlot(env, zone_key)`), and `HOSTED_RECORDS_TOKEN` must cover it.

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

1. `rua+`/`tls-rpt+` at `INTAKE_DOMAIN`: the tag is hashed and looked up (`intake_tokens`); it resolves to account + domain. The `TenantContext` is built for that account. **There is no default-account fallback in `saas`**: `resolveInboundAccount` throws.
2. The report is parsed with the existing parsers (gzip, zip, plain), capped at 25 MiB for the message and 25 MiB decompressed (the cap applies while inflating, so a small gzip bomb is stopped).
3. The report's own domain (`policy_published.domain`, TLS-RPT `policy-domain`) must belong to **that account**, resolved through the account-scoped query. Otherwise the whole report is rejected and nothing is stored.
4. `check+` at `CANARY_DOMAIN`: see below.

| Outcome | Behaviour |
|---------|-----------|
| unknown/expired token, malformed token, unknown base address or host | `setReject` (permanent 5xx), logged `[intake] rejected {reason, …}` |
| report for a domain the account does not own (spoof) | `setReject`, logged with the account |
| malformed or oversized attachment, no policies in a TLS-RPT | `setReject`, logged |
| schema not migrated, or hosted env missing | the Worker **throws**: the sender retries later and the report is not lost |

**Canary:** `POST /api/check-sessions` issues `check+<token>@canary.inboxangel.io`, valid for 1 hour and one email (hash stored). The email resolves to an anonymous session (`__anonymous__`, no account, no rows),
the fixed free-check reply is sent, and the result lands in the global `check_results` where the browser polls it by the same token (`GET /api/check-sessions/:token`).
Rate limit: 5 checks per sender domain per hour (shared `auth_rate_limits` counters). Note the From domain is what the sender claims; the limit is a cost guard, not an identity check.

**MTA-STS host** (`src/hosted/policy-host.ts`): `mta-sts.<id>.h.<zone>` → the tenant whose hosted id is `<id>`; `mta-sts.<customer domain>` → the tenant hosting that domain; anything else 404. Never the implicit account in `saas`.

## API

All under `/api/domains/:id/hosted`, authenticated like every other route and scoped to the caller's account (another account's domain id is a `404`). Writes need an owner/admin; members can `GET`.
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

Errors: `409` already enabled · `422` SPF cannot be resolved, no MX for MTA-STS, several SPF records · `502` Cloudflare/DNS failure · `507` records zone full.
Enabling is all-or-nothing: if Cloudflare fails part-way, the records already written are removed.

`POST /api/check-sessions` (public) returns `{ token, email, expires_at }` in `saas` (`email` is the `check+…@canary…` address).

## Limits and quotas

| | |
|-|-|
| Records per hosted domain | 3 (DMARC, SPF, TLS-RPT), 5 with MTA-STS |
| Zone limit | 3,500 on Pro (counts **every** record in the zone); warning logged from 3,200; enabling is refused (`507`) if the records would not fit |
| Report size | 25 MiB raw and 25 MiB decompressed |
| Token rotation grace | 72 h |
| Canary | 1 hour, one email; 5 per sender domain per hour |
