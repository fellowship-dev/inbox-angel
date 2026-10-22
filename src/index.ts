import { handleEmail } from './email/handler';
import { handleApi } from './api/router';
import { scope } from './db/scope';
import { checkSubscription, detectRollbackRisk } from './monitor/check';
import { sendChangeNotification } from './monitor/notify';
import { sendWeeklyDigests } from './digest/weekly';
import { assertSchemaReady, SchemaNotReadyError } from '@inbox-angel/db';
import { enrichEnv, getZoneId } from './env-utils';
import { logAudit } from './audit/log';
import { track } from './telemetry';
import { flattenSpf } from './email/spf-flattener';
import { lookupSpf } from './email/dns-check';
import { discoverMxHosts, generatePolicyId, buildPolicyFile, updateMtaStsTxtRecord } from './email/mta-sts';

export interface Env {
  DB: D1Database | undefined;
  ASSETS: Fetcher;
  API_KEY?: string;              // static API key (optional — dashboard uses session auth)
  // Cloudflare (secrets — set via wrangler secret put)
  CLOUDFLARE_API_TOKEN?: string; // EMAIL token: email routing + DNS writes
  // Worker config (vars in wrangler.jsonc)
  WORKER_NAME?: string;          // defaults to "inbox-angel-worker"
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
      const config = await scope(env.DB).mtaSts.getEnabledByDomain(domain);
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
      return;
    }
    await handleEmail(message, env as BoundEnv, ctx);
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
    await enrichEnv(env, env.DB);

    // Daily telemetry heartbeat — every day 11am UTC
    if (event.cron === '0 11 * * *') {
      try {
        const stats = await scope(env.DB!).heartbeat();
        await track(env, { event: 'instance.heartbeat', ...stats });
      } catch (e) {
        console.error('[telemetry] heartbeat failed:', e);
      }
      return;
    }

    // Weekly digest — every Monday 9am UTC
    if (event.cron === '0 9 * * 1') {
      await sendWeeklyDigests(env as BoundEnv);
      return;
    }

    // Daily SPF flatten refresh — every day 10am UTC
    if (event.cron === '0 10 * * *') {
      if (env.CLOUDFLARE_API_TOKEN && getZoneId()) {
        const configs = await scope(env.DB).spf.allEnabled();
        console.log(`[spf-flatten] refreshing ${configs.length} flattened domains`);
        for (const config of configs) {
          const domain = await scope(env.DB).domains.getById(config.domain_id);
          if (!domain) continue;
          try {
            const result = await flattenSpf(domain.domain, {
              CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
            }, config.cf_record_id);
            await scope(env.DB).spf.updateResult(config.domain_id, result.flattened_record, result.ip_count, result.cf_record_id);
            console.log(`[spf-flatten] ${domain.domain}: updated (${result.ip_count} IPs)`);
            logAudit(env.DB, {
              actor_type: 'system',
              action: 'spf_flatten.update',
              resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
              before_value: { spf_record: config.flattened_record ?? config.canonical_record },
              after_value: { spf_record: result.flattened_record, ip_count: result.ip_count },
              meta: { cron: '0 10 * * *' },
            }, ctx);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await scope(env.DB).spf.updateError(config.domain_id, msg);
            console.error(`[spf-flatten] ${domain.domain}: error — ${msg}`);
          }
        }
      }
      return;
    }

    // Daily monitor check — every day 8am UTC (default / catch-all)
    // Also refresh SPF lookup counts for all domains
    const allDomains = await scope(env.DB).domains.list();
    for (const d of allDomains) {
      lookupSpf(d.domain)
        .then(spf => {
          if (spf?.lookup_count !== undefined) {
            return scope(env.DB!).domains.updateSpfLookupCount(d.id, spf.lookup_count);
          }
        })
        .catch(e => console.warn(`[monitor] SPF lookup refresh failed for ${d.domain}:`, e));
    }

    // Rollback regression check — for domains actively in a staged rollout
    for (const d of allDomains) {
      if (!d.rollout_rec_policy || d.rollout_rec_pct == null) continue;
      try {
        const now = Math.floor(Date.now() / 1000);
        const [curr, prev] = await Promise.all([
          scope(env.DB!).reports.dailyStats(d.id, now - 7 * 86400),
          scope(env.DB!).reports.dailyStats(d.id, now - 14 * 86400),
        ]);
        const currRows = curr;
        const prevRows = prev.filter(r => r.day < new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
        const rate = (rows: typeof currRows) => {
          const t = rows.reduce((n, r) => n + r.total, 0);
          const p = rows.reduce((n, r) => n + r.passed, 0);
          return t > 0 ? Math.round((p / t) * 100) : null;
        };
        const currRate = rate(currRows);
        const prevRate = rate(prevRows);
        if (detectRollbackRisk(currRate, prevRate)) {
          console.warn(`[rollout] ${d.domain}: pass rate dropped from ${prevRate}% to ${currRate}% after step ${d.rollout_rec_policy}${d.rollout_rec_pct === 0 ? ' (t=y)' : ''} — rollback recommended`);
        }
      } catch (e) {
        console.error(`[rollout] regression check failed for ${d.domain}:`, e);
      }
    }

    // MTA-STS MX refresh — update policy_id in DNS if MX hosts changed
    if (env.CLOUDFLARE_API_TOKEN && getZoneId()) {
      const mtaConfigs = await scope(env.DB).mtaSts.allEnabled();
      const patchEnv = { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN };
      for (const cfg of mtaConfigs) {
        const domain = await scope(env.DB).domains.getById(cfg.domain_id);
        if (!domain) continue;
        try {
          const liveMx = await discoverMxHosts(domain.domain);
          if (liveMx.length === 0) {
            // No MX answer: never publish an MTA-STS policy that lists no mx hosts.
            console.warn(`[mta-sts] ${domain.domain}: no MX records found, leaving policy unchanged`);
            continue;
          }
          const storedMx = cfg.mx_hosts ? cfg.mx_hosts.split(',').filter(Boolean) : [];
          // Compare as sets: DNS answer order is not stable
          const sortedLive = [...liveMx].sort();
          const sortedStored = [...storedMx].sort();
          const changed = sortedLive.length !== sortedStored.length || sortedLive.some((h, i) => h !== sortedStored[i]);
          if (changed && cfg.mta_sts_record_id) {
            const newPolicyId = generatePolicyId();
            await updateMtaStsTxtRecord(cfg.mta_sts_record_id, newPolicyId, patchEnv);
            await scope(env.DB).mtaSts.updateMxHosts(cfg.domain_id, liveMx.join(','), newPolicyId);
            console.log(`[mta-sts] ${domain.domain}: MX changed, policy_id updated`);
            logAudit(env.DB, {
              actor_type: 'system',
              action: 'cron.mta_sts_mx',
              resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
              before_value: { mx_hosts: storedMx, policy_id: cfg.policy_id },
              after_value: { mx_hosts: liveMx, policy_id: newPolicyId },
              meta: { cron: '0 8 * * *' },
            }, ctx);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await scope(env.DB).mtaSts.updateError(cfg.domain_id, msg);
          console.error(`[mta-sts] ${domain.domain}: MX refresh error — ${msg}`);
        }
      }
    }

    const subscriptions = await scope(env.DB).monitor.active(200);
    console.log(`[monitor] checking ${subscriptions.length} subscriptions`);

    for (const sub of subscriptions) {
      try {
        const { changes, newBaseline, errors } = await checkSubscription(sub);
        if (errors.spf || errors.dmarc) {
          console.warn(`[monitor] ${sub.domain}: DNS lookup failed, baseline kept (${[errors.spf, errors.dmarc].filter(Boolean).join('; ')})`);
        }
        await scope(env.DB).monitor.updateBaseline(sub.id, newBaseline);

        if (changes.length > 0) {
          console.log(`[monitor] ${sub.domain} changed: ${changes.map(c => c.field).join(', ')}`);
          await sendChangeNotification(sub.email, sub.domain, changes, env);
        }
      } catch (e) {
        console.error(`[monitor] error checking ${sub.domain}:`, e);
      }
    }
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
