// One configuration check for the person who runs this instance. On the hosted service (MODE=saas) that person is the
// verified account whose email is OWNER_EMAIL: without OWNER_EMAIL nobody can see this check (src/funnel/routes.ts isInstanceOwner). Workers have no startup hook, so the dashboard
// asks for it (GET /api/instance/preflight, instance owner only). Every message names a setting and what it breaks;
// none ever contains a configured value, so a secret cannot leak through it.
import { forImplicitWorkspace } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import { mcpInstallation } from '../mcp/discovery';
import { getMode } from '../tenancy/mode';
import { bookingUrl, helpUrl, sequenceEnabled } from '../funnel/config';
import { intakeSetupFindings } from '../reports/auth-status';
import { reportIntakePreflightItems } from '../hosted/report-intake-check';

export interface PreflightItem {
  /** Stable id for tests and the UI key. */
  id: 'mode' | 'auth_url' | 'oauth_storage' | 'booking_link' | 'mail_sender' | 'bot_check' | 'client_registration' | 'rate_limits' | 'intake';
  /** `action`: something does not work until it is fixed. `note`: works, but worth knowing. */
  severity: 'action' | 'note';
  /** The setting(s) to change, by name. */
  setting: string;
  message: string;
}

export interface Preflight {
  mode: 'self-host' | 'saas';
  agents: AgentAvailability;
  items: PreflightItem[];
}

export interface AgentAvailability {
  available: boolean;
  /** The MCP server URL agents connect to, when available. */
  server_url: string | null;
}

/** Can this instance accept agent connections? Needs instance-owned OAuth storage and a canonical HTTPS origin. */
export function agentAvailability(env: Pick<BoundEnv, 'OAUTH_KV' | 'BETTER_AUTH_URL' | 'PUBLIC_BASE_URL'>): AgentAvailability {
  if (!env.OAUTH_KV) return { available: false, server_url: null };
  try {
    return { available: true, server_url: mcpInstallation(env).resource };
  } catch {
    return { available: false, server_url: null };
  }
}

export async function instancePreflight(env: BoundEnv, requestOrigin: string): Promise<Preflight> {
  const items: PreflightItem[] = [];
  const mode = getMode(env);
  const hosted = mode === 'saas';
  const rawMode = env.MODE?.trim().toLowerCase();

  // Mode
  if (rawMode && rawMode !== 'saas' && rawMode !== 'selfhost') {
    items.push({ id: 'mode', severity: 'action', setting: 'MODE', message: 'MODE is set to something other than "selfhost" or "saas", so this instance runs as self-hosted. Set it to one of the two, or remove it.' });
  } else if (!hosted && env.SAAS_ENABLED === '1') {
    items.push({ id: 'mode', severity: 'note', setting: 'MODE, SAAS_ENABLED', message: 'SAAS_ENABLED is 1 but MODE is not "saas", so this instance runs as self-hosted. Remove SAAS_ENABLED, or set MODE to "saas" to run the hosted service.' });
  }

  // Canonical address (sign-in links, cookies, agent issuer)
  let origin: string | null = null;
  try {
    origin = mcpInstallation(env).issuer;
  } catch {
    const set = !!(env.BETTER_AUTH_URL || env.PUBLIC_BASE_URL);
    items.push({
      id: 'auth_url', severity: 'action', setting: 'BETTER_AUTH_URL',
      message: set
        ? 'BETTER_AUTH_URL is not a plain HTTPS address (https://host, with no path). Agents cannot connect, and links in email may point to the wrong place.'
        : 'BETTER_AUTH_URL is not set. Set it to this dashboard\'s HTTPS address (https://host, with no path). Until then agents cannot connect.',
    });
  }
  if (origin && origin !== requestOrigin) {
    items.push({ id: 'auth_url', severity: 'note', setting: 'BETTER_AUTH_URL', message: 'You opened the dashboard at a different address than BETTER_AUTH_URL. Agents connect only through the configured address, and sign-in works most reliably there.' });
  }

  // Agent OAuth storage
  if (!env.OAUTH_KV) {
    items.push({ id: 'oauth_storage', severity: 'action', setting: 'OAUTH_KV', message: 'No OAUTH_KV namespace is bound. Create a KV namespace for this instance only and bind it as OAUTH_KV. Until then agents cannot connect.' });
  }
  if (env.MCP_DCR_ENABLED === '1') {
    items.push({ id: 'client_registration', severity: 'note', setting: 'MCP_DCR_ENABLED', message: 'Open client registration is on: any app can register itself before asking you for access. Turn it off unless an agent you use needs it.' });
  }

  // Mail sender: password reset everywhere, and sign-up confirmation on the hosted service.
  const settings = await forImplicitWorkspace(env.DB).settings.getMany(['from_email', 'base_domain']);
  const sender = settings.get('from_email') || settings.get('base_domain');
  if (!env.SEND_EMAIL || !sender) {
    const what = hosted ? 'Sign-up confirmation and password reset emails' : 'Password reset emails';
    items.push({
      id: 'mail_sender', severity: hosted ? 'action' : 'note', setting: !env.SEND_EMAIL ? 'SEND_EMAIL' : 'Sender address',
      message: !env.SEND_EMAIL
        ? `${what} cannot be sent: the SEND_EMAIL binding is missing.`
        : `${what} cannot be sent: there is no sender address yet. The setup wizard sets it when you add the first domain.`,
    });
  }

  // Bot check (Cloudflare Turnstile)
  const secret = !!env.TURNSTILE_SECRET_KEY, siteKey = !!env.TURNSTILE_SITE_KEY;
  if (hosted && !secret) {
    items.push({ id: 'bot_check', severity: 'action', setting: 'TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY', message: 'Sign-up is closed: the bot check is not configured. Set both Turnstile keys to open it.' });
  } else if (secret !== siteKey) {
    items.push({ id: 'bot_check', severity: 'action', setting: 'TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY', message: 'Only one of the two Turnstile keys is set. Set both, or neither.' });
  }

  // Rate limits: a missing ratelimit binding fails open, so the hosted service must have every one.
  // This is the one place that reports them (it replaces reading /api/me's dns_preview_limiter).
  if (hosted) {
    const missing = (['API_LIMITER', 'AUTH_LIMITER', 'MCP_LIMITER', 'OAUTH_TOKEN_LIMITER', 'MCP_ANON_LIMITER', 'DNS_PREVIEW_LIMITER'] as const).filter(name => !env[name]);
    if (missing.length) {
      items.push({
        id: 'rate_limits', severity: 'action', setting: missing.join(', '),
        message: `${missing.length === 1 ? 'A rate limit binding is' : `${missing.length} rate limit bindings are`} missing, so the requests ${missing.length === 1 ? 'it counts' : 'they count'} are not limited${missing.includes('MCP_LIMITER') || missing.includes('API_LIMITER') ? ', and agents are refused until MCP_LIMITER and API_LIMITER are both bound' : ''}. Add the ratelimit bindings from wrangler.jsonc to this Worker.`,
      });
    }
  }

  // Report intake: authentication settings and caps hit recently (src/reports/auth-status.ts).
  items.push(...await intakeSetupFindings(env));
  items.push(...reportIntakePreflightItems(env)); // the fixed report address: INTAKE_DOMAIN and who may connect (src/hosted/report-intake-check.ts)

  // Booking link: the day-14 follow-up email offers a call through it, and hosted dashboards show it as "Talk to Max".
  // Hosted uses the same https-only rule as the dashboard link (helpUrl), so this check and the link always agree.
  if (hosted && !helpUrl(env)) {
    items.push({ id: 'booking_link', severity: 'note', setting: 'BOOKING_URL', message: 'No https booking link is set (BOOKING_URL), so the dashboard shows no "Talk to Max" link and the day-14 follow-up email, which offers a call, is held until there is one.' });
  } else if (!hosted && sequenceEnabled(env) && !bookingUrl(env)) {
    items.push({ id: 'booking_link', severity: 'note', setting: 'BOOKING_URL', message: 'No booking link is set (BOOKING_URL, an http or https address), so the day-14 follow-up email, which offers a call, is held until there is one.' });
  }

  return { mode: hosted ? 'saas' : 'self-host', agents: agentAvailability(env), items };
}
