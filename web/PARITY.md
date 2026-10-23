# Dashboard v2: parity checklist

The inventory of the Preact dashboard (`dashboard/`), screen by screen, with one checkbox per user-visible
feature or action. `[x]` means it is implemented in `web/` (the file is named after the arrow); `[~]` means
implemented with a deliberate change (explained in the line); `[ ]` means not done (listed again under *Gaps*
at the bottom). Checked against the running app by the e2e suite and the route tests where noted.

Intentional changes that apply everywhere (not repeated per line):

- Hash routes are kept (`#/domains/1`), so reset and invite emails and bookmarks keep working.
- One `api()` client: a 401 anywhere signs the user out; 403 reads as "not allowed" and never as a generic failure.
- Members (role `member`) see every screen but all write controls are disabled with an explanation (`WriteButton`, `ReadOnlyNotice`); the API still enforces it.
- Loading skeletons, empty states and error states with retry on every data screen. A DNS lookup that failed is shown as "Lookup failed" (CheckResult `error`), never as "Not found".
- Light/dark (follows the OS, toggle persisted in `ia_theme`), mobile layout checked at 375px.
- New session token key is unchanged (`ia_api_key`), so people stay signed in across the switch.

Inventory (generated from reading every file under `dashboard/src`; section numbers are kept for cross-reference):

Legend: `- [x]` = one user-visible feature/action to re-verify in the port. `API:` = endpoint called. `Note:` = non-obvious behaviour.

## 0. Global conventions (apply everywhere)

- [x] Hash routing: route = `location.hash` minus leading `#`, default `/`. `hashchange` listener updates state. No query params are used by any dashboard route (only API calls use query strings).
- [x] API auth: every `apiFetch` call sends header `X-Api-Key: <localStorage 'ia_api_key'>` plus `Content-Type: application/json`. Key is a bearer-ish session token returned by login/setup/signup/invite/reset. Exception: `/api/version`, `/api/auth/*`, `/api/invites/*`, `/api/check-sessions*` are called with raw `fetch` (no key header).
- [x] 401 handling contract: `throwApiError` throws `Error('401')` literally for status 401. Pages check `e.message === '401'` and call `onUnauthorized()` -> `App.handleUnauth` = remove `ia_api_key` from localStorage, `hasKey=false` -> AuthGate rendered. (Not every page does this; see per-page notes.)
- [x] Error message mapping (non-401): server JSON `{error}` wins; else fallback 403 "You don't have permission to do that", 404 "Not found", 409 "Already exists", 429 "Too many requests - please wait a moment and try again", 500 "Server error - please try again", 503 "Service unavailable - please try again shortly", else "Unexpected error (<status>)".
- [x] Mobile layout flag `useIsMobile` = `window.innerWidth < 600` (resize listener). Affects: nav labels, Overview stats, Domain page layout (sidebar above content), failing-sources table vs cards, Explore/Anomalies table vs cards, EmailCheck history rows, ReportDetail stat rows.
- [x] Date helpers (`utils/dates.ts`): `formatDate` -> "Mar 18, 2026" (en-US; ISO strings parsed as local date); `formatDateWithRelative` -> "Mar 18, 2026 . 2d ago"; `formatTimestamp` -> "Mar 18, 2026, 13:57" 24h; `relativeTime` -> "just now", "Nm ago", "Nh ago", "Nd ago" (<7d), "Nw ago" (<30d), "Nmo ago", "Ny ago", and " from now" suffix for future.
- [x] Clipboard copy pattern: `navigator.clipboard.writeText`, button flips to "Copied!" for 1500ms (EmailCheck/Team: 2000ms). Onboarding CodeBlock shows a check mark instead of "Copied!".
- [x] Shared DMARC record builder (`buildRecommendedRecord`/`buildRecord`, duplicated in Domain.tsx, DmarcWizard.tsx, Onboarding.tsx): if no current record -> `v=DMARC1; p=<policy>; rua=mailto:<rua>`; else replace `p=[a-z]+` (or append `; p=<policy>`), then if rua address not already present: append `,mailto:<rua>` to existing `rua=` value or append `; rua=mailto:<rua>`. Preserves other tags (pct, sp, fo...).
- [x] localStorage keys: `ia_api_key` (auth token), `ia_onboarding_done` (written `'1'` on leaving onboarding wizard; never read anywhere in the dashboard). sessionStorage key: `ia_update_dismissed` (update banner dismissal).
- [x] Orphan/unused code to decide on: `components/AddDomainModal.tsx` is not imported anywhere (dead); `api.refreshMtaStsMx` (PATCH `{refresh_mx:true}`) is not called by any UI; routes `#/bulk-import` and `#/ct-discover` have NO inbound links anywhere in the UI (reachable only by typing the hash); `ia_onboarding_done` is write-only.
- [x] Style: inline styles, no CSS framework, system-ui font, max shell width 1040px, colours gray/green(#16a34a)/amber(#d97706)/red(#dc2626)/blue(#2563eb). `index.html` expected to define `@keyframes pulse` (used by EmailCheck waiting dot).

---

## 1. Pre-auth / unauthenticated screens

### 1.1 Route `#/invite/:token` (AcceptInvite) - rendered BEFORE auth gate
- [x] On mount load invite. API: `GET /api/invites/:token` (no key) -> `{email, invited_by, role}`. Note: any non-2xx or network failure => "Invite not found" screen with text "This invite link is invalid or has expired." and a "Go to dashboard" link to `#/`.
- [x] Loading state: card with "Loading...".
- [x] Form: shows "You're invited" + "**invited_by** invited you to join their InboxAngel workspace as a **role**", email badge (read-only), fields Your name (required, autofocus), Choose a password (required), Confirm password (required).
- [x] Submit "Create account ->". Client validation: passwords must match ("Passwords do not match"), >= 8 chars ("Password must be at least 8 characters"). API: `POST /api/invites/:token` `{name (trimmed), password}` -> `{token}`. On success store token in `ia_api_key`, call `onAccepted` -> App `setHasKey(true)` (route stays `#/invite/...`; note that App returns AcceptInvite for that route before checking hasKey, so the user stays on the invite page unless hash changes - **potential parity trap**: nothing navigates away after accept). Error: server `error` or "Error <status>"; network => "Network error - please try again". Button shows "..." while loading.

### 1.2 Route `#/reset/:token` (ResetPassword) - rendered BEFORE auth gate
- [x] If token missing or length < 10 => "Link expired" screen (links back to `#/` "Back to sign in").
- [x] Form: New password (autofocus), Confirm password. Same client validation as invite (match, >= 8).
- [x] Submit "Set password ->". API: `POST /api/auth/reset` `{token, password}` -> `{token}`. Success: store `ia_api_key`, `onReset` => App sets `hasKey=true` and `location.hash='/'`. Failure: shows server `error` or "Reset failed"; **HTTP 400 additionally flips to the "Link expired" screen**. Network error => "Network error - please try again".

### 1.3 Startup loader (AuthGate, while `/api/auth/status` pending)
- [x] `StartupLoader`: logo "InboxAngel", 1s ticker with animated dots (0-3). Message by elapsed seconds: 0 "Starting up", 6 "Running database setup", 20 "Setting up your instance", 40 "Almost there". From 6s also shows "First startup runs database migrations - only happens once."
- [x] If `/api/auth/status` fetch fails/throws, falls back to a status of `{configured:false, prefill:{}, telemetry_default:false, turnstile_site_key:null, has_domain:false}` (=> user sees the CREATE ACCOUNT form, not an error).
- [x] App-level probe: if no `ia_api_key` in localStorage, App renders nothing (`null`) while probing `GET /api/auth/get-session` (cookie session from OAuth). If response ok and JSON non-null => `hasKey=true` (cookie-auth session; **subsequent `apiFetch` still sends empty `X-Api-Key: ''`**, so backend must accept cookie sessions). Any failure => AuthGate.

### 1.4 AuthGate main form
- API: `GET /api/auth/status` -> `AuthStatus {configured, prefill:{name,email}, telemetry_default, turnstile_site_key|null, has_domain, mode?:'self-host'|'saas', signup_open?, oauth_providers?: string[]}`. Prefills name, email, telemetry checkbox from status.
- [x] Mode "Sign in" (`configured && !creating`): title "Welcome back"; Email (autofocus), Password; button "Sign in ->". API: `POST /api/auth/login` `{email,password[,cf_turnstile_token]}` -> `{token, has_domain?}`.
- [x] Mode "Create account" (first-time instance setup when `!configured`, OR saas signup when `creating`): title "Create your account", subtitle "Set up your InboxAngel instance. You'll use these credentials to log in."; fields Your name (optional, autocomplete name), Email (hint "Used to log in and receive monitoring alerts."), Password (placeholder "Choose a password (8+ chars)"), Confirm password, checkbox "Share anonymous usage stats" (telemetry; default from `telemetry_default`; text: no personal data, change later). Validation: match + >= 8 chars. Button "Create account ->".
  - API: `!configured` => `POST /api/auth/setup` `{name,email,password,telemetry[,cf_turnstile_token]}`; `configured && creating` => `POST /api/auth/signup` same body.
  - After first-time setup (`!status.configured`): sets `location.hash = has_domain ? '#/' : '#/setup'` then `onSave`. After signup/login: just `onSave` (App then runs its own has_domain redirect).
- [x] Toggle: if `configured && signup_open`, link "New here? Create an account" / "<- Back to sign in" toggles `creating` and clears error.
- [x] "Forgot your password?" (only in sign-in mode) -> view `forgot`.
- [x] Forgot view: "Reset password", email input (required, autofocus), "Send reset link ->". API: `POST /api/auth/forgot` `{email}`. **Always** moves to `forgot-sent` regardless of response status (non-enumerating); only a thrown network error shows "Network error - please try again". `forgot-sent`: "Check your inbox", "If an account exists for <email>, we've sent a reset link. It expires in 1 hour." with "<- Back to sign in". Forgot view has "<- Back to sign in" too.
- [x] OAuth: for each `oauth_providers` entry render link-style button "Continue with GitHub|Google|<raw name>". API: `POST /api/auth/sign-in/social` `{provider, callbackURL:'/'}` -> `{url}` (Better Auth) then `window.location.href = url`. Error shows `data.error ?? data.message ?? 'Could not start sign-in'`. Session returns as cookie (see 1.3 probe).
- [x] Turnstile: if `turnstile_site_key`, lazily injects `https://challenges.cloudflare.com/turnstile/v0/api.js` (once; `script[data-cf-turnstile]`) and renders `div.cf-turnstile[data-sitekey][data-theme=light]`. On submit reads `input[name="cf-turnstile-response"]` from DOM and sends as `cf_turnstile_token` only if truthy. Not used for forgot/OAuth.
- [x] Errors from non-OK responses: `data.error ?? "Error <status>"`. Network => "Network error - please try again". Submit disabled with "..." while loading.
- [x] Token from login/setup/signup stored in `localStorage.ia_api_key`. Note: login does not call `onUnauthorized`; there is no password-visibility toggle, no "remember me".

---

## 2. App shell (`App.tsx`)

- [x] Route precedence order: invite -> reset -> (auth gate) -> full-screen wizards (`/domains/:id/spf-flatten`, `/domains/:id/mta-sts`, `/domains/:id/dmarc-wizard`) -> onboarding (`/domains/:id/setup[/:step]`, `/setup`, anything starting `/onboarding`) -> shell routes.
- [x] Shell header: logo link "InboxAngel" -> `#/`; nav links Domains (`#/`), Email check (`#/check`; label "Check" on mobile), Team (`#/team`), Audit log (`#/audit`; label "Log" on mobile), and Sign out button (label "<-" arrow glyph on mobile). Active-link rule: Domains active for `/`, `/add`, `/domains/*`; others exact match. `/bulk-import` and `/ct-discover` highlight nothing.
- [x] Sign out: `logout()` -> `POST /api/auth/logout` (header key, errors swallowed) then remove `ia_api_key`; then `hasKey=false` -> AuthGate. Does not clear cookie session client-side beyond what server does.
- [x] Update banner (`GET /api/version` via raw fetch, errors ignored): shown only if not dismissed in this browser session (`sessionStorage.ia_update_dismissed`) and `update_available`. Text "New version available: v<latest> - you're on v<current>", link "View release" (`release_url`, new tab), dismiss "X" button sets sessionStorage flag. `VersionInfo {current, latest|null, update_available, release_url}`. Fetched on mount even before login (so can't depend on auth).
- [x] Custom domain banner: once `hasKey`, `GET /api/auth/status` (raw fetch, no key header); if `custom_domain` set and differs from `window.location.hostname` => blue banner "Your dashboard is available at **<host>**" + "Switch ->" link to `https://<host>` (same-tab navigation, root, no hash carry-over).
- [x] Redirect to setup: same status call; `has_domain === false` and current hash does not include `/setup` => `location.hash = '#/setup'` (starts onboarding). Runs when `hasKey` flips true, so also after login.
- [x] Shell routes: `/` Overview; `/add` AddDomain; `/bulk-import`; `/ct-discover`; `/check` EmailCheck (no onUnauthorized prop); `/team`; `/audit`; `/domains/:id` DomainDetail; `/domains/:id/settings`; `/domains/:id/explore`; `/domains/:id/anomalies`; `/domains/:id/reports`; `/domains/:id/reports/YYYY-MM-DD`.
- [x] Not found: any unmatched route shows "Page not found. Back to overview" (link `#/`). Note `/domains/:id/spf-flatten|mta-sts|dmarc-wizard` are excluded from this because they return earlier.
- [x] Known bug-ish behaviour to be aware of: hooks (`useEffect`, `useIsMobile`) are declared AFTER the early `return` for invite/reset routes (conditional hook order). In Preact it "works" because navigating invite<->app changes hook count; the port should not replicate.
- [x] Loading state before auth known: renders nothing (blank) while `probing`.
- [x] Wizard/onboarding screens are full-screen: no header/nav shell, no update/custom-domain banners.

---

## 3. Overview - `#/`

APIs: `GET /api/domains`; per domain `GET /api/domains/:id/stats?days=7` and `GET /api/domains/:id/wizard-state` (both via `Promise.allSettled`, individual failures tolerated); for PDF: `GET /api/domains/:id/check-summary` (all, must all succeed) and `GET /api/domains/:id/stats?days=90` (failures ignored).

- [x] Summary strip: "<N> domain(s)", green "<N> protected" (status `good`), red "<N> needs action" (status `danger`, hidden if 0).
- [x] Status calc (`computeStatus`): policy none/null => danger; pass rate < 70% => danger; policy quarantine OR pass rate < 90% => warning; else good. Pass rate = 7-day passed/total (null if total 0).
- [x] Link "+ Add domain" -> `#/add`.
- [x] Button "Export PDF" (only when >= 1 domain): fetches summaries + 90-day trends, builds & downloads `email-auth-report.pdf` (see section 20). Label "Generating..." while busy (guarded against double click). 401 => logout; other error => `alert("Failed to export PDF: <msg>")`.
- [x] Loading state: "Loading..."; error state: `401` => "Unauthorized - set your API key." (note: error '401' on this page actually triggers `onUnauthorized` and returns, so message mostly unreachable) else "Error: <msg>".
- [x] Empty state (no domains): "No domains yet. Add your first one to get started." + "Get started ->" button -> `#/setup` (onboarding).
- [x] Domain tree: parents then their children (children indented with an elbow glyph) - built from `parent_id`; child whose parent is not in list is shown at top level. No deeper nesting than 2 levels.
- [x] Domain row (entire row clickable -> `#/domains/:id`, hover highlight): Lighthouse-style SVG score ring (0-100 = 7d pass %, colours >=95 green #0cce6b, >=70 amber #ffa400, else red #ff4e42, grey dash if no data); domain name (ellipsis); policy badge text (`none`, `quar.`, `reject`, `-` if null); on desktop only: "<n> msg" if total>0 and red "<n> failed" if failed>0; arrow.
- [x] Per-row "Continue setup" link: if wizard state has fewer than 5 `complete` steps shows amber "<done>/5 steps - Continue setup ->" linking `#/domains/:id/setup/2` (stopPropagation so it doesn't open the domain). If wizard-state call failed, completed=0 so link shows "0/5".

---

## 4. Add domain - `#/add`

APIs: `GET /api/zones` (on mount; failure => treated as no zones), `POST /api/domains` `{domain}`, `GET /api/domains/:id/dns-check` (polled).

- [x] Step "input": back link "<- Back" (`#/`), title "Add a domain", explainer text, three reassurance blurbs (No impact on your email / Guided setup / Clear next steps).
- [x] Domain field: if Cloudflare zones returned (non-empty) -> `<select>` "- Select a domain from your Cloudflare account -" listing zone names, with "Not listed? Enter manually" button that switches to free text (sets zones to []). Otherwise text input "yourcompany.com" (autofocus).
- [x] Submit "Continue ->" ("Setting up..." while loading). Client normalisation: trim, lowercase, strip leading `http(s)://`, strip one trailing `/`; empty => no-op. `POST /api/domains` -> `AddDomainResult {domain, rua_hint, manual_dns?, dns_instructions?, parent_context?}`. Errors: 401 => logout; 409 shows "Already exists" unless server gives message; any other shows message inline.
- [x] Step "setup" (after success): green "Domain added" badge; if `parent_context` present (adding a subdomain) show Subdomain inheritance banner:
  - header "Subdomain of <parent> - inheritance summary";
  - DMARC row: no parent DMARC => warning "No DMARC record found on <parent>. Consider setting up <parent> first, then return here."; effective sp (explicit `dmarc_sp` else `dmarc_policy`) == reject => green "<parent> enforces sp=reject | p=reject (sp= not set, inherits p=) - this subdomain is already protected ... We still recommend adding an explicit _dmarc.<sub> record"; else amber "<parent> does not enforce a subdomain reject policy (sp=<x> | no sp= tag (inherits p=<policy>)). This subdomain can be spoofed. Add the DMARC record below...";
  - SPF row "SPF does not inherit. <sub> needs its own SPF record."; DKIM row "DKIM does not inherit...".
- [x] "Add this DNS record" card with copy fields (each with Copy): Type `TXT`; Name/Host `_dmarc.<domain>`; Value/Content `v=DMARC1; p=none; rua=mailto:<domain.rua_address>`; TTL hint 3600. Explainer about p=none. If `manual_dns && dns_instructions` show yellow "Also add: <instructions>".
- [x] DNS live-check status box: runs immediately then every 15s (`setInterval`, cleared on unmount and when found). States: checking "Checking for your DNS record..."; not-found "DNS record not detected yet - checks every 15s..."; missing-rua (record found but no rua) warning + expected `rua=mailto:<rua>`; found (found && has_rua) "DNS record detected! Reports will start arriving within 24 hours." (stops polling); error "Could not check DNS - add the record above and you're done." (polling continues). Note the response shape `{found, has_rua, current_record, cf_managed}`: "DNS lookup failure" is only distinguishable as a thrown error => `error` state, whereas record missing => `not-found`.
- [x] CTA link "Go to <domain> ->" -> `#/domains/:id`.

---

## 5. Bulk import - `#/bulk-import` (orphan route, no inbound link)

API: `POST /api/domains/bulk-import` `{domains: "<raw textarea string>"}` -> `{imported, total, results:[{domain, status:'imported'|'duplicate'|'invalid'|'error', error?, dns_record_id?, manual_dns?}]}`.

- [x] Back link, title, textarea (monospace, 8 rows, placeholder 3 sample domains; one per line or comma-separated - server parses). Button "Import domains ->" disabled when empty/loading ("Importing...").
- [x] Result summary badge "X of Y domain(s) imported" (green if X>0 else gray).
- [x] Results table Domain / Status badge (green imported, gray duplicate, red invalid/error) / Note ("DNS provisioned" or "DNS provisioning: manual required" for imported depending on `manual_dns`; "Already registered" for duplicate; plus `error` text).
- [x] After >=1 imported: "<- View all domains" link to `#/`.
- [x] 401 => logout; other error => inline.

## 6. CT discover - `#/ct-discover` (orphan route)

APIs: `GET /api/domains/ct-discover?domain=<encoded>` -> `{domain, subdomains: string[]}`; then `POST /api/domains/bulk-import` with selected joined by `\n`.

- [x] Root domain input + "Discover" button ("Searching..."). Input trimmed + lowercased. Description cites Certificate Transparency logs (crt.sh).
- [x] Results: empty => "No subdomains found in CT logs for <domain>."; non-empty => header checkbox "<N> subdomain(s) found" (select-all toggle) + "<n> selected", scrollable list (max 300px) of checkbox rows, **all pre-selected**.
- [x] Button "Import <n> selected ->" (disabled if none selected or importing; "Importing..."). Import errors are shown in the same discover-error slot ("Import failed" default).
- [x] Import result: summary badge "X of Y domains imported", table Domain/Status (no notes column), "<- View all domains" link if >=1 imported.
- [x] 401 handled on both discover and import.

---

## 7. Email check - `#/check`

Raw-fetch APIs (no key): `POST /api/check-sessions` -> `{token, email}`; `GET /api/check-sessions/:token` -> `{status:'pending'|'done', result?: CheckResult}`. Keyed API: `GET /api/check-results` -> `{results: CheckResult[]}` (history, errors silently ignored). **No 401 handling on this page.**

- [x] Header "Email check" + "<- Overview" link.
- [x] Phase idle: explainer + "Start check" button.
- [x] Phase waiting: shows generated address (`session.email`, wraps) with Copy button (2s "Copied!"), pulsing dot "Waiting for email... (checking every 3s)" (poll interval 3000ms, errors during poll ignored/keep polling, no timeout), hint about curl/swaks, "Cancel" button (stops polling, back to idle).
- [x] Phase done: `CheckReport` - domain heading, "sent from <from_email> . <timestamp en-GB>", overall badge (protected "Protected" green / at_risk "At risk" amber / else "Exposed" red); inline PASS/FAIL chips for SPF, DKIM, DMARC (`pass` green check, `fail` red cross, missing/`none` dash grey); three `ProtocolCard`s:
  - SPF card: result, `spf_domain`, `spf_record` code block, lookup badge `N/10 lookups` (green <8, amber 8-9 with warning, red >=10 with warning) and advice text per case: none/missing, `permerror` (lookup limit exceeded), pass but >=10 lookups, pass but >=8, pass (with count), softfail, fail, other.
  - DKIM card: `dkim_domain`, advice for none/pass/fail.
  - DMARC card: `dmarc_record`, advice branches: no record; record but no result; pass+reject; pass+quarantine; pass+none; fail; fallback.
  - Card colours: grey "not configured" for missing/none, green pass, red otherwise.
  - Button "Run another check" resets (stops polling, back to idle).
- [x] Phase error (create session failed): "Error: <status code>" + "Try again" button. (Message is the raw HTTP status number, e.g. "Error: 429".)
- [x] History ("Recent checks", hidden if empty): desktop column headers Domain/Status/SPF/DKIM/DMARC/Checked; rows clickable to expand showing the same three ProtocolCards; mobile card style. When a new check finishes the list refetches and the newest result auto-expands (`refreshKey`). Only one row expanded at a time.
- [x] **Monitor-subscribe is NOT in this dashboard page**: there is no "email me alerts" form/button here. The only monitor-sub UI is the pause/resume list in Domain settings (section 10). Backend `monitor-subs` rows are created elsewhere (public check flow). Confirm intended scope when porting.

---

## 8. Domain detail - `#/domains/:id`

APIs on load (parallel): `GET /api/domains`, `GET /api/domains/:id/sources?days=7`, `GET /api/domains/:id/spf-flatten` (failure => null), `GET /api/domains/:id/mta-sts` (failure => null), `GET /api/domains/:id/wizard-state` (failure => null). Then `GET /api/domains/:id/stats?days=<7|30|60>` (refetched when window changes; errors swallowed), then (after stats) `GET /api/domains/:id/rollout-next` (errors swallowed) and `GET /api/domains/:id/dns-check` (errors swallowed). The domain object is found by filtering `GET /api/domains` (no single-domain endpoint).

States:
- [x] Loading: "Loading..."; error: "Error: <msg>" (401 => logout); domain missing or stats not yet loaded: "Domain not found." (note: shows this transiently if stats fetch fails/slow after load completes).

Header:
- [x] "<- All domains" link; `<h2>` domain name; policy label coloured (reject green, quarantine amber, none red); "Settings" link -> `#/domains/:id/settings`.

Setup-incomplete banner:
- [x] If any wizard step != complete: amber link "Setup incomplete - N/5 steps done . Continue setup ->" to `#/domains/:id/setup/<first non-complete step index (excluding domain step) +1, default 2>`.

Summary:
- [x] Four stats for selected window: Pass rate % (or dash), Total, Passed, Failed (sums of daily stats).

Guidance card (`getGuidance`, pure client logic on policy + pass rate + hasData + live record):
- [x] No data: grey "Waiting for first reports" text + DNS hint.
- [x] policy none: amber "Monitoring only - not enforcing" with button "Upgrade to quarantine ->" -> `#/domains/:id/dmarc-wizard`.
- [x] quarantine: pass rate >= 90 => blue "Ready to enforce" with "Upgrade to reject ->" button; else amber "Not ready for reject yet".
- [x] reject: pass rate < 70 => red "Legitimate mail may be blocked"; else green "Fully protected".
- [x] When total==0 and dns-check done: italic "DNS record detected - reports will start arriving soon." or "DNS record not found yet..." warning (based on `found && has_rua`).
- [x] Note: the computed recommended record (`buildRecommendedRecord`) is built but only used for the (now link-only) action; DNS value is not displayed here.

Rollout progress (RFC 9989 staged rollout; shown only if `rollout.current_policy` is quarantine or reject):
- [x] Shows "Rollout progress", policy label + " (testing, t=y)" if `current_testing`, "Behind schedule" pill, progress bar `(current_step_index+1)/total_steps`, "Step X of Y" and "Next: <policy>[ (testing, t=y)]" or "Complete".
- [x] "Advance policy ->" button (only when `next_step`); disabled with tooltip `block_reason` when `blocked`; when no next step shows "Fully graduated" pill.
- [x] Blocked reason banner "warning <block_reason>"; `has_unknown_senders && !blocked` shows a note about unknown senders in the last 7 days.
- [x] Advance modal (click outside to cancel): title "Advance to <policy>[ (testing, t=y)]", optional `next_step_note` warning (e.g. dropping partial pct), instruction "Update your _dmarc.<domain> TXT record to:" + `dns_preview` with Copy, buttons Cancel / "Mark as applied". API: `POST /api/domains/:id/rollout-advance` `{policy, testing}` then refetch `GET .../rollout-next`; closes modal; error shown inline under progress block. NOTE: this does NOT write DNS - user applies manually and clicks "Mark as applied".

Daily chart:
- [x] "Last N days" with window pills 7d / 30d / 60d (default 7) and "All reports ->" link (`#/domains/:id/reports`). Empty: "No data yet."
- [x] Each day row is a link to `#/domains/:id/reports/<YYYY-MM-DD>`; label `MM-DD` (or `MM/DD` for >7d, smaller font); stacked green passed / red failed bar scaled to max daily total; count shown on desktop only. API `days` param supports any value.

RUA box:
- [x] "RUA reporting address": `rua=mailto:<rua_address>` with Copy and help text about adding it to `_dmarc.<domain>`.

Subdomain/parent context:
- [x] If domain has parent in list: banner either "Has own DMARC record (p=<policy>) - overrides parent <link>" (when `dnsOk`) or "Inherits DMARC from <parent link> (p=<policy>). SPF and DKIM are independent - not inherited."
- [x] If domain has children: "Subdomains" section with "+ Add subdomain ->" (-> `#/add`), `sp=` analysis from the live DNS record (`sp=reject` green; other `sp=` amber "NOT enforced"; no sp tag with record present amber "inherit p=<policy>"), rows linking to each child with policy label.

Failing sources (`sources?days=7`, hidden if none):
- [x] "Top failing sources" header with links "Anomalies ->" (`#/domains/:id/anomalies`) and "Explore sources ->" (`#/domains/:id/explore`). Desktop table (Source with provider `org ?? base_domain` + IP subtext or just IP; Sending as = `header_from`; Failed messages) / mobile cards.

Sidebar "DNS Tools" (right column on desktop, above content on mobile; only rendered if either tool `available` or has `config`):
- [x] SPF Flattening card: pill "Active" (config.enabled) / "N/10 lookups" (green <8, amber 8-9, red >=10, using `spfFlat.lookup_count ?? config.lookup_count`) / "Available". Active => "<ip_count> IPs - re-resolved daily." + "Configure ->" (`#/domains/:id/spf-flatten`) + "Disable" button; inactive => description + "Configure ->". Left border colour by state.
  - "Disable" API: `DELETE /api/domains/:id/spf-flatten` (no confirmation dialog!); on success local state config=null; error shown under card. Server restores original SPF record.
- [x] MTA-STS card: pill = mode (`testing` blue / `enforce` green) or "Available". Active => "Enforcing TLS for inbound mail (<mode> mode)." + "Configure ->" (`#/domains/:id/mta-sts`) + "Disable" (`DELETE /api/domains/:id/mta-sts`, no confirmation).
- [x] State flags `cfManaged` and `dnsOk`/`currentRecord` are fetched from dns-check but `cfManaged` is not used on this page.

---

## 9. Domain settings - `#/domains/:id/settings`

APIs: `GET /api/domains`, `GET /api/domains/:id/monitor-subs` -> `{subs: MonitorSub[]}` (load together; either failing => error), `PATCH /api/domains/:id/alerts` `{alerts_enabled}`, `PATCH /api/monitor-subs/:subId` `{active}`, `PUT /api/domains/:id/set-default`, `DELETE /api/domains/:id`, `GET /api/domains/:id/export?key=<apikey>`.

- [x] Loading / "Error: <msg>" / "Domain not found." states. Back link "<- <domain>".
- [x] Domain info card: Domain, Added (`formatDate(created_at)` or dash), RUA address copy field (`rua=mailto:<rua>`), DMARC record copy field (`v=DMARC1; p=<policy|none>; rua=mailto:<rua>`).
- [x] Export data: "Download CSV" anchor `GET /api/domains/:id/export?key=<urlencoded ia_api_key>` with `download="<domain>-dmarc.csv"`. **Auth via query-string key (not header)** - server must accept `?key=`; with cookie sessions the key is '' so the link would send empty key. One row per source per day.
- [x] Monitoring alerts: "Alerts enabled" row with "Pause all"/"Resume all" button (toggles `alerts_enabled` 1/0; errors silently ignored; button dimmed while in flight). Subscriber list (`MonitorSub {id,email,domain,active,created_at}`): per row "Receiving alerts"/"Alerts paused" and Pause/Resume button (errors silently ignored). Empty: "No active monitoring subscriptions for this domain yet. They're created automatically when someone runs a free email check and opts in to alerts."
- [x] Infrastructure: "Set as default domain" (button, hidden when already default) or star "This is the default domain" with text "reports.<domain> receives reports for all your domains". Click => `PUT /api/domains/:id/set-default` -> `{ok, domain, warning}`; shows `warning` in amber box (also shows error message in the same box on failure); 401 => logout.
- [x] Danger zone: "Remove domain" -> inline two-step confirm (Cancel / "Yes, remove"), no browser confirm(). `DELETE /api/domains/:id`; success => `location.hash = '/'`; failure shows red message; copy says it deletes all report data, cannot be undone.

---

## 10. Explore sources - `#/domains/:id/explore`

API: `GET /api/domains/:id/explore?days=<7|30|90>` -> `{days, domain, sources: AnomalySource[]}`. Default 30d.

- [x] Back link shows domain name ("..." until loaded) -> `#/domains/:id`.
- [x] Filter pills All / Anomalies (red when active, with count badge of sources where `!spf_pass || !dkim_pass`) - client-side filter. Window pills 7d/30d/90d (refetch).
- [x] States: Loading; "Error: ..."; empty (All: "No sources in the last N days" / "No DMARC reports received yet."; Anomalies: "No anomalies in the last N days" / "All sending sources are passing DMARC.").
- [x] Desktop table: Source (link to `#/domains/:id/reports/<last_seen>`, label `org ?? base_domain` else IP; IP sub-line, `header_from`, "via <spf_domain||dkim_domain>" when different from header_from) / Status (green "Passing" or red "SPF|DKIM|SPF + DKIM fail") / Messages / First seen / Last seen (`MM-DD`). Mobile card equivalent. Rows for failing sources not seen in the last 2 days (stale) are rendered at 50% opacity.
- [x] 401 => logout.

## 11. Anomalies - `#/domains/:id/anomalies`

API: `GET /api/domains/:id/anomalies?days=<7|30|90>` -> `{days, domain, anomalies: AnomalySource[]}`. Default 30d.

- [x] Window pills 7d/30d/90d. Empty: green check "No anomalies in the last N days / All sending sources are passing DMARC."
- [x] Two sections: red "Active - N source(s)" (last_seen within 2 days) and "Older - N source(s) . not seen in 2+ days, may be resolved" (55% opacity). Table (Source IP linking to report of `last_seen`, org/base_domain, header_from, "via ..." / Failing badge (SPF, DKIM, SPF + DKIM) / Messages / First seen / Last seen) or mobile cards.
- [x] Back link "<- <domain name>" (fallback "Back").

## 12. Report browser - `#/domains/:id/reports`

API: `GET /api/reports?limit=200` -> `{reports: AggregateReport[]}` - **note: fetches reports for ALL domains (tenant-wide), no domain filter in the request; domainId is only used for links/back and effect dependency**.

- [x] Header "Reports" + "<n> report(s)" count (of visible).
- [x] Domain filter pills (All + each distinct domain, sorted) shown only when > 1 distinct domain; auto-selects the only domain if exactly one. Initially "All" (null) when multiple - i.e. the page does NOT pre-filter to the current domainId.
- [x] Empty: "No reports yet. DMARC reports arrive daily from mail providers."
- [x] Table: Date (link to `#/domains/:id/reports/<ISO date of date_begin (UTC)>` with `formatDate` + relative time), Domain (only when multiple), Reporter (`org_name`), Pass (green), Fail (red if >0), Total (pass-rate % coloured >=95 green / >=70 amber / else red, plus total count). Link uses the `domainId` from the route, not the row's domain.

## 13. Report detail (single day) - `#/domains/:id/reports/YYYY-MM-DD`

API: `GET /api/domains/:id/reports?date=YYYY-MM-DD` -> `DayReport {date, domain, summary{total,passed,failed}, sources: ReportSource[]}`.

- [x] Back link "<- <domain>". Title `formatDateWithRelative(date)`. Hero line: total==0 "No reports received for this date."; all pass "N messages analyzed - everything passed." (green); else "N messages analyzed - M need attention." (red).
- [x] Summary stats (only if total>0): Pass rate %, Total, Passed, Failed (only if >0).
- [x] "Needs attention" cards for each source with `!spf_pass || !dkim_pass`: provider name (`org ?? base_domain`) or IP, IP sub-line, "via <auth domain>" (when spf_domain||dkim_domain != header_from), "sending as <header_from>", message count, auto-generated explanation text (`explain()`): both fail => unauthorized/likely spoofed; SPF fail => "Add include:<spf_domain> to your SPF record" (or "Add this server..."); DKIM-only fail => configure DKIM; SPF/DKIM tick/cross badges; "Reported by <reporters>".
- [x] "Passing sources" list rows (click to expand/collapse; multiple can be open): check, provider/IP, via, message count; expanded grid: SPF pass, DKIM pass, SPF domain, DKIM domain, Sending as, Messages, Reported by.
- [x] Loading/Error states; 401 => logout. No prev/next-day navigation.

---

## 14. Team / invites - `#/team`

APIs: `GET /api/team` -> `{users: TeamMember[], current_user_id}`; `POST /api/team/invite` `{email}` -> `{token}`; `DELETE /api/team/:id`.

- [x] Header "Team": "Members can access all domains and reports. Admins can manage the team."
- [x] Members list: avatar initial (first letter of name uppercased, `?` fallback), name, email, role badge (owner/admin purple, member gray), last login (`formatDate`) or "Never logged in", and an "X" remove button (not shown for current user). **No confirmation prompt** on remove; failure is silent (only unauth clears). Removed row removed locally.
- [x] Invite form: email (required) + "Generate invite link" ("Generating..."). Success: builds link `${window.location.origin}/#/invite/<token>` (note: relies on the SPA being at origin root), shows copy box with text "Send this link to your teammate. It expires in 7 days and can only be used once.", input cleared. No email is sent by the server (link is manual). Errors inline.
- [x] Unauthorised handling: treats `'401'` or `'403'` as logout - but because `throwApiError` never throws the literal "403", the 403 branch is dead; a 403 from non-admins shows "You don't have permission to do that" (or server error text) inline instead (load error shown under Members).
- [x] Role behaviour: roles `owner|admin|member` displayed only; the UI never hides invite/remove for members (relies on server 403). No role picker on invite (server returns role in invite info; invite page displays it).

## 15. Audit log - `#/audit`

API: `GET /api/audit-log?page=<n>&limit=50[&action=<prefix>]` -> `{entries: AuditLogEntry[], page, limit}`. (Client supports `domain_id`, `actor_id`, `since`, `until` params in `getAuditLog` but UI does not expose them.)

- [x] Header "Audit Log" + "Immutable record of all changes. Admin only."
- [x] Filter chips (server prefix filter): All (''), Auth `auth.`, DNS `dns.`, Domains `domain.`, SPF `spf_flatten.`, MTA-STS `mta_sts.`, Team `team.`, Cron `cron.`. Changing filter resets to page 1.
- [x] Entry row: action pill coloured by prefix (auth indigo, domain cyan, dns amber, spf_flatten violet, mta_sts blue, team pink, cron/other gray, bg = colour + `18` alpha), `resource_name`, actor (`system` italic when `actor_type==='system'`, else `actor_email ?? actor_id ?? dash`), timestamp `formatTimestamp . relativeTime`, expandable `<details>` "before" and "after" showing pretty-printed JSON (parsed if valid JSON else raw string) - only rendered if either present. `meta`, `resource_type`, `resource_id` are fetched but not shown.
- [x] Pagination: Prev / "Page N" / Next; Next enabled only if the page returned exactly 50 entries (`hasMore = length === LIMIT`); scrolls to top on page change.
- [x] States: Loading, "No audit entries found.", error text. Unauthorised: logs out on `'401'` or the literal server message `'admin required'`. (Non-admin 403 with other message shows inline error.)

---

## 16. Onboarding wizard - `#/setup`, `#/onboarding*`, `#/domains/:id/setup[/:step]` (full-screen, 480px card)

APIs: `GET /api/domains`, `GET /api/domains/:id/onboarding-status`, `GET/PUT /api/domains/:id/wizard-state`, `GET /api/zones`, `POST /api/settings/base-domain`, `POST /api/domains/:id/apply-dmarc`, `POST /api/domains/:id/apply-spf`, `POST /api/spf-lookup-count`, `POST /api/setup/email-routing`, `POST /api/settings/register-destination`. **No `onUnauthorized` prop: 401s display as the raw message "401" in error spots or silently fail.**

Wizard shell/logic:
- [x] URL steps 1-indexed (`/setup/N`), internal 0-indexed: 1 Domain, 2 SPF, 3 DKIM, 4 DMARC, 5 Routing. `setStep` rewrites the hash to `#/domains/:id/setup/<n+1>` whenever a `domainId` exists.
- [x] Entry with no domain id: `GET /api/domains`; if none => domain step (needsDomain); if some => redirect `location.hash = #/domains/<domains[0].id>/setup/1` (first domain).
- [x] With domain id: loads onboarding status + wizard state (fallback all `not_started` on error). Forces `domain: 'complete'` (and `PUT wizard-state {domain:'complete'}` fire-and-forget) if not already. Step 1 (index 0) with a domain is clamped to step 2 (SPF). If URL had no step (or step 1) jumps to first step (excluding domain) whose state is `not_started` (default 2); skipped/complete steps are not revisited automatically; rewrites hash.
- [x] Header: logo + "Skip setup ->" (calls `done`: sets `localStorage.ia_onboarding_done='1'`, navigates to `#/domains/:id` or `#/` if no domain). Subtitle "Let's verify your email security for **<domain>**" and "N of 5 steps complete". Progress dots: green complete, amber skipped, wide black current, gray other; "current+1 / 5".
- [x] Error / no status: red message ("Failed to load" or "Could not load domain status.") with "Go to dashboard ->".
- [x] Persist: "Continue"/"Next" => `markAndAdvance('complete')`, "Skip for now" => `'skipped'`; both `PUT /api/domains/:id/wizard-state {<stepKey>: state}` (errors swallowed), then next step; last step => `done()`. Body `WizardState {domain,spf,dkim,dmarc,routing}` each `'not_started'|'complete'|'skipped'`.

Step 1 - Domain (only when no domains exist):
- [x] Title "What's your main domain?" explaining a `reports` subdomain is created and all future domains send reports there. Cloudflare zone dropdown (+ "Not listed? Enter manually") or text input (Enter key submits). Validation regex `^[a-z0-9.-]+\.[a-z]{2,}$` (after lowercase/trim) else "Enter a valid domain like yourdomain.com". Continue disabled if empty. API: `POST /api/settings/base-domain` `{domain}` -> `{ok, domain, domain_id, reports_domain, zone_id, workspace_id}`. Then marks domain complete, loads status, goes to step 2 (`#/domains/<id>/setup/2`). Header here shows "Step 1 of 5" and "Skip setup ->".

Step 2 - SPF:
- [x] Badge by `spfSeverity`: no record => warning; lookup count > 9 error, >= 8 warning, else good. After apply, badge becomes info.
- [x] If `spf.flattening_active`: read-only view with current record + copy, message that editing is disabled until flattening is disabled on domain page; Continue only (no skip).
- [x] Editor: provider typeahead (`SPF_PROVIDERS`: 16 providers by name or include, case-insensitive; Enter picks first match; Esc closes; dropdown on focus/typing; hides already-selected; custom domain "Add custom" button appears when typed text isn't a known include). Pre-selected = all `include:` mechanisms found in current record (known + unknown). Selected shown as removable chips (`x`), "current" tag on chips that match detected known providers.
- [x] Qualifier radio `~all` (softfail) / `-all` (hardfail); initial from existing record (`-all` if present).
- [x] Preview record = `buildSpfRecord(includes, qualifier, otherMechanisms)` preserving non-include mechanisms (mx, a, ip4:, ip6:, redirect=...). Lookup count: debounced 400ms `POST /api/spf-lookup-count {record}` -> `{lookup_count}` (real nested-include count; "counting lookups..." while loading; falls back to `~<selected count>` estimate on error). Colour: >9 red, >=8 amber. >10 shows RFC limit warning with advice to remove providers or flatten later.
- [x] If existing record and changed: side-by-side "Current DNS record" (+ "N / 10 lookups") vs "Proposed record"; otherwise single CodeBlock labelled "Preview" or "Current record".
- [x] Actions (only when there are changes): "Apply via Cloudflare" (only if `cf_available`) -> `POST /api/domains/:id/apply-spf {record, confirm_overwrite:false}`; **needs_confirmation flow**: if response `needs_confirmation` => `window.confirm("An existing SPF record was found in DNS:\n\n<existing_record>\n\nReplace it with:\n\n<proposed_record>\n\nProceed?")`; OK => re-POST with `confirm_overwrite:true`, cancel => abort silently. Success => "SPF record applied successfully. Allow a few minutes for DNS propagation." Also "Copy record" button. Errors inline.
- [x] Healthy copy: "Your SPF record is healthy. InboxAngel monitors it daily..." when severity good and no changes. "Skip for now" is hidden when severity good (and not applied); Continue always.

Step 3 - DKIM:
- [x] Data from `status.dkim {selectors:[{name,record}], source:'cf'|'doh'}`. Selectors grouped by known provider (`matchDkimProvider`, selector prefix parsed from `<sel>._domainkey...`) in green cards with provider name and selector list; "N provider(s) in your SPF record appear to be missing DKIM" amber cards (from `findUnsignedSpfProviders` - SPF include with known provider whose selectors aren't detected; providers with no known selectors always counted as unsigned) each with "Set up DKIM ->" external link (`dkimGuideUrl`); "N unrecognised selector(s)" list with truncated (60 chars) records.
- [x] None found: "No DKIM selectors found (checked common selectors)" (suffix only if `source==='doh'`); different guidance if DMARC policy (parsed from current record `p=`) is quarantine/reject (warning) vs none (info).
- [x] Severity: good (has DKIM, none unsigned), warning (strict policy and missing/unsigned), info otherwise.
- [x] "Rescan DNS" button -> refetches `GET /api/domains/:id/onboarding-status` and recomputes locally (does not update parent status). Skip hidden when severity good.

Step 4 - DMARC:
- [x] Severity: not found => error, found but missing our rua => warning, else info.
- [x] Shows current record (copy) or "No DMARC record found for _dmarc.<domain>". Explanations per severity. Recommended record = `buildRecommendedRecord(current, 'none', rua)`; actions "Apply via Cloudflare" (if `cf_available`) -> `POST /api/domains/:id/apply-dmarc {record}` -> `{ok, record, created}`; "Copy record". On success badge info and "Reports will start arriving within 24 hours..." message.
- [x] Cross-domain report authorization record (RFC 7489 7.1; shown only when `dmarc.auth_record` present): found => green "Found. <record_name> authorizes this domain..."; missing => orange with required record text `<record_name>  TXT  "v=DMARC1;"` + copy and (if `cf_available` and a current DMARC record exists) "Create via Cloudflare" which re-calls `apply-dmarc` with the **current** record to make server provision the auth record. Errors inline.
- [x] Skip hidden when severity is info or applied.

Step 5 - Routing ("Reports routing"):
- [x] Severity: all of `mx_found && destination_verified && null_sender_spf && null_sender_dmarc` => good; any of mx_found/destination_verified => warning; else error. `recheckResult` replaces status after re-check.
- [x] MX records: found => confirmation with reports_domain; missing => explanation + "Set up email routing" -> `POST /api/setup/email-routing` -> `{ok, reports_domain, status, detail}`. `status==='already_configured'` => info "Email routing is already configured. MX records may take a few minutes to propagate - try re-checking shortly."; `'newly_configured'` => "Email routing configured successfully! MX records created and catch-all rule set."; then auto re-check.
- [x] Email destination: verified => confirmation (admin_email verified; alerts and password resets will work); else explanation + "Register email destination" -> `POST /api/settings/register-destination` -> `{ok, email, verification_sent}`; message "Verification email sent! Check your inbox and click the link from Cloudflare, then press "Re-check"." Optional `destination_debug` shown as grey "Debug: ...". (Shares `settingUp`/error state with routing setup button.)
- [x] Subdomain protection: both `null_sender_spf` and `null_sender_dmarc` => "cannot be spoofed"; else lists which of SPF/DMARC is missing and (if `mx_found`) "Add null-sender protection" button (reuses `setupEmailRouting` call).
- [x] "Re-check" button when not good -> `GET onboarding-status` and update routing section. Good => "Everything is connected..." message. Primary button "Go to dashboard ->" (marks routing complete, calls `done()`); Skip hidden when good.

---

## 17. SPF flatten wizard - `#/domains/:id/spf-flatten` (full-screen)

APIs: `GET /api/domains/:id/spf-flatten` -> `SpfFlatStatus {available, config|null, lookup_count|null}`; fallback `GET /api/domains/:id/onboarding-status` for record when no config; `POST /api/spf-lookup-count {record}` if count unknown; `GET /api/domains/:id/spf-flatten/preview` -> `{flattened_record, ip_count}` (failure tolerated); `POST /api/domains/:id/spf-flatten` -> `{ok, config: SpfFlatConfig}`. 401 handled only during initial load.

- [x] Header "<- Back to domain", "SPF Flattening", 4-dot progress (Analyze, Compare, Enable, Done).
- [x] Step 1 Analyze: current record (`config.canonical_record` if set else live record from onboarding status) with copy; lookup badge N/10 (green <8, amber 8-9, red >=10); info box when <= 7 "Your SPF record is within safe limits. Flattening is optional but still available."; if already active, green "SPF flattening is already active. N IPs in flattened record." If no SPF record: "No SPF record found..." and button becomes "Back to domain" (navigates to `#/domains/:id`).
- [x] Step 2 Compare: Original record (+ lookups badge) vs Flattened record (+ "1 lookup" badge) from `config.flattened_record` or live preview; if preview failed "Could not resolve IPs - DNS may be unreachable. The record will be generated when flattening is enabled." (note: preview failure is a degraded, not blocking, state). Back/Continue.
- [x] Step 3 Enable: if active, green notice + Continue; else warns it will IMMEDIATELY replace the SPF TXT record in Cloudflare DNS, original stored and restored on disable, re-resolved daily. Button "Enable SPF Flattening" ("Enabling...") -> POST; on success updates status with returned config and moves to Done; failure message inline (no confirm dialog). Back button.
- [x] Step 4 Done: "SPF flattening enabled", IP count, "DNS lookups reduced to 1", daily re-resolve note, flattened record code block with copy, "Back to domain ->".

## 18. MTA-STS wizard - `#/domains/:id/mta-sts` (full-screen)

APIs: `GET /api/domains/:id/mta-sts` -> `MtaStsStatus {available, config|null, summary|null}`; `POST /api/domains/:id/mta-sts` -> `{ok, mode, mx_hosts}`; `PATCH /api/domains/:id/mta-sts {mode}` -> `{ok, mode, policy_id}`. (`PATCH {refresh_mx:true}` exists in api.ts as `refreshMtaStsMx` but no UI.)

- [x] 4 steps: MX Discovery, Choose mode, Provision, Done. Initial mode from existing config (default `testing`); `mx_hosts` split on commas.
- [x] Step 1: explainer; if already active lists discovered MX hosts and current mode; else info "MX hosts will be automatically discovered from your DNS when MTA-STS is enabled." (no discovery preview before enabling).
- [x] Step 2: radio cards Testing (Recommended; report-only) vs Enforce (reject delivery if TLS fails; only after zero failures in testing).
- [x] Step 3: lists the 3 DNS records to be created (`_mta-sts` TXT, `_smtp._tls` TXT, `mta-sts` CNAME) and mode summary. "Enable MTA-STS" ("Provisioning...") => `POST` enable (always created in default mode, presumably testing), then **if mode==='enforce' a second call `PATCH` mode enforce**, then refetches status, sets MX hosts from POST result, advances. Failure after POST but before PATCH leaves it enabled in testing mode with an error message. If already active only "Continue".
- [x] Step 4: "MTA-STS enabled", mode, discovered MX hosts, "3 DNS records created. TLS failure reports will be collected automatically." and "Back to domain ->". `summary` (TLS-RPT totals: total_success/total_failure/report_count) is in the type but not displayed anywhere in the dashboard.

## 19. DMARC graduation wizard - `#/domains/:id/dmarc-wizard` (full-screen)

APIs: `GET /api/domains`; `GET /api/domains/:id/dns-check` (failure => `{found:false,has_rua:false,current_record:null,cf_managed:false}`); `PATCH /api/domains/:id/dmarc {policy}` -> `{ok, policy, record}`; refetch `GET /api/domains`.

- [x] Header "DMARC Policy Graduation", "none -> quarantine -> reject", 3-dot progress (None, Quarantine, Reject).
- [x] Starting step from the domain's policy: none=0, quarantine=1, reject=2.
- [x] Step copy: index 0 "Step 1 - Switch to quarantine" (amber), index 1 "Step 2 - Switch to reject" (blue), with explanatory text. Shows "Current record" (if known) and "New record" CodeBlock with Copy using `buildRecord`.
- [x] If `cf_managed`: button "Apply via Cloudflare ->" (coloured by step) -> PATCH dmarc policy (server writes DNS), refetch domain, set current record locally via `buildRecord`, advance step. Errors inline (no 401 handling after load).
- [x] If not cf_managed: button "I've updated it manually ->" simply advances the step with **no API call** (server-side `dmarc_policy` is NOT updated by the wizard; it relies on later DNS re-detection). Helper text "Copy the record above and update it in your DNS provider, then click confirm."
- [x] Back button (step > 0). Completed view (policy reject or step 2): "Fully enforced", green note, "Back to domain ->".
- [x] Note: no pass-rate gating inside the wizard (gating is on Domain page rollout block).

---

## 20. PDF export (Overview) - `components/PdfReport.ts` + `utils/pdfRecommendations.ts`

Library: `jspdf`, client-side only, A4 mm, filename `email-auth-report.pdf` (`doc.save`). Data: `DomainCheckSummary[]` from `GET /api/domains/:id/check-summary` for each domain and `trends: Record<domainId, DailyStat[]>` from 90-day stats.

- [x] Cover band (dark): "Email Authentication Health Report"; "Generated <Month D, YYYY> . Last 30 days of data"; "N domain(s) monitored".
- [x] Overall DMARC pass rate: big % coloured (>=95 green, >=70 yellow, else red; "No data" muted) + "X of Y messages passed" (locale numbers).
- [x] Domain Status table: columns Domain (truncated >22 chars to 20 + ellipsis), DMARC Policy (reject green / quarantine yellow / "none (monitor only)" red / "Not configured" red), DMARC Rate, SPF Rate, DKIM Rate (each "NN% (Pass|Warning|Fail)" or "N/A (Pending)"; thresholds >=95% Pass, >=70% Warning, else Fail), MTA-STS (mode or "on" if enabled, "Off" otherwise); alternating row shading; auto page-break at y>275mm (new page y=20).
- [x] Recommendations section (severity badge CRITICAL/WARNING/INFO + domain + wrapped message): rules per domain - policy none/null critical "DMARC policy is "none" (monitor only)..."; quarantine warning; DMARC pass rate < 95% (critical if < 70% else warning); SPF rate < 90% warning; DKIM rate < 90% warning; zero messages info "No DMARC reports received in the last 30 days. Verify the RUA address..."; MTA-STS not enabled info.
- [x] Weekly trend section "Weekly DMARC Pass Rate Trend": per domain (skip if no stats) 7-day buckets starting at first day (label "YYYY-MM-DD -> YYYY-MM-DD"), "NN% (passed/total)" coloured; "No data" when total 0. Stats are 90-day daily data. (Note cover says "Last 30 days" while trend uses 90 days of stats.)
- [x] Error handling: 401 -> logout, others -> `alert()`. Overview-only; there is no per-domain PDF.

---

## 21. New in v2 (not in the Preact dashboard)

- [x] API keys screen `#/keys`: create (name, optional expiry) shows the secret once with copy; list with prefix, created, last used, expiry, owner (admins see the workspace's keys); revoke one; revoke all of mine. API: `GET/POST /api/keys`, `DELETE /api/keys/:id`, `POST /api/keys/revoke-all`.
- [x] Role awareness: `GET /api/me` (added in this lane) gives the role; write controls disabled for members everywhere; Team and Audit explain when the API says "admin required".
- [x] Settings screen `#/settings`: workspace (name, email, role), change password (`POST /api/auth/change-password`), theme, instance (version, base domain, custom domain, telemetry state where readable), sign out everywhere else.
- [x] Theme toggle (light/dark) in the top bar and wizard chrome.
- [x] Sidebar app shell with collapsible sidebar and mobile drawer.
- [x] Domain overview as Level cards (Delivering → Authenticated → Protected) with findings (`web/src/lib/levels.ts`).
- [x] Domain detail DNS records as RecordBlocks with copy, "Lookup failed" vs "Not found" per record, role-gated apply buttons and the RFC 9989 rollout step and note.

## Follow-ups from #111 (hosted intake and records)

Built. The hosted UI only appears when `GET /api/hosted/config` says `enabled` (`useHostedConfig` in `web/src/lib/hosted.ts`); a disabled or failed config shows nothing and makes no other hosted request (`docs/hosted.md`, API section).

- [x] Enable hosted records on a domain: dialog with optional `spf_record` and `mta_sts`; the intake addresses (`rua`, `tls_rpt`) are shown once with copy, held in component state only; pointers as RecordBlocks. → `web/src/components/hosted/HostedPanel.tsx`, `EnableDialog.tsx`, `AddressesAlert.tsx`, `PointerList.tsx`
- [x] Hosted status on domain detail: per-pointer ok / missing / wrong / error as a Badge with icon and words, `checked_at` relative; `error` reads "Lookup failed", never missing. → `web/src/components/hosted/PointerList.tsx`, `web/src/lib/hosted.ts`
- [x] Verify pointers now: `POST …/hosted/verify`. → `web/src/components/hosted/HostedPanel.tsx`
- [x] Rotate token (confirm dialog, addresses shown once, previous token valid 72 h). → `web/src/components/hosted/HostedPanel.tsx`
- [x] Disable hosted records (confirm dialog; reminds the customer to remove the pointers). → `web/src/components/hosted/HostedPanel.tsx`
- [x] Level cards for hosted domains read `level_inputs`, and a record whose pointer is not `ok` does not count as published (finding "pointer not verified yet"). → `web/src/lib/levels.ts` (`applyHostedInputs`, `assessHostedDomain`), `web/src/components/domain/DomainLevelCard.tsx`
- [x] MTA-STS wizard on a hosted domain: the `409` shows "This domain's MTA-STS is hosted by Inbox Angel" and the enable button is hidden. → `web/src/pages/wizards/MtaStsPage.tsx`
- [x] Domain delete `502` (hosted DNS cleanup failed): shows the server message, says the domain was NOT deleted, offers Retry. → `web/src/pages/domains/DomainSettingsPage.tsx`
- [x] Hosted writes need owner/admin like the rest (`WriteButton`); members see the status read-only. → `web/src/components/hosted/HostedPanel.tsx`
- [x] Email check in `saas`: `POST /api/check-sessions` now returns `expires_at` (1 hour, one email); the page shows the expiry when present. → `web/src/pages/check/EmailCheckPage.tsx`

Error handling (`hostedError`): `409` refetches and shows the status, `422` keeps the form open with the server message, `502` offers Retry, `507` shows the message with no retry.

## Gaps

No functional gaps: every item above is implemented in `web/`. The Preact `dashboard/` folder was deleted in the final commit.

Deliberate changes (all items are `[x]`, these are where the behaviour differs on purpose):

- **Setup redirect** to the wizard happens once per tab (Skip setup is a choice), and the cached status is refreshed after any successful write.
- **Report browser** defaults to the route's domain (the old page listed every domain's reports); "All domains" toggle added.
- **Email check:** polling gives up after ~5 minutes with Retry/Cancel; a failed request is an error state, never a failed check.
- **DNS lookup failures** render as "Lookup failed" (retry) on the domain page and in all wizards; never as "Not found".
- **Confirmations** replace `window.confirm` (SPF overwrite) and were added where the old UI had none (remove member, disable SPF flattening / MTA-STS).
- **CSV export** uses an authenticated fetch + download, not `?key=` in the URL (which the API never accepted).
- **Bulk import / CT discover** are linked from Add domain (they were unreachable).
- **DMARC record builder:** `p=` no longer matches inside `sp=`; the setup wizard keeps an existing policy instead of resetting it to `none`.
- **SPF providers registry and SPF record helpers** moved to `packages/dns-checks` (`email-service-providers`, `spf-record`), shared with the Worker, `tools/audit-fleet` and the dashboard; `detectProviders` matches includes exactly.
- Dropped: the write-only `ia_onboarding_done` key; the dead `AddDomainModal`.
- Not carried over because it never existed in the old app: a monitor-subscribe form on the email check page (the pause/resume list in domain settings is ported).

Verification: component/route tests (`npm run test:web`), Playwright e2e (`e2e/dashboard-v2.spec.ts`) against local `wrangler dev`, and screenshots at 375px and desktop in light and dark (`web/screenshots/`). Not verified in a real browser: the PDF export layout, the 15s add-domain DNS poll timing, and Cloudflare-backed apply buttons (no Cloudflare token locally).
