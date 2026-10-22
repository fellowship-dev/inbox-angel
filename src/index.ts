import { handleEmail } from './email/handler';
import { handleApi } from './api/router';
import { scope } from './db/scope';
import { loadTenant } from './tenancy/load';
import { resolveDomainOwner, resolveInboundAccount } from './tenancy/resolver';
import { runCronForAccounts } from './cron';
import { buildPolicyFile } from './email/mta-sts';
import { assertSchemaReady, SchemaNotReadyError } from '@inbox-angel/db';

export interface Env {
  DB: D1Database | undefined;
  ASSETS: Fetcher;
  API_KEY?: string;              // DEPRECATED self-host "instance admin" key. Prefer per-user keys (Settings → API keys).
  // Auth (all optional)
  SAAS_ENABLED?: string;         // "1" to allow MODE=saas (hosted mode is not launched yet; explicit opt-in)
  OWNER_EMAIL?: string;          // self-host: only this email may claim first ownership (password or OAuth)
  BETTER_AUTH_SECRET?: string;   // session signing secret; generated and kept in D1 if unset
  BETTER_AUTH_URL?: string;      // public origin when it differs from the request's (custom domain behind a proxy)
  TRUSTED_ORIGINS?: string;      // extra origins allowed to make cookie-authenticated writes (comma-separated)
  GITHUB_CLIENT_ID?: string;     // GitHub / Google sign-in appears only when both id and secret are set
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Cloudflare (secrets — set via wrangler secret put)
  CLOUDFLARE_API_TOKEN?: string; // EMAIL token: email routing + DNS writes
  // Worker config (vars in wrangler.jsonc)
  WORKER_NAME?: string;          // defaults to "inbox-angel-worker"
  MODE?: string;                 // "selfhost" (default) | "saas"
  // Bindings
  SEND_EMAIL?: SendEmail;        // CF Email Workers outbound binding
  AUTH_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> }; // auth rate limiting (10/min)
  API_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };  // global rate limiting (200/min)
}

/** Env after the DB-bound guard: entry points serve the setup page / bail out when DB is unbound. */
export type BoundEnv = Env & { DB: D1Database };

// HTTP API (dashboard calls, DNS provisioning)
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      const domain = hostname.slice('mta-sts.'.length);
      const owner = await resolveDomainOwner(env, domain);
      const config = await scope(env.DB, owner).mtaSts.getEnabledByDomain(domain);
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
    const tenant = await loadTenant(bound, { accountId: await resolveInboundAccount(bound, message.to) });
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
    await runCronForAccounts(event, env as BoundEnv, ctx);
  },
} satisfies ExportedHandler<Env>;


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
    <li>Deploy:<br><pre>npm run deploy</pre>Then visit your dashboard, create an account, and enter your domain in the setup wizard.</li>
  </ol>
  <div class="note">
    Full setup guide: <a href="https://github.com/fellowship-dev/inbox-angel#self-hosting" target="_blank">github.com/fellowship-dev/inbox-angel</a>
  </div>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
