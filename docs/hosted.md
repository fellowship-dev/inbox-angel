# Hosted InboxAngel (`MODE=saas`)

How the hosted service routes reports, hands out records and verifies customers. Everything here applies only when
`MODE=saas` **and** `SAAS_ENABLED=1`. Self-host (`rua@reports.<base>`, your own Email Routing) is untouched.

> **Rollout warning: existing `MODE=saas` deployments.** Before this change `MODE=saas` inbound mail silently went to the default workspace. Now, without `SAAS_ENABLED=1` (and `INTAKE_DOMAIN`, `CANARY_DOMAIN`), **every inbound message makes the Worker throw**, so senders see temporary failures and retry. Set `SAAS_ENABLED=1`, `INTAKE_DOMAIN` and `CANARY_DOMAIN` *before* deploying this version, and run `npm run migrate`. Mail addressed without a valid token is rejected, not filed anywhere.

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

| Variable | Default / value | |
|----------|-------|-|
| `MODE` | `saas` | |
| `SAAS_ENABLED` | `1` | explicit opt-in; without it the API answers 503 and inbound mail is **deferred** (the Worker throws, senders retry) |
| `INTAKE_DOMAIN` | `rua.inboxangel.io` | |
| `CANARY_DOMAIN` | `canary.inboxangel.io` | |
| `HOSTED_RECORDS_ZONE` | `inboxangel.io` | zone that holds the hosted records |
| `HOSTED_RECORDS_LABEL` | `h` | the single label every hosted record lives under (default `h`) |
| `INTAKE_MAX_REPORTS_PER_DAY` | `50` | reports per intake token **per proven reporter domain** per UTC day (over-cap mail is refused, nothing ingested). A message is attributed to a reporter by an aligned `dkim`/`dmarc` pass in its `Authentication-Results` header (checked before parsing) |
| `INTAKE_MAX_BYTES_PER_DAY` | `52428800` | raw message bytes per token per proven reporter domain per UTC day (50 MiB) |
| `INTAKE_MAX_REPORTERS_PER_DAY` | `100` | distinct proven reporter domains with their own slot per token per UTC day. Well-known reporters (google.com, microsoft.com…) never use a slot; when the slots are full the least-used unknown reporter makes room |
| `INTAKE_MAX_TOTAL_REPORTS_PER_DAY`, `INTAKE_MAX_TOTAL_BYTES_PER_DAY` | `1000`, 1 GiB | a token's daily total across proven reporters that are not well known |
| `INTAKE_MAX_UNAUTH_REPORTS_PER_DAY` | `10` | messages the receiver did not prove, per claimed sender domain (SMTP envelope sender) per token per UTC day |
| `INTAKE_MAX_UNAUTH_BYTES_PER_DAY` | `26214400` | raw bytes of one such bucket (25 MiB) |
| `INTAKE_MAX_UNAUTH_SENDERS_PER_DAY` | `5` | claimed sender domains with their own bucket per token per day; the rest share one overflow bucket |
| `INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY` | `25` | **all** unproven messages to one address per day, whatever sender they claim (a forger can claim any domain) |
| `INTAKE_MAX_UNAUTH_RECORDS_PER_REPORT` | `1000` | records in a report whose sender was not proven |
| `INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY` | `500` | messages to one report address per UTC day, proven or not |
| `INTAKE_MAX_ADDRESS_RECORDS_PER_DAY` | `200000` | records stored for one report address per UTC day |
| `INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY` | `2000` | messages to one workspace per UTC day |
| `INTAKE_MAX_WORKSPACE_RECORDS` | `1000000` | report records one workspace may hold at once (13 months of data) |
| `INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY` | `50000` | messages to the whole instance per UTC day |
| `INTAKE_MAX_INSTANCE_RECORDS` | `10000000` | report records the whole instance may hold, so the shared D1 (10 GB limit) cannot be filled by one tenant or by all of them |
| `INTAKE_MAX_RECORDS_PER_REPORT` | `2000` | records in one aggregate report, checked before any per-record work (self-host default 2,500; see [Measured limits](#measured-limits)) |
| `INTAKE_MAX_DECOMPRESSED_BYTES` | `1048576` | a report once decompressed (1 MiB; self-host 1.25 MiB; at most 25 MiB) |
| `INTAKE_MAX_RAW_BYTES` | `2097152` | the raw message (2 MiB; at most Cloudflare's own 25 MiB). A report that fits the decompressed cap is a few hundred KB compressed |
| `INTAKE_MAX_NEW_IPS_PER_REPORT` | `50` | uncached source IPs enriched (DNS-over-HTTPS) per report, busiest first; the rest are stored without enrichment |
| `INTAKE_MAX_STORAGE_RETRIES_PER_DAY` | `20` | storage failures per domain per day after which a failing message is refused for good instead of being retried |
| `REPORT_COUNTING` | `proven` | `proven` or `all`: which stored reports feed pass rates, failing senders, anomalies, "safe to enforce", levels, digests and the MCP report. Hosted default `proven`; self-host default `all` ([proven reports](#proven-reports-and-what-counts)) |
| `AUTHSERV_ID`, `AUTHSERV_HEADER` | unset | the receiver's authserv-id and header kind (`ar`/`arc`); see [AUTHSERV discovery](#authserv-discovery). **Until both are set nothing is proven**: reports are accepted and stored, flagged `none`, and **not counted** in any number |
| `INTAKE_TRUSTED_REPORTER_ADDRESSES` | unset | comma-separated exact From addresses of report senders on shared-mailbox domains (yahoo.com, outlook.com, gmail.com…); see below |
| `RETENTION_INTAKE_COUNTERS_DAYS`, `RETENTION_INTAKE_FAILURES_DAYS` | `8`, `90` | how long the daily counters and the "could not be processed" markers are kept |
| `HOSTED_MAX_DOMAINS_PER_WORKSPACE` | `10` | optional: domains per workspace that may use hosted records (enabling more answers 429) |

A report's `policy_published` domain must be the token's domain or a subdomain of it; it is filed under the token's domain, or under the subdomain's own row if the same workspace has that subdomain as a verified domain. Each stored report also records whether its
email passed DMARC-aligned authentication for the reporting organisation (`reporter_auth`: `pass`, `fail` or `none`).

Secret: `wrangler secret put HOSTED_RECORDS_TOKEN` (see [token scopes](#3-the-records-token)).

Apply the current migrations with `npm run migrate` before enabling anything. Hosted intake tables are included in the current baseline; trust and access updates are additive migrations.

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
   `{"evt":"intake",…,"outcome":"refused","reason":"unknown_token",…}` in the Worker logs (`wrangler tail --format json`). If nothing arrives, Email Routing is not matching
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

### 6. Plan, DNS preview limiter and caps

**Workers Paid plan.** A hosted instance needs the Workers Paid plan. The claim preview (`GET /api/domains/claims/:id/preview`) answers from public DNS over DNS-over-HTTPS, and one preview costs 40 to 45 subrequests for the domains measured below, and up to about 53 for a domain whose SPF record uses all 10 allowed lookups: the SPF walk, the DMARC lookup (one more when it falls back to the organizational domain), 36 DKIM selectors, and the MX lookup, plus one random-name lookup when the DKIM selectors all answer alike (it tells a wildcard from one real key published under several selectors). The Workers free plan allows 50 subrequests per invocation, so a domain with a longer SPF chain can fail there, and the Worker's other requests in the same invocation count too. Paid raises the limit to 10,000.

Measured with `npx tsx scripts/measure-preview-subrequests.ts <domain>...` (the fetches `previewClaimDns` makes against Cloudflare DoH, 2026-11-13):

| Domain | Subrequests | What it did |
|--------|-------------|-------------|
| google.com | 40 | SPF 1 lookup, DMARC, 36 DKIM selectors, MX |
| gov.uk | 40 | no SPF lookups, DMARC, 36 DKIM selectors (all answered alike), 1 random-name probe (answered alike too: a wildcard), no MX |
| salesforce.com | 41 | SPF 4 lookups |
| hubspot.com | 43 | SPF 4 lookups |
| microsoft.com | 45 | SPF 6 lookups |

**`DNS_PREVIEW_LIMITER` binding.** The preview is limited to 10 per person per minute (a cached answer does not count). The limit is a Workers ratelimit binding named `DNS_PREVIEW_LIMITER` (in `wrangler.jsonc`: `"type": "ratelimit"`, `"simple": { "limit": 10, "period": 60 }`), shared by every isolate. Without it the Worker falls back to a counter kept inside one isolate, which another isolate does not see, so the limit is not reliable at scale. A `MODE=saas` Worker without the binding logs one warning per isolate on first use (`[claim-preview] DNS_PREVIEW_LIMITER binding missing: …`), and the instance owner's setup check (**Settings → Instance**, `GET /api/instance/preflight`) lists it as action needed, together with any other missing ratelimit binding (see [Ratelimit bindings](#ratelimit-bindings)). Nobody else sees the check, and on the hosted service nobody sees it at all unless `OWNER_EMAIL` is set to a verified account.

### Ratelimit bindings

A hosted Worker needs all six ratelimit bindings below. A missing one fails open (that limit does not apply), except that `/mcp` answers 503 without `MCP_LIMITER` and `API_LIMITER`; the owner's setup check lists every missing one. Each launch config (the three `wrangler` configs used to deploy an instance) needs exactly these entries under `"unsafe": { "bindings": [ … ] }`. `namespace_id` must be a positive integer unique within the Cloudflare account; the values below are the repository's and can be reused when each instance lives in its own account, otherwise give each instance its own numbers.

```jsonc
{ "name": "AUTH_LIMITER",        "type": "ratelimit", "namespace_id": "1001", "simple": { "limit": 10,  "period": 60 } }, // sign-in, sign-up; /oauth/register per IP (own key)
{ "name": "API_LIMITER",         "type": "ratelimit", "namespace_id": "1002", "simple": { "limit": 200, "period": 60 } }, // /api per IP; agent requests per workspace
{ "name": "DNS_PREVIEW_LIMITER", "type": "ratelimit", "namespace_id": "1003", "simple": { "limit": 10,  "period": 60 } }, // claim DNS preview per person
{ "name": "MCP_LIMITER",         "type": "ratelimit", "namespace_id": "1004", "simple": { "limit": 100, "period": 60 } }, // agent requests per connection
{ "name": "OAUTH_TOKEN_LIMITER", "type": "ratelimit", "namespace_id": "1005", "simple": { "limit": 600, "period": 60 } }, // /oauth/token per IP
{ "name": "MCP_ANON_LIMITER",    "type": "ratelimit", "namespace_id": "1006", "simple": { "limit": 60,  "period": 60 } }  // /mcp without a token, per IP
```

`OAUTH_TOKEN_LIMITER`, `MCP_ANON_LIMITER` and `MCP_LIMITER` are new with the agent limits; launch configs derived before them have only the first three. See [agent limits](agent-operations.md#agents-page-limits-and-the-setup-check).

**Plan caps.** Variables in `wrangler.jsonc` `vars`, hosted mode only (self-host has no caps):

| Variable | Default | |
|----------|---------|-|
| `MAX_WORKSPACES_PER_USER` | `5` | workspaces one person may own; workspaces they were only invited to do not count, and a hand-over of ownership counts like a new workspace |
| `MAX_DOMAINS_PER_WORKSPACE` | `10` | domains one workspace may hold; a value that is not a positive integer keeps the default |

### Adding a second records zone later

`configuredZones()` in `src/hosted/zones.ts` is the only place that knows which zones exist, and each hosted domain stores its `zone_key`.
Returning a second `{ key, name }` makes new domains fill it once the first is full; the writer, quota logic and existing domains do not change. What a second zone still needs:
the pointer instructions name `h.<zone>` from config, so they must read the domain's own zone (`zoneSlot(env, zone_key)`), and `HOSTED_RECORDS_TOKEN` must cover it.

## Trust model: who can do what

**Email verification.** A hosted account has no session until its email is verified, and delegated credentials of unverified human users are refused. Sign-up sends a
link; login before verifying answers `403 email_not_verified` (and sends a fresh link). Verifying never signs anyone in: the password chosen
before the address was proven is discarded, every session of that user ends, and the person who clicked the link sets their own password (so
registering someone else's address gains nothing). An invite link alone does not grant membership: the invitee signs up (or in), verifies, and accepts while
signed in as the invited address. First OAuth link ends the user's other sessions.

**Bot check (required).** Hosted sign-up fails closed (503) unless `TURNSTILE_SECRET_KEY` is set; `TURNSTILE_SITE_KEY` is the public key served to the sign-up page. OAuth logins link to an
existing account only when both the local account's email and the provider's are verified, and an OAuth sign-up matches a
pending invite only on a provider-verified email. Verification mail uses the platform sender (`from_email` setting of the
default workspace) over `SEND_EMAIL`; without it nothing is sent and the Worker log records only a static reason (never the link or address). Self-host is unchanged: the owner
is marked verified at setup.

**Domain ownership.** A domain a workspace adds is a *claim* (`domain_claims`) until proven; it is not in `domains`, so
it has no reports, stats, check results, hosted records or DNS writes, and it never blocks another workspace. It is
verified by any of: (a) its zone is on the allow-list of one of the workspace's active Cloudflare connections, (b) the
workspace already verified a parent domain, (c) the TXT record `_inboxangel.<domain>` holds `inboxangel-verify=<token>`
(the "Verify" button re-checks). The first workspace to verify owns the name; other pending claims on it become `lost`. A claim that became a domain is kept, hidden, for one day (`settled_at`), so a repeat of its verify answers `200` with the domain; the daily retention job deletes it after that.
A workspace may hold 25 pending claims. Domains that existed before this feature are `verified_via=legacy`: they keep working for their holder, but never block a verified claim — a successful TXT, Cloudflare or parent proof evicts the legacy holder (audit-logged as `domain.evicted`), and a legacy domain proves nothing about its subdomains. The Cloudflare proof re-checks the zone with Cloudflare at verify time (must still be active and have the same name).

**Roles.** Owners and admins manage; members are read-only. Only owners can invite admins. Owners and admins list
(`GET /api/team/invites`) and revoke (`DELETE /api/team/invites/:id`) pending invites; removing a member revokes the
invites they sent.

**Browser session.** The dashboard authenticates with an HttpOnly, SameSite=Lax (Secure on https) cookie; browsers are never
sent the session token. Unattended products use named service principals and finite grants with hashed `ias_…` credentials (`X-Api-Key` or bearer); the legacy broad key contract is retired. Browser agents use this installation's OAuth consent. Product/credential and Google Postmaster administration require an owner session. See [agent operations](agent-operations.md).

**Not available when hosted:** `POST /api/setup/email-routing`, `/api/setup/custom-domain`, `/api/settings/register-destination`
(they act on a whole Cloudflare account and are self-host setup steps).

## Customer setup

A new hosted customer registers, verifies their email and enrolls/proves their domain in their own workspace. They do not run the self-host base-domain setup wizard. Retrying enrollment resumes the durable pending claim. Agent/plugin access uses the same installation endpoint and finite consent as self-host; it does not activate public signup or prove that deployment/provider acceptance has completed. Google Postmaster is a separate owner connection. See [agent operations](agent-operations.md).

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
2. **Caps first, before any parsing**: per address, workspace and instance (below). A message over a cap costs a handful of queries and is refused.
3. The report is parsed (gzip, zip, plain), limited in size, records and fields (below). Inflation runs in ~1 KB input slices with the running total checked after each, so a hostile gzip is stopped near the cap instead of after a full inflate. A zip must hold at most 2 entries; only its first `.xml`/`.json` entry is read. A `<!DOCTYPE` or `<!ENTITY` is refused before the parser runs (a DMARC report has neither); the five standard XML escapes still work.
4. The report's own domain (`policy_published.domain`, TLS-RPT `policy-domain`) must be the **token's domain or one of its subdomains** (registrable-domain aware; a public suffix never matches) and is filed under the token's domain (or under the subdomain's own row when the same workspace has it verified). Any other domain is rejected for good and nothing is stored, **including another domain of the same workspace**.
5. A report already stored (same domain and report id) is accepted and ignored **before any enrichment**: one query, no second report, no records or stored-records counters added.
6. `check+` at `CANARY_DOMAIN`: see below.

### What the sender is told, and what the owner sees

| Outcome | Behaviour |
|---------|-----------|
| bad or unknown recipient, host, token; a gzip with an oversized header; no attachment; not a report; invalid XML/JSON; too large, too many records, a field too long, absurd dates; a domain the token does not own; a TLS-RPT report sent to the rua address (or the reverse) | `setReject`: a permanent 5xx **in the SMTP session** (no backscatter), with a specific reason |
| over a daily cap, or the workspace/instance holds its record cap | `setReject` too (a retry the same day cannot succeed and only adds load; real reporters send again tomorrow) **and** a counter row the owner sees: "Report storage limit reached; newer reports are not being stored" |
| D1 failed while storing a valid report | the Worker **throws** (the delivery fails, the sender may retry; one transaction, so nothing half-written) and the failure is counted for the owner ("N reports received for this domain could not be processed"). After `INTAKE_MAX_STORAGE_RETRIES_PER_DAY` failures for a domain the message is refused for good instead. **Cloudflare does not document what an uncaught throw tells the sender**, so retry is never the only record of a failure |
| schema not migrated, or hosted env missing | the Worker throws (deployment problem, not the sender's) |
| a report already stored | accepted, nothing stored again |

A report that could not be processed is never shown as "no reports": the dashboard fields `intake` and `uncounted` (see [API fields](#api-fields-for-the-dashboard)) say so.

### Query budget

D1 allows 1,000 queries per Worker invocation on Workers Paid and 50 on Free; "a `db.batch()` call counts as a single query" and a batch is a transaction (all statements commit or none)
(<https://developers.cloudflare.com/d1/platform/limits/>, <https://developers.cloudflare.com/d1/worker-api/d1-database/>, read 2026-11-14). A report now costs a **fixed** number of queries however many records it has:

| Step | Queries |
|------|---------|
| schema check (cold isolate only), token lookup, caps (one batch), tenant load, domain lookup, duplicate check | ~11 |
| IP cache read (all IPs, `json_each`, one batch) and write (one batch) | 2 |
| the report, its records and the counters (one batch) | 1 |
| first-report notification check (first counted report only) | up to 4 |

Measured with the counting binding in `test/helpers/counting-d1.ts` (`prepare().first/all/run/raw` = 1, `batch()` = 1, refusing past the limit): **16 queries for 1, 5,000 and 20,000 records** (the tests raise the caps to reach those sizes) (before: 15 for one record, **5,058 for 5,000**: the report was lost or the delivery failed on every retry). The tests assert ≤ 40 for any allowed report and that 5,000 records also fit the Free plan's 50.
Records travel as JSON text in a bound parameter read by `json_each()`, cut so that every bound value is at most 1,000,000 bytes (D1 allows 2,000,000), every statement is a short fixed text (D1: 100,000 bytes, 100 bound parameters), and a batch holds at most ~32 statements even for the widest possible rows (`test/hosted/store-chunks.test.ts`).

### Proven reports and what counts

A report is **proven** when its email proved the organisation it names, as Cloudflare's inbound processing saw it:

1. `AUTHSERV_ID` and `AUTHSERV_HEADER` are set (otherwise nothing is proven).
2. The header read is the **topmost** `Authentication-Results` (`AUTHSERV_HEADER=ar`) or the topmost `ARC-Authentication-Results` with `i=1` (`arc`), taken from the raw message (`Headers.get` joins duplicates). The other kind is never consulted. Its authserv-id must equal `AUTHSERV_ID`.
3. It shows a `dkim=pass` whose `header.d` is aligned (same organisational domain) with the **reporter domain**, or a `dmarc=pass` for it. SPF alone never proves.
4. The **reporter domain comes from the report, not from the mail**: the domain of `report_metadata/email`, else a domain-shaped `org_name`. If both are present and differ, the report is not proven. A forger who authenticates as her own domain `evil.example` is therefore proven as `evil.example` and can never be `google.com`.
5. **Shared-mailbox domains** (yahoo.com, outlook.com, hotmail.com, gmail.com, icloud.com, gmx.*, proton.*, amazonses.com… the list is `SHARED_MAILBOX_DOMAINS` in `src/dmarc/reporter-auth.ts`) are different: anyone can get a mailbox there and send DKIM-signed mail as that domain. A pass for them proves the reporter **only if the message's From header is exactly a trusted report-sender address of that organisation**. There is **no built-in address**: no provider documents the From address of its report mail with enough certainty to ship it here (google.com and microsoft.com are not shared-mailbox domains and need none). Add the ones you see on real report mail: `INTAKE_TRUSTED_REPORTER_ADDRESSES="noreply@dmarc.yahoo.com,…"` (exact addresses, case-insensitive; a random mailbox on the same domain is never proven). Until then those reporters are stored and listed under "not counted".

Stored with each report: `reporter_auth` (`pass`, `fail`, `none`), `reporter_auth_domain` (who it was proven as) and `reporter_auth_reason` (`authserv_not_configured`, `no_results_header`, `no_reporter_domain`, `org_mismatch`, `authserv_id_not_found`, `not_aligned`, `shared_mailbox_domain`).

**What counts.** `REPORT_COUNTING=proven` (hosted default): only `reporter_auth = 'pass'` reports feed pass rates, failing senders and fix lists, anomalies, "safe to enforce" and the rollout gate, levels, the weekly digest, the CSV totals, the MCP/health report and every other number computed in `packages/db/src/queries/{reports,analytics}.ts`. Reports stored before this column existed (`NULL`) are not counted in `proven` mode. Unproven reports stay visible in the report browser (labelled "not counted in your numbers") and sort **after** proven ones, so a flood of them cannot push real ones out of "latest N".

**Residual risk.** "Proven" means "the mail really came from the domain it claims", not "the reporter is trustworthy". An attacker who owns any domain with working DKIM can be proven as that domain and file fake "100% pass" reports for a victim whose address (the token) she knows. The token is public in the customer's DMARC record. What limits this: the per-reporter and unproven caps above, the shared-mailbox rule (which removes the free-mailbox route), and the dashboard naming the reporters behind the numbers. What would close it: a per-workspace list of trusted reporter domains (not built). Until you have read a real message (below) and set `AUTHSERV_*`, nothing counts: the first deploy shows zero counted reports and the "N reports from senders we could not verify are not counted" line says why.

### AUTHSERV discovery

You do not need a forwarding rule to find `AUTHSERV_ID`. With `AUTHSERV_ID`/`AUTHSERV_HEADER` unset (or set to something the message does not name), the first routed messages log, without storing anything:

```
{"evt":"intake_authserv","v":1,"configured":false,"ar":"mx.cloudflare.net","arc":{"i":1,"id":"mx.cloudflare.net"},"hint":"Set AUTHSERV_ID=mx.cloudflare.net and AUTHSERV_HEADER=ar"}
```

Steps: (1) route `rua@` to the Worker (section 2) and put the address in a DMARC record, or send one mail to `rua+<a real token>@…`; (2) `wrangler tail --format json | jq -c 'select(.logs[]?.message[0] | tostring | test("intake_authserv"))'`; (3) set `AUTHSERV_ID` to `ar` and `AUTHSERV_HEADER=ar` (or to `arc.id` and `arc` when there is no plain header); (4) send a crafted message with your own extra `Authentication-Results` line and check it is not trusted ([email-funnel.md](email-funnel.md)). Only messages that reached a valid token are logged, at most 5 per isolate per hour, and only authserv-ids that are host names (never an address).

### Logs

One JSON line per inbound message, `console.log` for accepted, `console.warn` for refused/deferred:

```
{"evt":"intake","v":1,"kind":"rua","outcome":"accepted","reason":"ok","proven":true,"reporter":"google.com","size":5321,"records":87,"ms":412,"ws":"ws_a1b2","dom":12}
```

`kind` rua | tls-rpt | canary | other; `outcome` accepted | duplicate | refused | deferred; `proven` true | false | null; `reporter` is the reporting organisation's domain; `ws`/`dom` are internal ids. There are never report contents, tokens, addresses, sender or customer domains. (Real lines from the workerd run are in the pull request.) Reasons: `ok duplicate bad_recipient wrong_host unknown_token raw_too_large cap_address_day cap_unauth_day cap_workspace_day cap_instance_day cap_address_records cap_workspace_storage cap_instance_storage no_attachment wrong_attachment_type archive_invalid decompressed_too_large xml_invalid json_invalid kind_mismatch_tlsrpt_to_rua kind_mismatch_rua_to_tlsrpt too_many_records field_too_long date_range_invalid domain_not_owned storage_failed storage_failed_repeatedly not_configured schema_not_ready internal_error`.

### Hostile input

Refused with a reason, nothing stored: gzip/zip bombs (inflation stops at `INTAKE_MAX_DECOMPRESSED_BYTES`; a zip's declared sizes are not trusted; more than 2 entries), a gzip inside a gzip (the inner stream is not inflated), DOCTYPE/ENTITY, invalid UTF-8, fields over their limits (org_name and report_id 256, domains 253, IP 45, other strings 512), a report whose period ends more than a day in the future, ends before it begins, spans more than 31 days or begins before 2012, a count above 2³¹−1 (clamped), a domain the token does not own (hosted answers "Report is for a domain this address does not belong to" and never echoes the sender's domain; self-host keeps "Unknown domain X — not a registered InboxAngel inbox"), a gzip header over 1 KiB. A duplicate report id is accepted once and never counted twice.

### Measured limits

Measured on this repository's code (2026-11-14) in two ways. The first is authoritative for memory and CPU; the second explains it.

**1. The real Worker under `wrangler dev` (workerd 4.92.0, linux-arm64).** A local worker with `MODE=saas`, a seeded workspace, domain and token in local D1, driven by HTTP POSTs. `wrangler dev`'s own email endpoint (`POST /cdn-cgi/handler/email`) refuses messages over **1 MiB** ("the lower 1Mib limit for testing locally"), so the size runs used a measurement-only entry point (not committed) that hands a request body to the Worker's real `email()` export as the `raw` stream; the end-to-end runs below used the real `/cdn-cgi/handler/email` endpoint. Per message: **CPU** = delta of `utime+stime` of every `workerd` process from `/proc/<pid>/stat` (10 ms ticks; includes GC threads and the local D1's SQLite, which in production runs remotely), **memory** = peak of the summed `VmRSS` of the `workerd` processes sampled every 5 ms from `/proc/<pid>/status`, minus the sum just before the message (after a warm-up message), on a fresh `wrangler dev` per case. Timers inside workerd cannot measure CPU: `Date.now()` and `performance.now()` only advance on I/O. Enrichment lookups were limited to 1 IP per report (`INTAKE_MAX_NEW_IPS_PER_REPORT=1`): the sandbox has no outbound network, and waiting on DNS is not CPU.

First message through a fresh isolate (hosted defaults: 2,000 records / 1 MiB decompressed / 2 MiB raw):

| Case | Raw message | CPU per message | Peak RSS over idle (first message) |
|------|------------:|----------------:|------------------------------------:|
| small: 1 record | 1 KB | 0.03-0.05 s | +3 MB |
| typical: 200 records, Google-like gzip | 3 KB | 0.10 s (then ~0.07) | +10 MB |
| 2,000 records (the cap) | 20 KB | 0.37 s | +44 MB |
| decompressed cap: 1 MiB of XML, incompressible | 0.24 MiB | 0.44 s | +71 MB |
| raw cap: a 2 MiB message holding a small report | 2 MiB | 0.11 s | +17 MB |
| **worst case: records, 1 MiB incompressible XML and 2 MiB raw together** | 2 MiB | 0.44 s | **+77 MB** |
| self-host defaults (2,500 / 1.25 MiB / 2 MiB), worst case | 2 MiB | 0.50 s | +84 MB |

Later messages in the same isolate show higher resident sizes (+100 to +190 MB after five worst-case messages): the heap is not returned to the OS and nothing forces collection locally. Production enforces the 128 MB limit with garbage collection, so this overstates the live set, but it is the reason the defaults aim for a first-message worst case of about 80 MB rather than for 128. The first defaults I measured (5,000 records / 3 MiB / 10 MiB) peaked at **+165 MB** on one message and were **not** honest for a 128 MB isolate; they were lowered until the worst case fell under ~90 MB.

**Findings from the measurement.** (1) A gzip whose header carries a multi-megabyte comment made one 10 MiB message cost **88 s of CPU** (quadratic copying in fflate's streaming Gunzip: 2 MB of comment = 6 s even in Node); a gzip header over 1 KiB is now refused (`archive_invalid`, `MAX_GZIP_HEADER` in `src/dmarc/extract-report.ts`). (2) Inflating in 1 KiB steps cost ~50 MB more RSS than 16 KiB steps on an incompressible report; the step is 4 KiB (a bomb at 1032:1 can overshoot the cap by ~4 MB before it is noticed).

**2. Node, parse only** (`scripts/measure-parse.ts`, `scripts/measure-mime.ts`): parsing keeps ~7 KB of live heap per record (5,000 records: 36 MB; 20,000: 119 MB), and reading the attachment of a 10 MB message peaked at ~16x its size in Node but ~4x in workerd (+43 MB for a 10 MiB message with a small report), because Node's RSS counts garbage that workerd's runtime reclaims sooner.

**Recommended `limits.cpu_ms`: 5000.** The worst case above is 0.5 s of CPU; the default of Workers Paid is 30 s. 5 s is ten times the worst measured case, and kills a pathological input at 5 s instead of 30 (the gzip header above would have run to the 30 s default). A Free plan (10 ms CPU) cannot parse even a 200-record report, so hosted intake needs Workers Paid (<https://developers.cloudflare.com/workers/platform/limits/>: "5 min (default: 30 seconds)", configurable up to 300,000 ms; "Each isolate can consume up to 128 MB of memory"). Email Workers count toward these limits (<https://developers.cloudflare.com/email-routing/limits/>).

**How far to trust the numbers.** workerd is the production runtime's open-source core, so CPU per message and the shape of memory use carry over; the absolute values do not. They include a local SQLite D1 in the same process (production D1 is remote, which lowers CPU and memory), exclude real network latency (D1 round trips, DNS-over-HTTPS), and Cloudflare's CPU billing, isolate sharing and garbage collection are not reproduced. On a 1-core arm64 sandbox, timings are not a benchmark. Watch `wrangler tail` and the Workers metrics for the first real week.

### Caps and what happens over them

Counters live in D1 and are checked **before parsing**. Naming: `INTAKE_MAX_*`; the table of defaults is in [Environment](#1-environment).

| Scope | Cap | Enforced |
|-------|-----|----------|
| one address (token) | messages/day; stored records/day; unproven messages/day in total and per claimed sender | before parsing; records after the header is read, before enrichment |
| one workspace | messages/day; records held | same |
| the instance | messages/day; records held | same |

Over a cap the mail is **refused for good** (5xx in the SMTP session, so no backscatter), counted for the owner and logged with its reason; a duplicate counts as a message received but adds no stored records. The records held are kept by `workspace_storage` and the instance row in `intake_quota` (the same transaction as the report), reduced by the retention sweep when reports are purged, and recounted by the daily job (5 workspaces per run, least recently counted first, so drift and data stored before the counters existed are repaired). A race between two large reports can overshoot a records cap by at most one report.
**Retention.** In the existing daily `0 4 * * *` job (statement budget 300, deletes in chunks of 500): `intake_usage` and `intake_quota` rows older than 8 days, `intake_failures` older than 90 days; reports and records keep the 13 months.

### API fields for the dashboard

On `GET /api/domains/:id/stats`, `/check-summary` and `/analytics` (and `sections.dmarc` of the MCP health report): `report_counting`; `unverified` (stored reports whose sender was not proven: `reports`, `messages`, `latest_at`, `by_reporter`); `uncounted` (the part of it left out of the numbers; empty when `report_counting` is `all`); `intake` (`status` `ok`/`limited`/`not_processed`, `limit`, `notice`, `not_processed.{messages,last_at,reasons[]}`). `GET /api/reports` rows carry `counted`; the CSV export has a `counted` column. Exact strings: "N reports from senders we could not verify are not counted." · "1 report from a sender we could not verify is not counted." · "Report storage limit reached; newer reports are not being stored" · "Daily report limit reached for this address; newer reports are not being stored until tomorrow" · "N reports received for this domain could not be processed". Web helpers: `web/src/lib/uncounted.ts`.

### Self-host: what changes

Self-host has one tenant and a private address (`rua@reports.<base>`), no tokens, no daily or per-tenant caps. What applies everywhere: the records cap (default 2,500), the decompressed cap (1.25 MiB), the raw cap (2 MiB; the same 128 MB isolate, so the measured worst case is +84 MB), the fixed query budget, atomic storage, specific refusals, the date/field/DOCTYPE checks, and the structured log line. `REPORT_COUNTING` defaults to `all` (with `AUTHSERV_*` unset nothing can be proven, so `proven` would zero every dashboard); set `REPORT_COUNTING=proven` once `AUTHSERV_*` is configured if you want forged reports left out. `unverified` is reported in both modes.

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
| Report size | 2 MiB raw, 1 MiB decompressed, 2,000 records (configurable up to Cloudflare's 25 MiB; see [Measured limits](#measured-limits)) |
| Token rotation grace | 72 h |
| Canary | 1 hour, one email; 5 per authenticated sender domain, 20 unauthenticated, 500 overall, per hour |
