# Hosted Ready Set Mail (`MODE=saas`)

How the hosted service routes reports, hands out records and verifies customers. Everything here applies only when
`MODE=saas` **and** `SAAS_ENABLED=1`. Self-host (`rua@reports.<base>`, your own Email Routing) is untouched.

> **Rollout warning: existing `MODE=saas` deployments.** Before this change `MODE=saas` inbound mail silently went to the default workspace. Now, without `SAAS_ENABLED=1`, **every inbound message makes the Worker throw**, so senders see temporary failures and retry; report mail also throws until `INTAKE_DOMAIN` is set. Set `SAAS_ENABLED=1` and `INTAKE_DOMAIN` (and `CANARY_DOMAIN` if the free check is wanted) *before* deploying this version, and run `npm run migrate`. Mail addressed without a valid token is rejected, not filed anywhere.

Contents: [Overview](#overview) · [Operator setup](#operator-setup) · [Customer setup](#customer-setup) · [How it works](#how-it-works) · [API](#api) · [Limits](#limits-and-quotas)

## Overview

| Piece | Address / name | Lives in |
|-------|----------------|----------|
| DMARC aggregate reports | `rua+<token>@rua.readysetmail.com` | Email Routing → this Worker |
| TLS-RPT reports | `tls-rpt+<token>@rua.readysetmail.com` | Email Routing → this Worker |
| Free check ("canary") | `check+<token>@canary.readysetmail.com` | Email Routing → this Worker |
| Hosted DMARC | `<id>._dmarc.h.readysetmail.com` TXT | the records zone |
| Hosted SPF (flattened) | `<id>._spf.h.readysetmail.com` TXT | the records zone |
| Hosted TLS-RPT | `<id>._tlsrpt.h.readysetmail.com` TXT | the records zone |
| Hosted MTA-STS | `mta-sts.<id>.h.readysetmail.com` TXT (`v=STSv1; id=…`) + proxied AAAA (policy host) | the records zone |

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
| `INTAKE_DOMAIN` | `rua.readysetmail.com` | report intake. With it set (and `MODE`, `SAAS_ENABLED`), owners and admins can connect a verified domain's reports to `rua@<INTAKE_DOMAIN>` (see [Report address without hosted records](#report-address-without-hosted-records)); it does not need `CANARY_DOMAIN` or the `HOSTED_RECORDS_*` settings |
| `HOSTED_CONNECT_REPORTS` | `owner` | who may connect reports to `rua@<INTAKE_DOMAIN>`: `owner` (default; also any unknown value) lets only workspaces owned by the `OWNER_EMAIL` account connect, and the intake refuses every other workspace's reports; `all` opens it to every verified workspace. Keep `owner` until large-report handling, forged-report weighting and storage caps have landed. Without `OWNER_EMAIL`, `owner` means nobody. The owner setup check reports it |
| `CANARY_DOMAIN` | `canary.readysetmail.com` | optional: the free check. Without it `POST /api/check-sessions` answers `503` and report intake is unaffected |
| `HOSTED_RECORDS_ZONE` | `readysetmail.com` | zone that holds the hosted records |
| `HOSTED_RECORDS_LABEL` | `h` | the single label every hosted record lives under (default `h`) |
| `INTAKE_MAX_REPORTS_PER_DAY` | `50` | reports per intake token **per registry reporter** per UTC day |
| `INTAKE_MAX_BYTES_PER_DAY` | `52428800` | raw message bytes per token per registry reporter per UTC day (50 MiB) |
| `INTAKE_MAX_UNKNOWN_REPORTS_PER_REPORTER_PER_DAY` | `5` | reports per **authenticated sender that is not in the registry** (its DKIM organisation) per token per UTC day |
| `INTAKE_MAX_UNKNOWN_REPORTS_PER_DAY` | `20` | all such senders together, per token per day |
| `INTAKE_MAX_UNKNOWN_RECORDS_PER_REPORT`, `INTAKE_MAX_UNKNOWN_NEW_IPS_PER_REPORT` | `1000`, `10` | records in a report from such a sender; uncached source IPs it may have looked up (a small budget, so one cannot spend the lookups) |
| `INTAKE_MAX_UNAUTH_REPORTS_PER_DAY`, `INTAKE_MAX_UNAUTH_BYTES_PER_DAY` | `5`, `10485760` | **unauthenticated** mail per claimed sender domain (SMTP envelope, forgeable) per token per day; raw bytes of that bucket (10 MiB) |
| `INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY` | `10` | **all** unauthenticated mail on the whole instance per UTC day, whatever sender it claims (a forger can claim any domain) |
| `INTAKE_MAX_UNAUTH_RECORDS_PER_REPORT` | `200` | records in an unauthenticated report. No IP lookups are ever made for one |
| `INTAKE_MAX_UNCOUNTED_WORKSPACE_MESSAGES_PER_DAY`, `INTAKE_MAX_UNCOUNTED_INSTANCE_MESSAGES_PER_DAY` | `100`, `2000` | messages from **uncounted** senders (unknown or unauthenticated) per workspace / on the whole instance per UTC day. Charged **instead of** the counted workspace and instance message caps below, so strangers cannot use those up |
| `INTAKE_MAX_UNCOUNTED_ADDRESS_RECORDS_PER_DAY` | `5000` | records stored from uncounted reports per report address per UTC day (its own counter, `ua:<domain id>`; the counted one is `a:`) |
| `INTAKE_MAX_UNCOUNTED_WORKSPACE_RECORDS`, `INTAKE_MAX_UNCOUNTED_INSTANCE_RECORDS` | `20000`, `500000` | records uncounted reports may hold at once per workspace / on the whole instance (2% and 5% of the counted caps; with 30-day retention that is what a stranger can keep) |
| `INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY` | `500` | messages to one report address per UTC day from **registry reporters** (the counted budget) |
| `INTAKE_MAX_ADDRESS_RECORDS_PER_DAY` | `200000` | **counted** records stored for one report address per UTC day |
| `INTAKE_MAX_WORKSPACE_MESSAGES_PER_DAY` | `2000` | messages from registry reporters to one workspace per UTC day |
| `INTAKE_MAX_WORKSPACE_RECORDS` | `1000000` | **counted** report records one workspace may hold at once (13 months of data). Uncounted reports do not count against it |
| `INTAKE_MAX_INSTANCE_MESSAGES_PER_DAY` | `50000` | messages from registry reporters to the whole instance per UTC day |
| `INTAKE_MAX_INSTANCE_RECORDS` | `10000000` | **counted** report records the whole instance may hold, so the shared D1 (10 GB limit) cannot be filled by one tenant or by all of them |
| `INTAKE_MAX_RECORDS_PER_REPORT` | `2000` | records in one aggregate report from a registry reporter, checked before any per-record work (self-host default 2,500; see [Measured limits](#measured-limits)) |
| `INTAKE_MAX_DECOMPRESSED_BYTES` | `1048576` | a **registry reporter's** report once decompressed (1 MiB; self-host 1.25 MiB; at most 25 MiB) |
| `INTAKE_MAX_NONREGISTRY_DECOMPRESSED_BYTES` | `1048576` | any other sender's report once decompressed (never above `INTAKE_MAX_DECOMPRESSED_BYTES`) |
| `INTAKE_MAX_RAW_BYTES` | `2097152` | the raw message (2 MiB; at most Cloudflare's own 25 MiB). A report that fits the decompressed cap is a few hundred KB compressed |
| `INTAKE_MAX_NEW_IPS_PER_REPORT` | `50` | uncached source IPs enriched (DNS-over-HTTPS) per registry-reporter report, busiest first; the rest are stored without enrichment |
| `INTAKE_MAX_STORAGE_RETRIES_PER_DAY` | `20` | storage failures of **one message** (a hash of domain + reporter identity + report id) per day after which an **uncounted** sender's message is refused for good instead of being retried. A known reporter's report is never refused for our own storage failure: it keeps throwing so the sender may retry, and the owner sees the failure count |
| `REPORT_COUNTING` | `registry` (self-host: `all`) | `registry`, `authenticated` or `all`: which stored reports feed pass rates, failing senders, anomalies, "safe to enforce", levels, digests and the MCP report ([tiers](#tiers-and-what-counts)). **Weakening hosted to `authenticated` or `all` is an explicit operator choice** |
| `AUTHSERV_ID`, `AUTHSERV_HEADER` | unset | the receiver's authserv-id and header kind (`ar`/`arc`); see [AUTHSERV discovery](#authserv-discovery). **Until both are set no mail is authenticated, so nothing is counted** (reports are stored as unauthenticated) |
| `INTAKE_KNOWN_REPORTERS` | unset | extra registry entries, `id\|label\|dkim-org,…\|from,…\|report-email,…` separated by `;` or newlines. A malformed entry is ignored and listed under `issues` on `GET /api/instance/reporter-candidates`. **An id that is a built-in id (google, microsoft, yahoo, …, also a disabled one), a label equal to a built-in label, or an id used twice in this list is refused** (listed under `issues`): the id is the identity counted reports are stored under, and `google\|Evil\|evil.com\|…` must never count evil.com as Google. The "safe to enforce" check for a major reporter keys on the built-in entry's id only |
| `INTAKE_KNOWN_REPORTERS_DISABLE` | unset | built-in registry ids to switch off (`yahoo,fastmail`) |
| `RETENTION_UNCOUNTED_REPORTS_DAYS` | `30` | days a report of tier `unknown` or `unauthenticated` is kept, swept by the one daily `0 4 * * *` cron. Not applied when `REPORT_COUNTING=all` (there those reports are the numbers). The earlier name `RETENTION_UNAUTHENTICATED_REPORTS_DAYS` (when it covered only unauthenticated reports) is still honoured when the new one is unset. A reporter an owner promotes later becomes tier `counted` and leaves this sweep (the sweep and the budgets read `reporter_tier`, never the identity) |
| `RETENTION_INTAKE_COUNTERS_DAYS`, `RETENTION_INTAKE_FAILURES_DAYS` | `8`, `90` | how long the daily counters and the "could not be processed" markers are kept |
| `HOSTED_MAX_DOMAINS_PER_WORKSPACE` | `10` | optional: domains per workspace that may use hosted records (enabling more answers 429) |

A report's `policy_published` domain must be the token's domain or a subdomain of it; it is filed under the token's domain, or under the subdomain's own row if the same workspace has that subdomain as a verified domain. Each stored report also records whether its
email passed DMARC-aligned authentication for the reporting organisation (`reporter_auth`: `pass`, `fail` or `none`).

Secret: `wrangler secret put HOSTED_RECORDS_TOKEN` (see [token scopes](#3-the-records-token)).

Apply the current migrations with `npm run migrate` before enabling anything. Hosted intake tables are included in the current baseline; trust and access updates are additive migrations.

### 2. Email Routing (inbound)

Subdomains cannot have a catch-all, so each base address gets **one rule**; the `+<token>` part is sub-addressing
that the Worker reads itself.

1. Enable Email Routing for the **subdomains** `rua.readysetmail.com` and `canary.readysetmail.com` (Email Routing → Settings → add subdomain; this adds their MX/SPF records).
2. Create custom addresses with action **Send to a Worker** → this Worker:

   | Address | |
   |---------|-|
   | `rua@rua.readysetmail.com` | DMARC |
   | `tls-rpt@rua.readysetmail.com` | TLS-RPT |
   | `check@canary.readysetmail.com` | free check |

3. Check it: send a mail to `rua+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@rua.readysetmail.com` and look for
   `{"evt":"intake",…,"outcome":"refused","reason":"unknown_token",…}` in the Worker logs (`wrangler tail --format json`). If nothing arrives, Email Routing is not matching
   `+` sub-addresses for you; the rules above are then not enough and this needs revisiting (it cannot be tested from the repo).

### 3. The records token

`HOSTED_RECORDS_TOKEN` is separate from the deploy token, from `CLOUDFLARE_API_TOKEN` (self-host) and from any tenant credential.
Create it at *My Profile → API Tokens → Custom token*:

* **Zone → DNS → Edit**
* **Zone → Zone → Read** (the Worker looks the zone up by name)
* Zone Resources: **Include → Specific zone → `readysetmail.com`** (nothing else; no account permissions)

The writer refuses any record name outside `*.h.readysetmail.com` (and any type other than TXT/AAAA) before it makes a request, and
re-reads a record before changing or deleting it to be sure it sits at the expected hosted name. The token scope is the second fence, not the only one.

### 4. The records zone

* `readysetmail.com` on **Cloudflare Pro** (3,500 records; see [limits](#limits-and-quotas)). A free zone created since September 2024 holds only **200** records, which is about 40 domains with MTA-STS (5 records each) or 66 without (3 each) before the zone's existing records are counted, so it is not an option. (Free zones created earlier may still have the old 1,000-record limit; do not rely on it.)
* One-time authorisation record so receivers will send reports for *any* customer domain to `rua.readysetmail.com` (RFC 7489 §7.1, external destination verification).
  A wildcard covers every customer:

  ```
  *._report._dmarc.rua.readysetmail.com.   TXT   "v=DMARC1"
  ```

  Put it in the zone for `readysetmail.com` (outside `*.h.`, so the writer never touches it).
* MTA-STS policy hosts: the Worker serves `https://mta-sts.<id>.h.readysetmail.com/.well-known/mta-sts.txt` and
  `https://mta-sts.<customer domain>/.well-known/mta-sts.txt`. Add a Worker route `*.h.readysetmail.com/*`, and for the customer-hostname form
  use Cloudflare for SaaS (custom hostnames with a fallback origin) so `mta-sts.customer.com` gets a certificate.

### 5. Crons

The daily hosted job runs inside the existing `0 11 * * *` trigger (after the per-workspace work), so `wrangler.jsonc` needs no new trigger:

1. **Zone reconcile**: lists the whole records zone, stores the record count (quota), warns at 3,200, and diffs it against the database:
   expected records that are missing and records under `*.h.` that no domain owns are **reported, never fixed or deleted**.
   Records outside `*.h.` are only counted and fingerprinted; a change since yesterday is logged (`records outside h.readysetmail.com changed`). The job issues only `GET`s.
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

**Email verification.** A hosted account has no session until its email is verified, and delegated credentials of unverified human users are refused. Sign-up
asks for the email only (and the bot check); the account gets a random password nobody is told. The emailed link is
`<origin>/#/welcome/<token>`: the token sits in the URL fragment, which no server receives, so it is in no request line, log or
Referer. Opening the link changes nothing, so a mail scanner or link-preview bot that fetches it cannot use up the person's click.
The welcome page's `POST /api/auth/welcome` (token + password; same-origin; 10 attempts an hour per token, 30 per IP) does
everything in one transaction: it verifies the address, replaces any earlier password (one a registrant chose is dead), ends every
session and signs the person in. The token then refuses ("already used"); until a password has been chosen with it, it works from
any device and after any number of opens, for its whole lifetime: 24 hours (`VERIFICATION_LINK_SECONDS`, the number the mail and
the pages state). An expired or used link gets a page that offers a new link (or sign-in and a reset). Links in the old shape
(`GET /api/auth/verify-email?token=…`) get a page that moves the token into the fragment (no `Location`, `Referrer-Policy:
no-referrer`) and change nothing. Verification mail is capped per address in two separate allowances, so a flood of one cannot spend the other: a
bot-checked sign-up (new, repeated for an address still unconfirmed, which sends a fresh link, or a hosted invitee) gets 2 an hour
and 4 a day; a resend or a sign-in of an unconfirmed account gets 3 an hour and 10 a day. A resend passes the same bot check as
sign-up (and is closed when sign-up is). Over a cap nothing is sent and every answer is unchanged, so neither cap reveals which
addresses exist. Names typed before the address was proven (at sign-up, or by whoever holds an invite link) are not kept:
sign-up asks for no name, and when the welcome page verifies the account it sets the display name to the one given there (else
the email address) and the sign-up workspace's name from it (else from the email's domain). Names are stored and shown without
control or invisible format characters, at most 80 characters.

**Sign-in throttle.** Besides the per-IP limits, failed sign-ins are counted per address (a hash of it): after 10 in 15 minutes,
attempts for that address answer `429` "Too many sign-in attempts for this address. Try again in N minutes, or reset your
password to sign in now." with `Retry-After`, until the 15-minute window ends, whether or not the bot check is configured.
Addresses with no account are counted the same way, so the answer reveals nothing. A password reset, or choosing the password
from the emailed link, clears it at once; a successful sign-in clears it too. An invite link alone does not grant membership: the invitee gives
a name, uses the same welcome link, and accepts while signed in as the invited address. First OAuth link ends the user's other sessions.

**Bot check (required for sign-up).** Hosted sign-up fails closed (503) unless both `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` (the public key served to the sign-up page) are set.
Closed means no NEW accounts, by any route: the password sign-up and a new invitee answer 503, and the user-creation hook refuses any
account (an OAuth callback included). Existing users are never locked out by missing keys: they sign in (by password, without the
check, since the page cannot render it; or by OAuth), use "Forgot password" and reset links, and finish a pending welcome link. The
status says exactly that: `signup_open: false`, `signin_available: true`, `signup_unavailable_reason: bot_protection_not_configured`.
Why sign-in without the check is acceptable: it creates nothing and sends mail only for an unverified account, which the per-address cap
bounds; sign-in is rate limited per IP (`AUTH_LIMITER`, and Better Auth's 10 a minute). When the keys are configured, sign-in keeps the check. OAuth logins link to an
existing account only when both the local account's email and the provider's are verified, and an OAuth sign-up matches a
pending invite only on a provider-verified email. Verification mail uses the platform sender (`from_email` setting of the
default workspace) over `SEND_EMAIL`; without it nothing is sent and the Worker log records only a static reason (never the link or address). Self-host is unchanged: the owner
is marked verified at setup.

**Domain ownership.** A domain a workspace adds is a *claim* (`domain_claims`) until proven; it is not in `domains`, so
it has no reports, stats, check results, hosted records or DNS writes, and it never blocks another workspace. It is
verified by any of: (a) its zone is on the allow-list of one of the workspace's active Cloudflare connections, (b) the
workspace already verified a parent domain, (c) the TXT record `_readysetmail.<domain>` holds `readysetmail-verify=<token>`
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
| CNAME | `_dmarc.customer.com` | `<id>._dmarc.h.readysetmail.com` |
| TXT (edit the existing SPF) | `customer.com` | add `include:<id>._spf.h.readysetmail.com` |
| CNAME | `_smtp._tls.customer.com` | `<id>._tlsrpt.h.readysetmail.com` |
| CNAME *(only if MTA-STS is hosted)* | `_mta-sts.customer.com` | `mta-sts.<id>.h.readysetmail.com` |
| CNAME *(only if MTA-STS is hosted)* | `mta-sts.customer.com` | `mta-sts.<id>.h.readysetmail.com` |

Notes for the customer:

* **SPF:** keep a single `v=spf1` record. Replace the includes Ready Set Mail flattened with `include:<id>._spf.h.readysetmail.com`; the hosted record is built from the SPF
  the domain published when hosting was enabled (or the `spf_record` given then) and carries no DNS lookups of its own beyond what could not be flattened.
* **DMARC:** the hosted record starts at the domain's stored policy (`p=none` by default). Moving a hosted domain through the rollout steps (`rollout-advance`) does not rewrite the hosted record yet.
* A `CNAME` cannot sit next to other records at the same name. If `_dmarc.customer.com` already has a TXT, remove it when adding the CNAME.
* Ready Set Mail checks the pointers daily and on demand (`POST …/hosted/verify`). Each is `ok`, `missing`, `wrong` (something else is there) or `error` (could not be read; the previous status is kept).
  A hosted record counts toward the domain's **Level** only once its pointer is `ok` (`level_inputs` in the status response).
* Token rotation (`POST …/hosted/rotate-token`) edits the hosted records; the customer changes nothing. The previous token keeps being accepted for 72 hours.

### Report address without hosted records

The simplest way to receive reports, and the only one that needs no records zone and no Email Routing sub-addressing: every customer publishes the same address, `rua@<INTAKE_DOMAIN>`.
Nothing is issued. **Connect reports** on the domain page (`POST /api/domains/:id/report-address`) records that the workspace wants this domain's reports filed here by setting `domains.rua_address` to that address.
It needs `MODE=saas`, `SAAS_ENABLED=1` and `INTAKE_DOMAIN`, an owner or admin, and a verified domain (never a pending or lost claim, an evicted row, or a `legacy` row from before ownership checks).

Filing (`src/hosted/fixed-address.ts`, `src/hosted/intake.ts`). Mail to `rua@<INTAKE_DOMAIN>` carries no token, so it has no workspace until the report names its domain. Its order of work: (1) the carrier's authentication result (`carrierFromHeaders`, plus the envelope guard below); (2) one peek against an instance-wide **per-minute ceiling** (`INTAKE_MAX_FIXED_PEEKS_PER_MINUTE`, default 120; registry reporters are not counted): past it the message is deferred, so the sender retries and nothing is refused for good (cost: at most 7.5 MiB inflated per minute, one `intake_quota` row per minute of the day); (3) a peek at `feedback/policy_published/domain` from at most the first 64 KiB of the decompressed report (inflation stops there), one linear scan that skips comments, CDATA and processing instructions and refuses a DOCTYPE; (4) attribution to the owner (below). When nobody connected the domain the message is charged to the **unattributed budget** and refused: its carrier class's daily total (`INTAKE_MAX_UNATTRIBUTED_MESSAGES_PER_DAY`, default 2000) and, only while that has room, the sender's own allowance (`INTAKE_MAX_UNATTRIBUTED_PER_SENDER_PER_DAY`, default 100: an authenticated sender by its DKIM organisation, an unauthenticated one by the envelope-sender domain it claims), so at most one row per message within the total. Mail for a connected domain is never charged to it and never refused because of it, and no workspace's or instance budget is touched by unconnected mail. Then, exactly like a token address, (5) `chargeIntakeCaps` before the full decompression (capped by carrier class), (6) `decideTier`, (7) the atomic batched store. The full parse must name the same domain as the peek (`report_domain_mismatch`), and every record's `header_from` must be that domain or a subdomain of it (`record_domain_mismatch`; on token addresses too).

`GET /api/domains/:id/report-address` reads the live `_dmarc` record and says what to publish:

* the current record with the address added to `rua=`, every other tag and the policy unchanged;
* when the record already lists two addresses (receivers only have to honour two, RFC 7489 §6.2), a choice of which one to replace, or to add a third knowingly; nothing is dropped without that choice;
* for a subdomain that follows its organizational domain's record: where the record lives, and a record of its own that keeps the policy it gets today (`sp=`, else `p=`) and the parent's addresses;
* for a domain with no DMARC record: `v=DMARC1; p=none; rua=mailto:<address>`;
* several DMARC records at one name: no proposal (receivers ignore them all);
* a failed lookup: `plan: null` and `state: "unknown"`, never "no record".

`state` comes from evidence: `not_connected`; `not_published` (connected, the live record does not list the address); `waiting` (listed, no COUNTED report since connecting); `receiving` (listed AND at least one COUNTED report, `reporter_tier = 'counted'`, stored since `connected_at`; `last_report_at` is the newest of those); or `unknown` (the lookup failed). `counted_since_connect`, `reports_since_connect` and `reports_before_connect` count the rest, and `visibility` carries the uncounted and not-stored reports RECEIVED since connecting (the same fields as `/stats`, windowed on `created_at`: a report covers the previous day, so its period starts before the connection), so a reconnect, an uncounted or a forged report never reads as "received".
Token addresses (`rua+<token>@…`) keep working: hosted records issue them, and an operator-issued one shows as connected while its token is current. `tls-rpt@` without a token is refused: TLS-RPT still needs a token address.
A domain with hosted records keeps its address there: these routes report `managed_by: "hosted_records"` and refuse to change it (`409`).
Receivers outside the customer's organization only send to the address once the [authorisation record](#4-the-records-zone) `*._report._dmarc.<INTAKE_DOMAIN>` exists.


### Going from owner to all

`HOSTED_CONNECT_REPORTS` stays `owner` until every line below is true; the owner setup check shows its current value. Turning it to `all` lets every verified workspace connect reports to the shared address.

**The risk this checklist exists for.** A receiver that writes a sender-chosen value back into its results header unquoted lets that sender add a result the receiver never produced. Reproduced in review: `smtp.helo=x;dkim=pass(c)header.d=google.com` was counted as Google. A HELO written back unquoted that splits into valid pieces **would be counted as the forged identity**. The switch must stay `owner` until the live header check below rules it out. Two defences do not depend on that check: a carrier whose envelope sender is not a plain address is not believed (`guardEnvelope`), and a results header with **more dkim results (other than `none`) than the message has `DKIM-Signature` fields, or more than one dmarc result, is not believed** (`carrierFromHeaders`, `src/dmarc/reporter-auth.ts`). That closes an injected result on an unsigned message and on a message signed fewer times than it has results. It does not close a sender that adds extra `DKIM-Signature` fields to a receiver that writes fewer results than there are signatures, nor an injected result that replaces nothing (one signature, the receiver's own result dropped or mangled by the split): the live check decides those.

1. **Operator setup in place.** The `rua@<INTAKE_DOMAIN>` routing rule (Email Routing, action "Send to a Worker") and the wildcard authorisation record `*._report._dmarc.<INTAKE_DOMAIN>` TXT `v=DMARC1` (receivers outside a customer's organisation only send to the address once it exists).
2. **One real routed header inspected.** Send a report-shaped message through Email Routing to `rua@<INTAKE_DOMAIN>` from a mailbox you control and read the Worker's view of it: the topmost `Authentication-Results` must carry `AUTHSERV_ID`, and `smtp.mailfrom` must be written quoted or rejected when it holds `;`, spaces, quotes or parentheses. The parser drops a result whose property values are not valid (`validPropertyValue`, `src/email/auth-results.ts`) but cannot catch a value that splits into valid pieces.
3. **The HELO test.** From a server you control, send one message whose SMTP `HELO` (or `EHLO`) name is a HELO containing `;` (for example `x;dkim=pass(c)header.d=example.org`) and read how Cloudflare writes `smtp.helo` back: quoted, rejected at the SMTP stage, or not written at all rules the risk above out. Written back unquoted, the switch stays `owner`. Workers never see the HELO name, so this test is the only way to know.
4. **What the sending server sees when the Worker throws.** Past the per-minute peek ceiling, authenticated non-registry mail is deferred by throwing; Cloudflare does not document what an uncaught throw in an email Worker tells the sending server (a temporary failure is expected, a permanent one is possible). This is **unknown until observed**: trigger it once (a low `INTAKE_MAX_FIXED_PEEKS_PER_MINUTE` on a test instance), send from a mailbox you control, and record the SMTP reply and whether the message is retried. Unauthenticated mail past the ceiling is refused with a permanent reply instead (it can never count).
5. **`AUTHSERV_ID` and `AUTHSERV_HEADER` set** from that message, and the setup check shows no `intake` action.
6. **Budgets sized and quiet.** `INTAKE_MAX_FIXED_PEEKS_PER_MINUTE` (default 120), `INTAKE_MAX_UNATTRIBUTED_MESSAGES_PER_DAY` (2000) and `INTAKE_MAX_UNATTRIBUTED_PER_SENDER_PER_DAY` (100) set for the expected volume; the setup check names no cap hit in the last three days under `owner`. Unattributed mail cannot block attributed mail: it is charged only after a failed attribution, in its own budget.
7. **No `header.i` fallback, no copied-envelope trust, no unverified names.** DKIM results are read from `header.d` only; a report from an unauthenticated sender is shown as an "unverified sender" that only claims its name.
8. **Terms and privacy** cover processing aggregate reports for 13 months.
9. **Undo is ready:** setting it back to `owner` stops new connections and makes the intake refuse other workspaces' reports at once; already-connected domains show "not connected".

## How it works

**Inbound mail** (`src/hosted/intake.ts`): the Worker parses `base+tag@host`.

1. `rua@` (no tag) at `INTAKE_DOMAIN`: the report's own domain picks the workspace, see [Report address without hosted records](#report-address-without-hosted-records).
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
| schema not migrated, `SAAS_ENABLED` missing, or report mail while `INTAKE_DOMAIN` is missing | the Worker throws (deployment problem, not the sender's) |
| `check+` mail while `CANARY_DOMAIN` is not set | `setReject` (unknown recipient) |
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

### Tiers and what counts

A report address is public (it sits in the customer's DMARC record), so anybody can mail it. What counts is decided from **who sent the mail**, not from what the report says about itself.

**Order of work** (cheap and unforgeable first; `src/hosted/intake.ts`): (a) recipient, token and raw size; (b) classify the **carrier**: read the topmost authentication header and see whether it authenticates the From address and whether the sender is in the registry; (c) charge the caps (instance, workspace, address, and the tier's own) **before decompressing anything**; (d) decompress with a hard cap by carrier class (`INTAKE_MAX_DECOMPRESSED_BYTES` for a registry sender, `INTAKE_MAX_NONREGISTRY_DECOMPRESSED_BYTES` for anyone else); (e) parse, then decide the tier from the report's own metadata.

**Authenticated.** `AUTHSERV_ID` and `AUTHSERV_HEADER` are set; the header read is the **topmost** `Authentication-Results` (`ar`) or the topmost `ARC-Authentication-Results` with `i=1` (`arc`), taken from the raw message; its authserv-id equals `AUTHSERV_ID` (a header the sender added is ignored); and it shows **any** `dkim=pass` (`header.d`, or without it the domain of `header.i`) or a `dmarc=pass` (`header.from`) **aligned (same organisational domain) with the From address**, which must be exactly one address. A message with two signatures has two `dkim` results and all of them are collected: a later one never overwrites an earlier one. SPF alone never authenticates. Mail with no authentication results at all is unauthenticated (fail closed).

**Receiver extensions and copied envelope senders.** A bare `word=value` inside a resinfo (an extension such as `action=none`) no longer fails the header: it and the rest of that resinfo are skipped, which can lose a pass but never create one (a method is only read after a top-level `;`). A receiver that copies a sender-chosen envelope address unquoted into `smtp.mailfrom` lets that sender's `;` start a resinfo the receiver never wrote (`x;dkim=pass header.d=google.com;arc=none smtp.x=y@attacker.example`); no tokenizer can tell, so a carrier whose envelope sender is not a plain address is not believed (`guardEnvelope`, reason `authres_malformed`).

**How the header is read (`src/email/auth-results.ts`, RFC 8601 §2.2).** A real tokenizer, not a text search: CFWS with nested comments and quoted-pairs, quoted strings with backslash escapes, the authserv-id, an optional version, then `;`-separated results. A method (`dkim`, `spf`, `dmarc`, `arc`, …) is read **only at the start of a result**, and its `ptype.property=value` pairs belong to that method alone. Text the sender influences (a quoted local part such as `smtp.mailfrom="x dkim=pass header.d=google.com y"@attacker.example`, a comment the receiver copies, `header.i`) is one value or one comment and can never become a result: the security review stored two such forgeries as counted Google reports before this. Names are case-insensitive. Folded lines are unfolded first. `none` yields no methods.

**It fails closed for the whole header** (the message is unauthenticated; `reporter_auth_reason` says `authres_malformed`, `authres_too_long` or `authres_version_unsupported`) on: a header longer than **8,192 characters** (every real receiver's header is under 2 KiB; 8 KiB leaves an order of magnitude of room but bounds the work and what a sender can stuff into it), NUL or any control character, unbalanced quotes or parentheses, comments nested deeper than 32, a character outside the grammar, an empty value, a property that appears twice in one result, more than 64 results, and a **version other than 1**. Version: `authserv-id [CFWS] authres-version` is allowed and only version **1** is defined (RFC 8601); no version means 1; `1` is accepted and anything else is refused, because we cannot know what a later version means. Known consequence: a receiver that writes non-standard properties (Microsoft's own `action=none`, `compauth=pass reason=100`) is refused too; the trusted receiver here is Cloudflare, whose header is `Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass`.

**The registry** (`src/dmarc/known-reporters.ts`): an entry matches when the passing DKIM organisation **and** the From address are the entry's, and the report's own `report_metadata/email` is in the entry's accepted set. `org_name`, `Submitter` and the subject decide nothing: they are labels.

| Tier | When | Stored | Counted | Caps | IP lookups | Kept |
|------|------|--------|---------|------|------------|------|
| **counted** | authenticated + registry match + accepted report email | yes | yes | `INTAKE_MAX_REPORTS_PER_DAY`, `INTAKE_MAX_RECORDS_PER_REPORT`, … | yes (budget `INTAKE_MAX_NEW_IPS_PER_REPORT`) | 13 months |
| **received, not counted: authenticated** (`unknown`) | authenticated, not in the registry (or a registry sender whose report email is not accepted: drift is never silently trusted) | yes | no | `INTAKE_MAX_UNKNOWN_*` and the **uncounted** budgets (`INTAKE_MAX_UNCOUNTED_*`) | small budget | `RETENTION_UNCOUNTED_REPORTS_DAYS` (30) |
| **received, not counted: unauthenticated** | anything else that is a well-formed report for a domain the token owns | yes | no | `INTAKE_MAX_UNAUTH_*` and the **uncounted** budgets | **none** | `RETENTION_UNCOUNTED_REPORTS_DAYS` (30) |
| **refused** | malformed, not a report, over a cap (non-registry senders: 5xx), a domain the token does not own | no | n/a | | | |

**Registry reporters are never refused for being over a cap.** Over a cap they are *accepted and dropped* (reason `over_cap_accepted_dropped`, counted for the owner), because whether Google or Microsoft stop sending after a 5xx is unverified. Everyone else over a cap keeps the 5xx.

**Dedup** is on (domain, **reporter identity**, report id), decided after the sender is classified. **Every** stored report with an identity keeps its id as `<identity>|<id>` (the registry id for a counted report: `google|abc`, `microsoft|abc`; the authenticated organisation for an unknown one; `~unauth` for an unauthenticated one), so Google and Microsoft may reuse one report id and both are stored and counted, a redelivery of each is a duplicate, and a forger cannot squat a real reporter's id. A **legacy** row stored under the plain id (before this change, or with no identity) is still recognised as a duplicate on redelivery when its identity is unknown or the same. An uncounted report is also a duplicate of any counted report with that id, and a counted report **supersedes** an earlier uncounted one with the same id in the same atomic batch (log: `dedup":"superseded"`), giving back that report's uncounted storage.

**The registry today** (every entry has evidence in `src/dmarc/known-reporters.ts` and a real report email under `test/fixtures/third-party/`, see `test/fixtures/THIRD_PARTY.md`): Google, Microsoft, Yahoo (also sends AOL's reports), Mail.ru, Amazon SES, Mimecast (the **au-1** region only: that is what the sample shows, From and report email `no-reply@au-1.mimecastreport.com`; any other Mimecast region is stored as unknown until confirmed), XS4ALL, Fastmail. Named but **not** included for want of a verified report email: Comcast, Yandex, Zoho, GMX/web.de/mail.com, Seznam, Apple/iCloud, Proofpoint, Cisco/IronPort, LinkedIn, QQ, Naver, Orange, Free, Ziggo. Extend with `INTAKE_KNOWN_REPORTERS`; switch entries off with `INTAKE_KNOWN_REPORTERS_DISABLE`.

**Candidates.** Every authenticated sender that is not in the registry is recorded instance-wide (`reporter_candidates`: DKIM organisation, From domain, the report's `org_name` and report email, counts; no content, no customer) and logged as `{"evt":"intake_reporter_candidate",…}`. The sender-written text (`org_name`, report email, From) is capped at **64 characters** and stripped of control characters (also bidi controls and line separators) in the log line, when stored, and again when listed. The instance owner reads them at `GET /api/instance/reporter-candidates`. **A candidate is never promoted automatically**: the owner reads real mail and adds an entry with `INTAKE_KNOWN_REPORTERS`. `GET /api/instance/intake-status` says whether anything can be counted (see below).

Stored with each report: `reporter_tier` (`counted`, `unknown`, `unauthenticated`; `NULL` = stored before tiers existed), `reporter_identity`, `reporter_known_as` (the registry label), `reporter_auth` (`pass`, `fail`, `none`), `reporter_auth_domain` and `reporter_auth_reason`.

**What counts.** `REPORT_COUNTING=registry` (hosted default): only `reporter_tier = 'counted'` reports feed pass rates, failing senders and fix lists, anomalies, "safe to enforce" and the rollout gate, levels, the weekly digest, the CSV totals, the MCP/health report and every number in `packages/db/src/queries/{reports,analytics}.ts`. `authenticated` counts every report whose carrier authenticated (`reporter_auth = 'pass'`), registry or not. `all` counts everything. Rows stored before the column existed (`NULL`): not counted in `registry`, counted in `authenticated` only if `reporter_auth = 'pass'`, counted in `all`. Reports that are not counted stay visible in the report browser, labelled, and sort **after** counted ones, so a flood cannot push real ones out of "latest N".

**Every percentage names its reporters.** `reporters.attribution` ("from 12 reports by Google, Microsoft") is on the same endpoints as the numbers. **"Safe to enforce" advice needs a counted report from Google or Microsoft** in the window (`reporters.major`); from other reporters alone it says "No counted report from Google or Microsoft yet".

**The instance owner is told when nothing can count** (`GET /api/instance/intake-status`; `intakeAuthStatus` in `src/reports/auth-status.ts` is pure and exported for the setup check): "No report can be counted until AUTHSERV_ID and AUTHSERV_HEADER are set." · "No report can be counted: inbound mail carries no authentication results." · "No report can be counted: the authentication results on inbound mail do not name the configured AUTHSERV_ID." · "No report can be counted: no inbound message has authenticated yet." Based on an instance-wide counter of what inbound mail carried (last 3 days), no address kept.

**Residual risks.** (1) An attacker who owns a domain with working DKIM is authenticated as that domain, but is *unknown* or *unauthenticated* unless they are a registry reporter: they cannot move a number. (2) A registry reporter's own mail is the trust root: Google and Microsoft report mail is counted. (3) Whether registry reporters retry after a 5xx is unverified, hence accept-and-drop. (4) Mail delivered by Cloudflare without `Authentication-Results` (cloudflare/workerd#6740) leaves nothing countable: the owner is told (above). (5) Fastmail's DKIM signing domain was not observed in the sample (see the entry's caveat). Mimecast: the sample's report XML does extract with the hardened extractor (the gzip framing is malformed) and its `report_metadata/email` is `no-reply@au-1.mimecastreport.com`, so the entry lists exactly that region and no longer carries an "unconfirmed" caveat. (6) **Rows stored before this change have `reporter_tier` NULL and stop counting in `registry` mode.** No hosted report exists yet, so nothing is lost there; self-host rows keep counting (`REPORT_COUNTING=all`).

### AUTHSERV discovery

**Expected values** (Cloudflare's documentation, <https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results>, read 2026-11-14): "Email Routing validates Domain-based Message Authentication, Reporting & Conformance (DMARC) before invoking your Worker. It prepends a standard Authentication-Results header that records SPF, DKIM, and DMARC results in a machine-readable format. A simplified header with passing results looks like this: `Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass`. To check for `dmarc=pass`, read the first Authentication-Results header through `message.headers` and verify that its authentication service identifier is `mx.cloudflare.net`. Other Authentication-Results headers may have been supplied by the sender and should not be trusted. Cloudflare invokes the Worker directly, so Authenticated Received Chain (ARC) verification is not required to trust this result." So the expected settings are `AUTHSERV_ID=mx.cloudflare.net` and `AUTHSERV_HEADER=ar`, **to be confirmed on one real routed message** (the repository cannot send mail through Cloudflare).

**Confirm it against a message you sent yourself.** The Worker also logs what it *observed* (below), but that is only what an inbound message said: if Cloudflare ever adds no header of its own, the topmost `Authentication-Results` is the sender's, and an attacker can write any authserv-id there. Never set `AUTHSERV_ID` from a log line alone. With `AUTHSERV_ID`/`AUTHSERV_HEADER` unset (or set to something the message does not name), the first routed messages log, without storing anything:

```
{"evt":"intake_authserv","v":2,"configured":false,"observed_ar":"mx.cloudflare.net","observed_arc":"mx.cloudflare.net","observed_arc_i":1,"note":"observed on an inbound message; confirm against a message you sent yourself before setting AUTHSERV_ID"}
```

The observed values are printable ASCII without spaces, at most 64 characters (an address, a control character or anything else gives `null`), so a hostile header cannot put an instruction or an escape sequence into the log. Steps: (1) route `rua@` to the Worker (section 2); (2) **send one mail yourself** from a domain with working DKIM to `rua+<a real token>@…`; (3) read the raw headers of what arrived, or `wrangler tail --format json | jq -c 'select(.logs[]?.message[0] | tostring | test("intake_authserv"))'`, and check the topmost `Authentication-Results` is Cloudflare's (`mx.cloudflare.net`) and that your own message shows no earlier one; (4) set `AUTHSERV_ID=mx.cloudflare.net` and `AUTHSERV_HEADER=ar` (or the `arc` equivalents when there is no plain header); (5) send a crafted message with your own extra `Authentication-Results` line and check it is not trusted ([email-funnel.md](email-funnel.md)). Only messages that reached a valid token are logged, at most 5 per isolate per hour.

### Logs

One JSON line per inbound message, `console.log` for accepted, `console.warn` for refused/deferred:

```
{"evt":"intake","v":1,"kind":"rua","outcome":"accepted","reason":"ok","tier":"counted","reporter":"google","dkim_org":"google.com","from_org":"google.com","email_matched":true,"dedup":"new","size":5321,"records":87,"ms":412,"ws":"ws_a1b2","dom":12}
```

`kind` rua | tls-rpt | canary | other; `outcome` accepted | duplicate | refused | deferred; `tier` counted | unknown | unauthenticated | null (null: refused before it was decided); `reporter` is the reporter identity (the registry id, else the authenticated organisation, else `~unauth`); `dkim_org` and `from_org` are the carrier's passing DKIM organisation and From organisation; `email_matched` says whether the report's own email matched the registry entry (null: no entry matched the carrier); `dedup` new | duplicate | superseded;  `ws`/`dom` are internal ids. There are never report contents, tokens, addresses, sender or customer domains. (Real lines from the workerd run are in the pull request.) Reasons: `ok duplicate bad_recipient wrong_host unknown_token raw_too_large cap_address_day cap_unknown_day cap_unknown_reporter_day cap_unauth_day cap_unauth_total_day cap_uncounted_workspace_day cap_uncounted_instance_day cap_uncounted_address_records cap_uncounted_workspace_storage cap_uncounted_instance_storage over_cap_accepted_dropped cap_workspace_day cap_instance_day cap_address_records cap_workspace_storage cap_instance_storage no_attachment wrong_attachment_type archive_invalid decompressed_too_large xml_invalid json_invalid kind_mismatch_tlsrpt_to_rua kind_mismatch_rua_to_tlsrpt too_many_records field_too_long date_range_invalid domain_not_owned authserv_unconfigured no_authentication_results authserv_id_not_found authres_malformed authres_too_long authres_version_unsupported from_invalid not_authenticated storage_failed storage_failed_repeatedly not_configured schema_not_ready internal_error`.

### Hostile input

Refused with a reason, nothing stored: gzip/zip bombs (inflation stops at the decompression cap of the carrier class, 1 MiB for anyone but a registry reporter; a zip's declared sizes are not trusted; more than 2 entries), a gzip inside a gzip (the inner stream is not inflated), DOCTYPE/ENTITY, invalid UTF-8, fields over their limits (org_name and report_id 256, domains 253, IP 45, other strings 512), XML nested deeper than 20 levels or with more than 20 elements per allowed record, control characters, a report whose period ends more than 2 days in the future, ends before it begins, spans more than 31 days or begins before 2012, a count above 2³¹−1 (clamped), a domain the token does not own (hosted answers "Report is for a domain this address does not belong to" and never echoes the sender's domain; self-host keeps "Unknown domain X — not a registered Ready Set Mail inbox"), a gzip header over 1 KiB. A duplicate report id is accepted once and never counted twice.

### Measured limits

Measured on this repository's code (2026-11-14) in two ways. The first is authoritative for memory and CPU; the second explains it.

**1. The real Worker under `wrangler dev` (workerd 4.92.0, linux-arm64).** A local worker with `MODE=saas`, a seeded workspace, domain and token in local D1, driven by HTTP POSTs. `wrangler dev`'s own email endpoint (`POST /cdn-cgi/handler/email`) refuses messages over **1 MiB** ("the lower 1Mib limit for testing locally"), so the size runs used a measurement-only entry point (not committed) that hands a request body to the Worker's real `email()` export as the `raw` stream; the end-to-end runs below used the real `/cdn-cgi/handler/email` endpoint. Per message: **CPU** = delta of `utime+stime` of every `workerd` process from `/proc/<pid>/stat` (10 ms ticks; includes GC threads and the local D1's SQLite, which in production runs remotely), **memory** = peak of the summed `VmRSS` of the `workerd` processes sampled every 5 ms from `/proc/<pid>/status`, minus the sum just before the message (after a warm-up message), on a fresh `wrangler dev` per case. Timers inside workerd cannot measure CPU: `Date.now()` and `performance.now()` only advance on I/O. Enrichment lookups were limited to 1 IP per report (`INTAKE_MAX_NEW_IPS_PER_REPORT=1`): the sandbox has no outbound network, and waiting on DNS is not CPU.

First message through a fresh isolate, re-measured on 2026-11-14 after the three-tier change with a counted Google report (the heaviest tier; unknown and unauthenticated reports are capped lower and skip IP lookups) (hosted defaults: 2,000 records / 1 MiB decompressed / 2 MiB raw):

| Case | Raw message | CPU per message | Peak RSS over idle (first message) |
|------|------------:|----------------:|------------------------------------:|
| small: 1 record | 1 KB | 0.04 s | +3 MB |
| typical: 200 records, Google-like gzip | 3 KB | 0.11 s (then ~0.08) | +10 MB |
| 2,000 records (the cap) | 20 KB | 0.40 s | +45 MB |
| decompressed cap: 1 MiB of XML, incompressible | 0.24 MiB | 0.45 s | +67 MB |
| raw cap: a 2 MiB message holding a small report | 2 MiB | 0.11 s (not re-run after the tier change; the report path is unchanged) | +17 MB |
| **worst case: records, 1 MiB incompressible XML and 2 MiB raw together** | 2 MiB | 0.46 s | **+73 MB** |
| self-host defaults (2,500 / 1.25 MiB / 2 MiB), worst case | 2 MiB | 0.50 s | +84 MB (measured before the tier change) |

Later messages in the same isolate show higher resident sizes (+100 to +190 MB after five worst-case messages): the heap is not returned to the OS and nothing forces collection locally. Production enforces the 128 MB limit with garbage collection, so this overstates the live set, but it is the reason the defaults aim for a first-message worst case of about 80 MB rather than for 128. The first defaults I measured (5,000 records / 3 MiB / 10 MiB) peaked at **+165 MB** on one message and were **not** honest for a 128 MB isolate; they were lowered until the worst case fell under ~90 MB.

**Findings from the measurement.** (1) A gzip whose header carries a multi-megabyte comment made one 10 MiB message cost **88 s of CPU** (quadratic copying in fflate's streaming Gunzip: 2 MB of comment = 6 s even in Node); a gzip header over 1 KiB is now refused (`archive_invalid`, `MAX_GZIP_HEADER` in `src/dmarc/extract-report.ts`). (2) Inflating in 1 KiB steps cost ~50 MB more RSS than 16 KiB steps on an incompressible report; the step is 4 KiB (a bomb at 1032:1 can overshoot the cap by ~4 MB before it is noticed).

**2. Node, parse only** (`scripts/measure-parse.ts`, `scripts/measure-mime.ts`): parsing keeps ~7 KB of live heap per record (5,000 records: 36 MB; 20,000: 119 MB), and reading the attachment of a 10 MB message peaked at ~16x its size in Node but ~4x in workerd (+43 MB for a 10 MiB message with a small report), because Node's RSS counts garbage that workerd's runtime reclaims sooner.

**Recommended `limits.cpu_ms`: 5000.** The worst case above is 0.5 s of CPU; the default of Workers Paid is 30 s. 5 s is ten times the worst measured case, and kills a pathological input at 5 s instead of 30 (the gzip header above would have run to the 30 s default). A Free plan (10 ms CPU) cannot parse even a 200-record report, so hosted intake needs Workers Paid (<https://developers.cloudflare.com/workers/platform/limits/>: "5 min (default: 30 seconds)", configurable up to 300,000 ms; "Each isolate can consume up to 128 MB of memory"). Email Workers count toward these limits (<https://developers.cloudflare.com/email-routing/limits/>).

**How far to trust the numbers.** workerd is the production runtime's open-source core, so CPU per message and the shape of memory use carry over; the absolute values do not. They include a local SQLite D1 in the same process (production D1 is remote, which lowers CPU and memory), exclude real network latency (D1 round trips, DNS-over-HTTPS), and Cloudflare's CPU billing, isolate sharing and garbage collection are not reproduced. On a 1-core arm64 sandbox, timings are not a benchmark. Watch `wrangler tail` and the Workers metrics for the first real week.

### Caps and what happens over them

Counters live in D1 and are checked **before parsing**. Naming: `INTAKE_MAX_*`; the table of defaults is in [Environment](#1-environment).

| Scope | Cap | Enforced |
|-------|-----|----------|
| one address (token) | **counted:** messages/day, stored records/day, registry reporters per reporter. **Uncounted:** unknown reporters per reporter and in total, unauthenticated per claimed sender and in total, stored records/day (`INTAKE_MAX_UNCOUNTED_ADDRESS_RECORDS_PER_DAY`) | before parsing; records after the header is read, before enrichment |
| one workspace | **counted:** messages/day, records held. **Uncounted:** its own messages/day and records held | same |
| the instance | **counted:** messages/day, records held. **Uncounted:** its own messages/day and records held | same |

**Two separate budgets.** Reports that are stored but never counted (tier `unknown` or `unauthenticated`) have their **own, much smaller** budgets, charged *instead of* the counted ones, so a stranger can never use up the room a known reporter's report needs (the security review reproduced four attacker DKIM domains filling a workspace cap, after which Google's report was accepted and dropped). Counted storage counts only counted reports (and legacy rows with no tier). `workspace_storage` holds both figures (`records`/`reports`, `uncounted_records`/`uncounted_reports`); the instance totals are the `intake_quota` rows `('*','total')` (counted) and `('*u','total')` (uncounted). Defaults: 100 uncounted messages per workspace and 2,000 per instance per day, 5,000 uncounted records per address per day, 20,000 held per workspace and 500,000 per instance. Over an uncounted cap the mail is refused for good (5xx), it is not an owner-visible failure (it is a stranger's mail), and nothing counted is touched.

**When a counted report must be dropped because the counted budget is genuinely full** (a known reporter over `INTAKE_MAX_ADDRESS_RECORDS_PER_DAY`, `INTAKE_MAX_WORKSPACE_RECORDS` or `INTAKE_MAX_INSTANCE_RECORDS`), it is still accepted and dropped, but loudly: one row per (domain, reporter) in `intake_drops` keeps the **first** drop time, and the domain's `intake.dropped[]` carries `{reporter, label, since, last_at, messages, text}` with ISO 8601 UTC times (`intake.status` is `limited`, `intake.limit` is `counted_storage_dropped`). The web renders `"Report storage limit reached; reports from {reporter} since {time} were not stored"` with the time in the user's locale and time zone (`storageDropNotice` in `web/src/lib/uncounted.ts`); the server's own `text` and the instance owner's setup check (`intakeSetupFindings`, severity `action`) show the same sentence with the time in UTC (`2026-11-14 03:12 UTC`). The state clears when a report from that reporter is stored again, and is dropped after 90 days without a new drop.

Over a cap, mail from anyone but a registry reporter is **refused for good** (5xx in the SMTP session, so no backscatter); a registry reporter's mail is **accepted and dropped** (`over_cap_accepted_dropped`). Either way it is counted for the owner and logged with its reason; a duplicate counts as a message received but adds no stored records. The records held are kept by `workspace_storage` and the instance row in `intake_quota` (the same transaction as the report), reduced by the retention sweep when reports are purged, and recounted by the daily job (5 workspaces per run, least recently counted first, so drift and data stored before the counters existed are repaired). A race between two large reports can overshoot a records cap by at most one report.
**Retention.** In the existing daily `0 4 * * *` job (statement budget 300, deletes in chunks of 500): `intake_usage` and `intake_quota` rows older than 8 days (including the per-message failure counters `sf:<hash>`), `intake_failures` and `intake_drops` older than 90 days; reports of tier `unknown` or `unauthenticated` older than `RETENTION_UNCOUNTED_REPORTS_DAYS` (30; not with `REPORT_COUNTING=all`), each giving back only its own budget; `reporter_candidate_days` older than 90 days; reports and records keep the 13 months.

### API fields for the dashboard

On `GET /api/domains/:id/stats`, `/check-summary` and `/analytics` (and `sections.dmarc` of the MCP health report): `report_counting`; `counting_note` (why nothing can be counted right now, or null); `unrecognised` (stored reports whose sender is not a registry reporter, in any mode: `reports`, `messages`, `latest_at`, `unknown`, `unauthenticated`, `by_reporter`); `uncounted` (the part of it left out of the numbers; empty when `report_counting` is `all`); `reporters` (`attribution`, `counted[]`, `major`); `intake` (`status` `ok`/`limited`/`not_processed`, `limit`, `notice`, `dropped[]` (counted reports not stored for want of storage, ISO times), `not_processed.{messages,last_at,reasons[]}`). `GET /api/reports` rows carry `counted`, `reporter_tier` and `reporter_known_as`; the CSV export has a `counted` column. Exact strings: "N reports from senders we do not recognise are not counted." · "1 report from a sender we do not recognise is not counted." · "N reports from senders that could not be authenticated are not counted." · "1 report from a sender that could not be authenticated is not counted." · "N reports are from senders we do not recognise; they are counted because this server counts every report." · "Report storage limit reached; newer reports are not being stored" · "Report storage limit reached; reports from {reporter} since {time} were not stored" (counted reports dropped; the web localises {time}) · "Daily report limit reached for this address; newer reports are not being stored until tomorrow" · "N reports received for this domain could not be processed". Web helpers: `web/src/lib/uncounted.ts`.

### Self-host: what changes

Self-host has one tenant and a private address (`rua@reports.<base>`), no tokens, no daily or per-tenant caps. What applies everywhere: the records cap (default 2,500), the decompressed cap (1.25 MiB), the raw cap (2 MiB; the same 128 MB isolate, so the measured worst case is +84 MB), the fixed query budget, atomic storage, specific refusals, the date/field/DOCTYPE checks, and the structured log line. `REPORT_COUNTING` defaults to **`all`**. Justification: every existing self-hosted install has `AUTHSERV_*` unset, so nothing can be authenticated and `registry` would zero every dashboard on upgrade; and the one sender of a self-hosted server's reports is its own mail provider. With `all`, nothing about numbers, dashboards, caps, IP lookups or retention changes on upgrade (tier restrictions are not applied, unauthenticated reports keep the 13-month window), legacy rows keep counting, and `unrecognised` says how many counted reports come from senders the registry does not know. **What does change on upgrade:** reports that are not from a counted sender are stored under `<identity>|<report id>` (a re-delivered old report is still recognised as a duplicate), the new columns are added (additive migration `0010`), and the log line gains the tier fields. To defend a self-hosted server set `AUTHSERV_*` (see below) and then `REPORT_COUNTING=registry`; the tier limits and the 30-day retention of unauthenticated reports then apply.

**Canary:** `POST /api/check-sessions` issues `check+<token>@canary.readysetmail.com`, valid for 1 hour and one email (hash stored). The email resolves to an anonymous session (`__anonymous__`, no workspace, no rows),
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
  "records": { "dmarc": "<id>._dmarc.h.readysetmail.com", "spf": "…", "tls_rpt": "…", "mta_sts": "mta-sts.<id>.h.readysetmail.com" },
  "pointers": [ { "purpose": "dmarc", "type": "CNAME", "name": "_dmarc.customer.com", "value": "<id>._dmarc.h.readysetmail.com" }, … ],
  "pointer_status": { "dmarc": "ok", "spf": "missing", "mta_sts": null, "tls_rpt": "wrong", "checked_at": 1800000000 },
  "level_inputs": { "dmarc_published": true, "spf_published": false, "mta_sts_published": false }
}
```

MTA-STS on a hosted domain: `POST /api/domains/:id/mta-sts` answers `409` (use `mta_sts: true` above); `PATCH` (mode, `refresh_mx`) and `DELETE` act on the hosted records through the hosted writer (`DELETE` removes only the MTA-STS records); the legacy daily MX job skips hosted domains and the hosted daily job refreshes them. `DELETE /api/domains/:id` removes the hosted records and quota first; if that DNS cleanup fails the domain is **not** deleted (`502`).

Errors: `409` already enabled · `422` SPF cannot be resolved, no MX for MTA-STS, several SPF records · `502` Cloudflare/DNS failure · `507` records zone full.
Enabling is all-or-nothing: if Cloudflare fails part-way, the records already written are removed.

`POST /api/check-sessions` (public) returns `{ token, email, expires_at }` in `saas` (`email` is the `check+…@canary…` address), or `404` when `CANARY_DOMAIN` is not set.

`GET /api/hosted/config` (any signed-in caller) returns `{ enabled, reports, records }`: hosted mode, report addresses (`INTAKE_DOMAIN`), hosted records (`HOSTED_RECORDS_ZONE`).

Connecting reports (see [above](#report-address-without-hosted-records); `404` outside hosted mode; writes need an owner/admin):

| Method & path | Response |
|---------------|----------|
| `GET /api/domains/:id/report-address` | `{ available: false }` without `INTAKE_DOMAIN`, else `{ available, domain_id, domain, managed_by, can_connect, refusal, address, connected_at, last_report_at, reports_since_connect, reports_before_connect, state, dns: { checked_at, error, plan } \| null, parent }`. `plan.kind` is `published`, `add`, `choose`, `multiple`, `invalid` (no valid `p=`: fix it first) or `inherited` (with `policy_tag` `sp`/`p`) |
| `POST /api/domains/:id/report-address` | connect: `201` with the status; `200` and the unchanged status when already connected; `403` for a `legacy` row, an orphaned subdomain, or a workspace `HOSTED_CONNECT_REPORTS` does not admit; `409` with hosted records |
| `DELETE /api/domains/:id/report-address` | disconnect: the status (`not_connected`) |

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
