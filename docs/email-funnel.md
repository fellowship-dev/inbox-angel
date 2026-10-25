# Email funnel: free-check leads, onboarding sequence, compliance

What a free email check leads to, and the rules every non-transactional email follows. Code: `src/funnel/`, `src/mail/`.
Copy for the sequence is in **one file**, `src/funnel/copy.ts` (a draft for review).

## Flow

1. A visitor sends a real email to their `check+<token>@` address (`POST /api/check-sessions`). We reply with the report.
2. If the sequence is on and the sender is eligible (below), the sender becomes a **lead** and the reply says so in one line, with an unsubscribe link.
3. The daily cron (`0 8 * * *`) sends **one step per due lead**: day 1, 3, 6, 10 and 14 after enrolment (`SEQUENCE_DAYS`).
4. The sequence stops on unsubscribe, a bounce, an account with the same email (they bought), or when the instance owner records *replied*, *booked* or *converted* (`POST /api/leads/:id/stop`, or the Leads page).

**Eligibility (fails closed).** A lead is created only when the sender proved control of the domain of their address, from the receiving server's own results, and only when **both `AUTHSERV_ID` and `AUTHSERV_HEADER` are set**. Nothing guarantees which header Cloudflare adds (a plain `Authentication-Results`, or only `ARC-Authentication-Results`), and if both kinds were trusted the sender could forge whichever kind the receiver does not add, using our guessable authserv-id. So until an operator has set both, everyone still gets the report but nobody is enrolled, and the log says `sender not enrolled in the sequence: AUTHSERV_ID is not set` (or `AUTHSERV_HEADER is not set`; the Leads page warns too). With both set (`src/email/sender-proof.ts`):

- `AUTHSERV_HEADER=ar`: the **topmost** `Authentication-Results`, read from the raw message (`Headers.get` joins duplicates), must name `AUTHSERV_ID` as its authserv-id. `ARC-Authentication-Results` is not consulted.
- `AUTHSERV_HEADER=arc`: the topmost `ARC-Authentication-Results` must have `i=1` and that authserv-id. A plain `Authentication-Results` is not consulted.
- A header the sender adds, or one naming another server, is ignored.
- The results must show a DKIM pass aligned with the address's domain, or a DMARC pass for it. SPF alone is not accepted.

**Ops step (Max): set both values from one routed message.** Send one email from a domain with working DKIM to a routed address (a `check+<token>@` address, or any Email Routing address that forwards to your own inbox) and open the delivered message's raw source. Look at the header block's very top and find what the receiving side added:

- `Authentication-Results: <authserv-id>; dkim=pass …` → set `AUTHSERV_HEADER=ar`;
- or `ARC-Authentication-Results: i=1; <authserv-id>; …` (and no plain one from the same server) → set `AUTHSERV_HEADER=arc`.

`AUTHSERV_ID` is the text before the first `;` (after `i=1;` for ARC). Then craft a message with your own extra `Authentication-Results` and `ARC-Authentication-Results` lines and check that Cloudflare's line sits above them. Until both are set, the sequence enrols nobody.

**Switch.** Hosted: on unless `ONBOARDING_SEQUENCE_ENABLED=0`. Self-host: off unless `ONBOARDING_SEQUENCE_ENABLED=1`.

**Never twice.** A run marks the step as sent (compare-and-set on `step` and the due time) **before** it sends, so overlapping runs, retries and a crash right after the provider took the mail cannot send a step twice. The cost is deliberate: a crash or an ambiguous failure (a timeout) can lose that one email. Anything that is not provably the recipient's fault (bad key or `from`, unverified domain, quota, an unrecognised error, an internal error) puts the step back and stops the run, so one fault cannot burn a whole batch; only an outcome that may have been delivered (network error, 5xx) keeps the step marked and stops the run after that one lead. A lead that is behind gets one email per run, about a day apart (23 hours, so a cron tick that fires a few seconds early still finds it due). Leads waiting for `BOOKING_URL` are pushed a day out so they cannot fill the batch.

**With no provider** (`RESEND_API_KEY` unset) the sequence queues and sends nothing. The Leads page (and `GET /api/leads` → `delivery.blockers`) says why, or that `PUBLIC_BASE_URL` / `POSTAL_ADDRESS` / `MAIL_FROM` is missing. A missing `BOOKING_URL` holds only the day-14 note; missing `SERVICE_PRICES` sends day 10 without prices.

## Free-check delivery

The report goes back to the sender in two steps (`src/email/free-check.ts`):

1. **`message.reply()`**, threaded under the original. Cloudflare's Email Workers rules (checked 2026-10-24, <https://developers.cloudflare.com/email-routing/email-workers/reply-email-workers/>): "The incoming email must have a valid DMARC result", "An email can only be replied to once per `EmailMessage` event", "The recipient in the reply must match the sender of the incoming email", "The outgoing sender domain must match the domain that received the email", and more than 100 `References` entries is rejected; "otherwise `reply()` throws an exception". A sender with no DMARC, or one that fails it, is therefore refused.
2. **When `reply()` throws**, the same subject, text and HTML go out as a new email through the `SEND_EMAIL` binding, from the same address, with `In-Reply-To`/`References` (allowlisted threading headers) and, for enrolled leads, the same `List-Unsubscribe` headers. Email Service: "Before you onboard a sending domain, you can send emails only to verified destination addresses in your account"; after onboarding "you can send to any recipient immediately" (<https://developers.cloudflare.com/email-service/platform/limits/>); "Arbitrary-recipient sending requires Workers Paid" (<https://developers.cloudflare.com/email-service/>); the sender must be on an onboarded domain (<https://developers.cloudflare.com/email-service/configuration/send-bindings/>). **Ops step: onboard the reports domain in Email Service**, or strangers without DMARC get nothing.

Every report ends with "Need help? Any doubts? Reply." and carries `MAIL_REPLY_TO` as Reply-To on both paths. Its closing states retention truthfully: not enrolled, "kept for N days" from `RETENTION_CHECK_RESULTS_DAYS` (default 30, the setting that purges `check_results`); enrolled, kept while they receive follow-ups and deleted on unsubscribe (the `leads` behaviour below).

If both fail (or there is no binding), the error is logged as `free-check: report not delivered: …` and the check result is still stored, with `report_sent = 0`. Resend is not used as a third path: the report's sender is the reports domain, which is not verified at Resend.

## Sending provider

**The sequence is sent with Resend only** (`RESEND_API_KEY`, sender `MAIL_FROM`). Cloudflare Email Service is for transactional mail only, and a five-step BIMI/upsell sequence is marketing mail:

> "No. Email Service supports transactional email only." (FAQ) and "sends outbound transactional emails" (overview)
> <https://developers.cloudflare.com/email-service/reference/faq/>, <https://developers.cloudflare.com/email-service/>

`Mailer` (`src/mail/mailer.ts`) picks by purpose:

| Purpose | Provider |
|---|---|
| Onboarding sequence (marketing, from `MAIL_FROM`) | Resend only |
| Change alerts and weekly digests (to the owner's team, from the workspace's own sender) | the `send_email` binding, unchanged. Resend is not used: workspace sender domains are not verified there |
| Free-check report when `reply()` is refused (transactional, to the sender) | the binding only; see [Free-check delivery](#free-check-delivery) |
| Monitor confirmation (transactional, arbitrary address) | the binding if present (then it reaches verified addresses, or anyone once a sending domain is onboarded), else Resend from `MAIL_FROM` |

Cloudflare Email Service facts (checked 2026-10-23), relevant to the transactional/owner mail that still uses it:

- Beta, Workers Paid. Any recipient once a sending domain is onboarded; verified destinations only before that. Sending only from your own routing domains. <https://developers.cloudflare.com/email-service/>, <https://developers.cloudflare.com/email-service/platform/limits/>
- Same `send_email` binding and `send({ from, to, subject, text, html, replyTo, headers })` shape, returns `{ messageId }`. A recipient outside `allowed_destination_addresses` raises `E_RECIPIENT_NOT_ALLOWED`. <https://developers.cloudflare.com/email-service/api/send-emails/workers-api/>
- `List-Unsubscribe` (HTTPS or mailto) and `List-Unsubscribe-Post` (exactly `List-Unsubscribe=One-Click`) are allowlisted; an unlisted non-`X-` header fails the send. <https://developers.cloudflare.com/email-service/reference/headers/>
- A conservative daily quota for new accounts (no published number); 3,000 emails a month included, then $0.35 per 1,000. <https://developers.cloudflare.com/email-service/platform/pricing/>

Resend: `POST https://api.resend.com/emails`, `Authorization: Bearer`, fields `from`, `to`, `subject`, `text`, `html`, `headers`, `reply_to`; optional `Idempotency-Key` (kept 24 hours, so it is a second line of defence, not the guarantee). <https://resend.com/docs/api-reference/emails/send-email>, <https://resend.com/docs/dashboard/emails/idempotency-keys>

**Errors are not bounces.** Resend's API errors (<https://resend.com/docs/api-reference/errors>) name no recipient-specific error: an invalid `to`, a bad `from` and an unverified domain all arrive as `validation_error`, told apart only by message text. So nothing from Resend is classified as a recipient error, and a bad `MAIL_FROM` cannot bounce and suppress leads. Only an explicit refusal (the Cloudflare binding's `E_RECIPIENT_*` codes, used for confirmations and owner mail) bounces a lead. Not built: hard bounces and complaints after Resend accepts a message need a Resend webhook.

## Compliance (all non-transactional mail)

Sequence, change alerts and weekly digests go through `sendNonTransactional` (`src/mail/compliance.ts`):

- **Suppression check before every send.** `suppression` stores a SHA-256 of the lower-cased address, never the address.
- **One-click unsubscribe:** a signed link in the body and the headers `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. `GET` (the link) and `POST` (RFC 8058) on `/api/unsubscribe?t=<token>` need no login. Unsubscribing suppresses the address, deletes its lead **at once** and its change-alert subscriptions in every workspace. The link acts on `GET`, so a mail scanner that prefetches links can unsubscribe someone; that fails safe.
- **Token.** The payload (which holds the address) is AES-256-GCM encrypted and the token is HMAC-authenticated (`base64url(iv‖ciphertext).base64url(mac)`), both keys derived from the auth secret with purpose labels. The address is therefore not readable in the URL, request logs or a forwarded email; tampering, another purpose or another secret is rejected. Unsubscribe tokens do not expire; confirmation tokens last 7 days.
- **Links are HTTPS only** (`PUBLIC_BASE_URL`; `http://localhost` is allowed for development): providers reject a plain-HTTP `List-Unsubscribe`.
- **Postal address footer** from `POSTAL_ADDRESS`.
- Hosted: no `PUBLIC_BASE_URL` means no send. Self-host alerts and digests still go without a link when it is unset (the recipients are the instance's own team) but keep the footer and suppression check. They always go through the `send_email` binding.

Transactional mail (password reset, invites, the monitor confirmation, "first report", "connection broken") does not carry the unsubscribe footer and is not suppression-checked.

## `POST /api/monitor` double opt-in

The request stores an **unconfirmed** subscription (`confirmed_at` null) and emails a link (`/api/monitor/confirm?t=`). Only confirmed subscriptions are checked and alerted. Unconfirmed rows are deleted after 7 days by the daily cron. **Opening the link shows a "Confirm alerts" button; only the POST confirms**, so a mail security scanner that follows links cannot confirm for the owner. Caps on how many confirmation emails a requester can cause: 20 per client IP per hour, 3 per free-check session in total (per week), 3 per target address per day (all keyed hashes). Hitting the per-address cap, a suppressed address and an already confirmed address all get the same `202` and no email (the cap is logged), so a real user is never told they are blocked; if the bare binding refuses an unverified address the request answers `502` instead of promising an email.

## Other changes

- **Self-host unknown addresses** are dropped (`setReject` + a log line without the sender) unless they are a valid, unused `check+<token>@`. Self-host `POST /api/check-sessions` now issues `check+<token>@<reports domain>` using the same expiring, single-use token table as the hosted canary.
- **CORS.** Only `POST /api/check-sessions` and `GET /api/check-sessions/:token`, only for origins listed in `SITE_ORIGINS` (exact match, no wildcard, no credentials).
- **Session rate limit.** 10 per hour per IP; the IP (and any email) in a rate-limit key is stored only as a keyed HMAC, not a plain hash.
- **Retention.** Leads are deleted 12 months after last activity (`last_activity_at` is refreshed by a new check) and immediately on unsubscribe.
- **Admin.** `GET /api/leads` and the Leads page: instance owner only (`OWNER_EMAIL`; self-host without it: the owner of the default workspace; hosted requires `OWNER_EMAIL`).

## Configuration

| Variable | Purpose |
|---|---|
| `ONBOARDING_SEQUENCE_ENABLED` | `1` to turn on (self-host); hosted is on unless `0` |
| `RESEND_API_KEY` | Resend, for the sequence (and the confirmation when there is no binding) |
| `AUTHSERV_ID` | **required for enrolment**: the receiver's authserv-id, see the ops step above |
| `AUTHSERV_HEADER` | **required for enrolment**: `ar` or `arc`, the one header kind the receiver adds |
| `MAIL_FROM`, `MAIL_FROM_NAME` | sender of sequence mail (default `noreply@<CANARY_DOMAIN>`) |
| `MAIL_REPLY_TO` | **required for replies**: Reply-To of sequence mail **and of the free-check report**. No fallback (falling back to `OWNER_EMAIL` would publish the admin login to every sender); unset means no Reply-To, and `GET /api/leads` warns even when the sequence is off |
| `SITE_URL` | public marketing site (`https://` only), for links in the free-check report; unset means no marketing link (never the Worker's own origin) |
| `PUBLIC_BASE_URL` | public HTTPS origin for unsubscribe and confirmation links (falls back to `BETTER_AUTH_URL`) |
| `POSTAL_ADDRESS` | footer address |
| `BOOKING_URL` | day-14 booking link |
| `SERVICE_PRICES` | JSON `{"fix","keepFixed","bimi"}` strings (e.g. `"from $990"`, `"$49/month per domain"`, `"$1,990/year or $199/month"`), the prices in the day-10 email |
| `SITE_ORIGINS` | comma-separated origins for CORS |
