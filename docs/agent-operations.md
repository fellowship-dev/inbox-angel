# Agents, product credentials and source metrics

The same installation serves its dashboard, HTTP API and MCP endpoint. Self-hosted agents authenticate with that installation; no Fellowship account or central issuer is required. Reports work with live DNS and explicit unavailable-history states before inbound reporting, outbound mail or Google Postmaster is configured.

## Installer setup

Each installation needs its own migrated D1 database, `OAUTH_KV` namespace and canonical HTTPS origin. Do not reuse another installation's OAuth namespace, database or credentials. In `wrangler.jsonc`, replace the D1 database id and `REPLACE_WITH_INSTALLATION_OAUTH_KV_ID` with the resources you created:

```sh
npx wrangler d1 create inbox-angel
npx wrangler kv namespace create OAUTH_KV
```

Set `BETTER_AUTH_URL` in Worker vars to the exact public origin, for example `https://mail.example.com`. It must have no path, query, fragment or embedded credentials. An explicitly configured HTTPS port is part of that origin. `PUBLIC_BASE_URL` is accepted as an origin fallback for MCP, but setting `BETTER_AUTH_URL` keeps browser auth, callbacks and agent issuer aligned. A request sent to a different origin is refused. Preserve the configured Worker-first routes for `/mcp`, `/oauth/*` and OAuth discovery; an SPA fallback must not serve those endpoints.

Before deployment and first-owner setup, generate an installer-held random proof in a **new private file outside the checkout**. For example:

```sh
mkdir -p "$HOME/.config/inbox-angel"
chmod 700 "$HOME/.config/inbox-angel"
bootstrap_file="$HOME/.config/inbox-angel/bootstrap-proof"
(umask 077; set -C; openssl rand -hex 32 > "$bootstrap_file")
```

Stop if the file already exists; use a new private path instead of overwriting an existing proof. The commands do not print its value. Upload through standard input:

```sh
npx wrangler secret put BOOTSTRAP_SECRET < "$bootstrap_file"
```

Store the proof privately (for example, in the installer's password manager). Open the file through a trusted local editor when entering it into the browser's masked **Installer proof** field. Never print it, paste it into agent chat, put it in a URL or commit it. The dashboard sends it only in `X-Inbox-Angel-Bootstrap`, alongside the owner account form; the proof is not a JSON-body field. The configured value must be at least 32 characters; accepted submissions are capped at 512 characters. A proof is consumed after successful owner setup and cannot reopen signup. Email/password setup does not require SMTP, Google or GitHub sign-in. Social sign-in cannot claim first ownership.

Apply migrations and build before serving the new code (`npm run deploy` performs build → migration → deploy). The one-click deployment is a starting point: it does not remove the namespace, canonical-origin or installer-proof steps. Creating a deployment is separate from verifying its browser and MCP behavior.

## First useful report

1. Complete owner setup, then enroll a domain in the browser. A clean self-host can use manual enrollment; the report does not require granting Cloudflare DNS write access. Hosted enrollment returns a durable pending claim until ownership is proved; retrying resumes the claim rather than creating another monitored domain.
2. In **Settings → Agents and product access**, copy this installation's HTTPS `/mcp` endpoint.
3. From the repository, create a new installation-specific plugin directory:

   ```sh
   node tools/configure-agent-plugin.mjs --endpoint https://mail.example.com/mcp --out /tmp/my-inbox-angel-plugin
   ```

   The generator refuses existing output directories and URLs containing credentials, a query or a fragment. It writes endpoint configuration, never a token. Install that generated directory through the client's supported local-plugin flow, then reload the client/tools. See [plugin setup](../plugins/inbox-angel/SETUP.md). The source package has no default server connection.
4. Start the client's browser sign-in. Review the requesting client's publisher/name, token-return hostname, exact workspace/product/domain tuples, actions and expiry. A self-registered client's name is not verified; a loopback redirect sends access to a local application. Consent lasts 1–30 days. Newly added domains, products and memberships do not expand an existing finite grant.
5. Confirm callable tools exist, call `whoami`, then `list_domains` and `get_email_report` for the exact permitted domain. The report must contain live DNS findings, observed source evidence or precise unavailable states, and proposed fixes with prerequisites and verification.

Installation, tool reload, browser authorization, a successful identity call and a useful report are separate checkpoints. Never label an installed plugin connected just because its configuration exists. Direct MCP clients may use the same HTTPS endpoint without the plugin. Client-ID metadata documents are supported; dynamic client registration is off by default and requires the operator's explicit `MCP_DCR_ENABLED=1` setting for clients that need it.

## Unattended product workers

Only a browser **owner** can administer product access or Google Postmaster connections; the admin role alone is insufficient. In owner Settings:

1. Create a named workspace product and assign existing authorized domains. One domain may be mapped to several products.
2. Select the exact credential domains, actions and a finite expiry. Name the service principal and credential, then issue it.
3. Save the masked, one-time `ias_…` credential directly into the worker's secret store. Copy it before acknowledging **Credential stored — clear secret**. It cannot be retrieved later; lists expose only prefixes and usage/expiry metadata.
4. Use it as `Authorization: Bearer <credential>` for `/mcp`, or as `X-Api-Key`/bearer on authorized HTTP routes. Credentials are bound to their principal/workspace and explicit grants. They cannot administer users, create stronger credentials or acquire new domains by guessing IDs.

A partial failure after principal creation is shown with its principal ID and current grants. Review it or revoke the partial principal before starting again; blindly repeating the whole sequence creates duplicate identities.

Rotation creates the replacement first. Store and update the worker with it, then acknowledge **Replacement stored — revoke previous and clear** to revoke the old credential. Existing grants and their expiry remain unchanged. If the replacement was lost before storage, revoke that replacement and issue another; do not recover a secret from logs. Owners can revoke individual grants or credentials, or disable the principal. Interactive users revoke their own browser-authorized agents in Settings. D1 denial is checked on the next completed authorization check; provider cleanup may follow asynchronously. Last-use timestamps are informational and do not extend expiry.

## Upgrade from broad prelaunch keys

Back up the database and apply [the additive migrations](../packages/db/UPGRADING.md). Migration `0006_access_grants.sql` revokes the old `api_keys` rows and adds products, principals, grants and hashed credentials. It preserves users, memberships, domains, report history and the old audit/key rows. It does **not** guess narrower authority for a broad key.

Legacy `ia_…` keys and the old `API_KEY` environment value no longer authenticate. `POST /api/keys` is retired (`410`); old dashboard `/keys` bookmarks lead to Settings. Sign in as the existing owner, create products/mappings and finite grants, issue replacement credentials, update each worker's secret store and verify its permitted report and denied sibling access. No data reset or database recreation is part of this upgrade. Do not restore a broad-key bypass to avoid reissuing credentials.

## Google Postmaster is a separate owner connection

Google sign-in (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) and agent OAuth are separate from Google Postmaster access. The operator configures:

| Setting | Meaning |
|---|---|
| `GOOGLE_POSTMASTER_CLIENT_ID` | Google OAuth application's client ID |
| `GOOGLE_POSTMASTER_CLIENT_SECRET` | Private Google OAuth application secret |
| `TOKEN_ENCRYPTION_KEY` | Private `kid:base64(32 random bytes)` encryption key; preserve it for existing encrypted connections |
| `BETTER_AUTH_URL` | This installation's canonical HTTPS origin |

Register the exact callback `https://mail.example.com/api/metrics/google/oauth/callback` on that application's OAuth client and enable the Google Postmaster API access required by the operator's Google project. The requested read-only scope is `https://www.googleapis.com/auth/postmaster.traffic.readonly`. See [token encryption and rotation](cloudflare-oauth.md#rotating-token_encryption_key) for key format and custody; removing a key still needed by either provider's envelopes makes those stored credentials unreadable.

In **Settings → Google Postmaster metrics**, the owner explicitly connects a domain and approves Google's browser consent. The Google account needs Postmaster access to that domain. Then use **Sync** for a bounded 1–90 day window. This implementation performs owner-requested sync; opening a report reads cached evidence and does not silently grant consent, refresh provider data or schedule a new collection job.

The panel exposes configuration, connection status, last attempt, last successful fetch and cache age. Reports preserve the provider's source periods, fetch time, metric definition, filter, population, unit and denominator where available. Original `provider-rate` values are not silently converted to percentages or averaged. Missing/suppressed data is `no_data`, not zero. Permission denial, revoked tokens, rate limits, provider errors and disconnected/unconfigured states remain explicit; previously cached observations can survive a failed fetch and are labeled stale.

Disconnect stops local use of the connection. If the operator also wants to withdraw Google's app authorization, remove it in the Google account; do not assume a local disconnect proved remote revocation. Never put Google access/refresh tokens in a product credential or agent prompt.

## Read the report correctly

DMARC counts describe messages represented in received aggregate reports; TLS-RPT counts describe observed SMTP TLS sessions. Google spam complaints describe Google's eligible Gmail population. SMTP acceptance, bounces and inbox placement are different measurements. Inbox placement remains explicitly `not_measured` when no source measures it.

Product selectors restrict access, not attribution. A domain shared by two products still has **shared-domain coverage**; its aggregate telemetry cannot identify either product's share. Coverage shows report-start dates, original source periods, receipt/fetch ages, missing dates and truncation. Missing dates are gaps in captured evidence, not proof that no mail was sent. Fresh DNS findings remain useful even when every history source is unavailable.

Proposed fixes reuse the shared report model's evidence, prerequisites, unresolved provider-specific placeholders, expected current values and verification steps. Reports and remediation plans do not change DNS, tighten enforcement or send messages. Existing execution routes require separate explicit authorization and fresh preconditions.

## Owner recovery and acceptance boundaries

Save the owner's password and recovery custody during installation. **Forgot password** uses the configured outbound email path; test delivery to the owner's verified destination separately. A first report needs no outbound service, so an installation with none has no email-based self-service recovery. An already authenticated owner can change their own password. Lost machine credentials are replaced through an authenticated owner session; they are never recovered in clear.

The consumed installer proof is not an owner-recovery bypass. If all owner sessions/passwords and outbound recovery are unavailable, stop for verified operator recovery with a protected D1 backup and the actual installation/account identity. This release does not ship an unattended owner-reset command. Do not clear the owner, `bootstrap_consumed`, users or report data to reopen first setup.

Repository fixtures and local HTTPS protocol/browser tests establish their tested policy and wiring only. They do not establish a deployed desktop client's install/reload/consent/tool behavior or a live Google account's access and unsuppressed metrics. Keep deployed client acceptance and an explicitly approved live Google grant/readback pending until their own receipts exist. A provider's withheld metric stays unresolved even when other metrics succeed. Public signup, production deployment, DNS changes and mail sends require their own authorization and acceptance.
