import { handleEmail } from './email/handler';
import { handleApi } from './api/router';
import { handleRelay, isRelayPath, relayEnabled } from './connections/relay';
import { scope } from './db/scope';
import { loadTenant } from './tenancy/load';
import { resolveInboundWorkspace } from './tenancy/resolver';
import { getMode } from './tenancy/mode';
import { handleHostedEmail } from './hosted/intake';
import { resolvePolicyHost } from './hosted/policy-host';
import { runHostedCron } from './hosted/cron';
import { runCronForWorkspaces } from './cron';
import { buildPolicyFile } from './email/mta-sts';
import { assertSchemaReady, SchemaNotReadyError } from '@inbox-angel/db';

export interface Env {
  DB: D1Database | undefined;
  ASSETS: Fetcher;
  API_KEY?: string;              // DEPRECATED self-host "instance admin" key. Prefer per-user keys (Settings → API keys).
  // Data retention, whole days (docs/data-retention.md). Defaults are the published windows.
  RAW_XML_RETENTION_DAYS?: string;      // raw report XML / TLS-RPT JSON: default 30 (self-host), 0 = never store (hosted)
  RETENTION_REPORTS_DAYS?: string;      // aggregate report rows and records: default 395 (13 months)
  RETENTION_TLS_DAYS?: string;          // TLS-RPT reports: default 395
  RETENTION_IP_INFO_DAYS?: string;      // IP enrichment cache: default 30
  RETENTION_CHECK_RESULTS_DAYS?: string; // free-check results: default 30
  RETENTION_INVITES_DAYS?: string;      // days after expiry: default 30
  RETENTION_AUDIT_DAYS?: string;        // audit log: default 365
  // Auth (all optional)
  SAAS_ENABLED?: string;         // "1" to allow MODE=saas (hosted mode is not launched yet; explicit opt-in)
  BOOTSTRAP_SECRET?: string;     // installer-held random one-use capability (at least 32 characters)
  OAUTH_KV?: KVNamespace;        // instance-owned agent OAuth storage
  MCP_DCR_ENABLED?: string;     // explicit legacy client compatibility option; DCR off by default
  OWNER_EMAIL?: string;          // optional owner email restriction; never an ownership proof
  BETTER_AUTH_SECRET?: string;   // session signing secret; generated and kept in D1 if unset
  TURNSTILE_SECRET_KEY?: string; // hosted (MODE=saas): Cloudflare Turnstile secret. REQUIRED for sign-up: without it sign-up fails closed (503)
  TURNSTILE_SITE_KEY?: string;   // hosted: the matching public site key, served to the sign-up page
  BETTER_AUTH_URL?: string;      // public origin when it differs from the request's (custom domain behind a proxy)
  TRUSTED_ORIGINS?: string;      // extra origins allowed to make cookie-authenticated writes (comma-separated)
  GITHUB_CLIENT_ID?: string;     // GitHub / Google sign-in appears only when both id and secret are set
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Cloudflare (secrets — set via wrangler secret put)
  CLOUDFLARE_API_TOKEN?: string; // EMAIL token: email routing + DNS writes
  // Cloudflare connections (docs/cloudflare-oauth.md)
  TOKEN_ENCRYPTION_KEY?: string;     // secret: AES-256 key(s) for stored Cloudflare tokens, `kid:base64,…` (first seals); `openssl rand -base64 32`
  CF_OAUTH_CLIENT_ID?: string;       // Cloudflare OAuth public client; OAuth is offered only when id + authorize + token URLs are set
  CF_OAUTH_AUTHORIZE_URL?: string;
  CF_OAUTH_TOKEN_URL?: string;
  CF_OAUTH_REVOKE_URL?: string;
  CF_OAUTH_SCOPES?: string;          // space- or comma-separated scope names
  CF_OAUTH_REDIRECT_URI?: string;    // default: <origin>/api/cloudflare/oauth/callback
  CF_OAUTH_RELAY_URL?: string;       // self-host: send the OAuth redirect through this relay (e.g. https://connect.inboxangel.io)
  CF_OAUTH_RELAY_SECRET?: string;    // secret, relay deployment only: signs the relay state; setting it turns this Worker into the relay
  // Worker config (vars in wrangler.jsonc)
  WORKER_NAME?: string;          // defaults to "inbox-angel-worker"
  MODE?: string;                 // "selfhost" (default) | "saas"
  // Hosted service (MODE=saas + SAAS_ENABLED=1), see docs/hosted.md
  INTAKE_DOMAIN?: string;        // central report address domain, e.g. rua.inboxangel.io
  CANARY_DOMAIN?: string;        // anonymous free-check address domain, e.g. canary.inboxangel.io
  HOSTED_RECORDS_ZONE?: string;  // zone holding the hosted records, e.g. inboxangel.io
  HOSTED_RECORDS_LABEL?: string; // single label every hosted record lives under (default "h")
  INTAKE_MAX_REPORTS_PER_DAY?: string; // per intake token and authenticated reporter domain (default 50)
  INTAKE_MAX_RECORDS_PER_REPORT?: string; // default 20000
  INTAKE_MAX_BYTES_PER_DAY?: string; // raw message bytes per token and authenticated reporter domain per UTC day (default 50 MiB)
  INTAKE_MAX_REPORTERS_PER_DAY?: string; // distinct authenticated reporter domains per token per UTC day (default 100)
  INTAKE_MAX_UNAUTH_REPORTS_PER_DAY?: string; // messages not proven by the receiver, per claimed sender domain per token per UTC day (default 200)
  INTAKE_MAX_UNAUTH_BYTES_PER_DAY?: string; // raw bytes of that bucket (default 1 GiB)
  INTAKE_MAX_TOTAL_REPORTS_PER_DAY?: string; // per token per UTC day across all proven reporters that are not well known (default 1000)
  INTAKE_MAX_TOTAL_BYTES_PER_DAY?: string; // raw bytes of that total (default 1 GiB)
  INTAKE_MAX_UNAUTH_SENDERS_PER_DAY?: string; // distinct claimed sender domains with their own bucket per token per day; the rest share one (default 50)
  INTAKE_MAX_NEW_IPS_PER_REPORT?: string; // uncached source IPs enriched per report (default 50)
  HOSTED_MAX_DOMAINS_PER_WORKSPACE?: string; // hosted-records domains per workspace (default 10)
  HOSTED_RECORDS_TOKEN?: string; // secret: least-privilege DNS:Edit token for that one zone
  // Email funnel and compliance (docs/email-funnel.md)
  RESEND_API_KEY?: string;       // secret: Resend API key; the onboarding sequence is sent with Resend (Cloudflare Email Service is transactional-only)
  MAIL_FROM?: string;            // sender address of funnel mail, e.g. max@inboxangel.io (default noreply@<CANARY_DOMAIN>)
  MAIL_FROM_NAME?: string;       // display name of funnel mail (default "Inbox Angel")
  MAIL_REPLY_TO?: string;        // where replies to funnel mail and to the free-check report go (a mailbox someone reads); no Reply-To when unset
  SITE_URL?: string;             // public marketing site (https), for links in the free-check report; no link when unset
  PUBLIC_BASE_URL?: string;      // public origin of this Worker, for unsubscribe and confirmation links (falls back to BETTER_AUTH_URL)
  AUTHSERV_ID?: string;          // authserv-id of the receiving server's results (see docs/email-funnel.md); with AUTHSERV_HEADER, REQUIRED for the sequence to enrol anyone
  AUTHSERV_HEADER?: string;      // "ar" (Authentication-Results) or "arc" (ARC-Authentication-Results): the one header kind the receiver adds; REQUIRED for enrolment
  POSTAL_ADDRESS?: string;       // postal address shown in the footer of non-transactional mail
  BOOKING_URL?: string;          // booking link in the day-14 note; that step is held until it is set
  SERVICE_PRICES?: string;       // JSON {"fix":"$…","keepFixed":"$…/mo","bimi":"$…/mo"}: the prices in the day-10 email
  ONBOARDING_SEQUENCE_ENABLED?: string; // "1" turns the onboarding sequence on for self-host; hosted: on unless "0"
  SITE_ORIGINS?: string;         // comma-separated origins allowed to call the free-check endpoints from a browser (CORS)
  // Bindings
  SEND_EMAIL?: SendEmail;        // CF Email Workers outbound binding
  AUTH_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> }; // auth rate limiting (10/min)
  API_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };  // global rate limiting (200/min)
}

/** Env after the DB-bound guard: entry points serve the setup page / bail out when DB is unbound. */
export type BoundEnv = Env & { DB: D1Database };

// HTTP API (dashboard calls, DNS provisioning)
export const coreWorker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // OAuth relay deployment (CF_OAUTH_RELAY_SECRET set): stateless, needs no database. Inert everywhere else.
    if (relayEnabled(env) && isRelayPath(new URL(request.url).pathname)) return handleRelay(request, env);
    if (!env.DB) return setupPage();
    try {
      await assertSchemaReady(env.DB);
    } catch (e) {
      if (e instanceof SchemaNotReadyError) return new Response(e.message, { status: 503 });
      throw e;
    }
    const url = new URL(request.url);
    const { pathname, hostname } = url;

    // MTA-STS policy file — served on mta-sts.* hostnames per RFC 8461
    // mta-sts.domain.com CNAME → this Worker; CF Universal SSL covers HTTPS
    if (hostname.startsWith('mta-sts.') && pathname === '/.well-known/mta-sts.txt') {
      const policyHost = await resolvePolicyHost(env, hostname);
      const config = policyHost && await scope(env.DB, policyHost.workspaceId).mtaSts.getEnabledByDomain(policyHost.domain);
      if (!config) return new Response('MTA-STS not configured for this domain', { status: 404 });
      const mxHosts = config.mx_hosts ? config.mx_hosts.split(',').filter(Boolean) : [];
      const policy = buildPolicyFile(config.mode, mxHosts, 86400);
      return new Response(policy, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'max-age=300',
        },
      });
    }

    if (pathname === '/health' || pathname.startsWith('/api/')) {
      return handleApi(request, env as BoundEnv, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  // Email Worker (inbound: free check + DMARC RUA reports)
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DB) { console.error('[email] DB binding missing — D1 not configured'); return; }
    try {
      await assertSchemaReady(env.DB);
    } catch (e) {
      console.error('[email]', e instanceof Error ? e.message : e);
      // Throw (don't return): returning would accept the message and silently drop the report.
      // An uncaught Worker error is a delivery failure, so the sending MTA retries. (setReject()
      // is a permanent 5xx and senders would give up.)
      throw e;
    }
    const bound = env as BoundEnv;
    // Hosted: the token in the recipient picks the workspace (or the anonymous check); there is no default workspace.
    if (getMode(bound) === 'saas') return handleHostedEmail(message, bound);
    const tenant = await loadTenant(bound, { workspaceId: await resolveInboundWorkspace(bound, message.to) });
    await handleEmail(message, tenant, ctx);
  },

  // Cron dispatcher — routes by schedule expression
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DB) { console.error('[cron] DB binding missing — D1 not configured'); return; }
    try {
      await assertSchemaReady(env.DB);
    } catch (e) {
      console.error('[cron]', e instanceof Error ? e.message : e);
      return;
    }
    await runCronForWorkspaces(event, env as BoundEnv, ctx);
    await runHostedCron(event, env as BoundEnv, ctx);
  },
} satisfies ExportedHandler<Env>;


export default coreWorker;

function setupPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>InboxAngel — Setup Required</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 80px auto; padding: 0 24px; color: #1a1a1a; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    .badge { display: inline-block; background: #fef3c7; color: #92400e; font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-bottom: 24px; }
    ol { padding-left: 1.25rem; line-height: 2; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    pre { background: #f3f4f6; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; line-height: 1.6; }
    a { color: #4f46e5; }
    .note { background: #eff6ff; border-left: 3px solid #3b82f6; padding: 12px 16px; border-radius: 0 8px 8px 0; font-size: 0.9rem; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>🪄 InboxAngel</h1>
  <div class="badge">Setup required</div>
  <p>Your Worker is running, but no D1 database is attached yet. Complete these steps to finish setup:</p>
  <ol>
    <li>Create a D1 database:<br><pre>wrangler d1 create inbox-angel</pre></li>
    <li>Copy the <code>database_id</code> from the output and paste it into <code>wrangler.jsonc</code> under <code>d1_databases[0].database_id</code>.</li>
    <li>Set your API token:<br><pre>wrangler secret put CLOUDFLARE_API_TOKEN</pre>
      <small>This is the only secret you need. Your domain is configured in the setup wizard after first login.</small>
    </li>
    <li>Deploy:<br><pre>npm run deploy</pre>Then visit your dashboard, create a workspace, and enter your domain in the setup wizard.</li>
  </ol>
  <div class="note">
    Full setup guide: <a href="https://github.com/fellowship-dev/inbox-angel#self-hosting" target="_blank">github.com/fellowship-dev/inbox-angel</a>
  </div>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
