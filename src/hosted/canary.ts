// Canary (Check Email): the anonymous free check on the hosted service.
//
//   check+<token>@canary.inboxangel.io
//
// The token is issued by POST /api/check-sessions, stored hashed with an expiry, and good for one
// email. It resolves to an anonymous check session, never to an account: results land in
// check_results (global) and the browser polls them by the same token.

import type { BoundEnv } from '../index';
import { globalQueries } from '@inbox-angel/db';
import { TenantContext } from '../tenancy/context';
import { track } from '../telemetry';
import { hostedConfig } from './config';
import { extractAuthResults } from '../email/parse-headers';
import { organizationalDomain } from '@inbox-angel/dns-checks';
import { generateToken, hashToken, isTokenShaped, type ParsedRecipient } from './tokens';

/** How long a canary address works after it is handed out. */
export const CANARY_TTL_SECONDS = 3600;
/** Checks accepted per sender domain per window (the reply is a full DNS audit, so it is not free). */
export const CANARY_PER_DOMAIN_LIMIT = 5;
/** Checks from senders that authenticate as no domain (all share one bucket), and checks overall, per window. */
export const CANARY_UNAUTHENTICATED_LIMIT = 20;
export const CANARY_GLOBAL_LIMIT = 500;
export const CANARY_WINDOW_MS = 3600_000;
/** A check email is small; anything bigger is not one. */
const MAX_CANARY_BYTES = 5 * 1024 * 1024;

/** Not an account: the id of the context an anonymous check runs in. It owns no rows. */
export const ANONYMOUS_ACCOUNT_ID = '__anonymous__';

export interface CanarySession { token: string; email: string; expires_at: number }

export async function issueCanary(env: BoundEnv, nowSeconds = Math.floor(Date.now() / 1000)): Promise<CanarySession | null> {
  const { canaryDomain } = hostedConfig(env);
  if (!canaryDomain) return null;
  const token = generateToken();
  const expires_at = nowSeconds + CANARY_TTL_SECONDS;
  await globalQueries(env.DB).canary.issue(await hashToken(token), expires_at);
  return { token, email: `check+${token}@${canaryDomain}`, expires_at };
}

/**
 * The domain the sender proved it is: a passing DMARC / DKIM / SPF result in Authentication-Results (added by Cloudflare
 * on receipt), reduced to its registrable domain. The From header is never used: anyone can claim a domain in it.
 */
export function authenticatedDomain(headers: Headers): string | null {
  const auth = extractAuthResults(headers);
  const proven = [auth?.dmarc, auth?.dkim, auth?.spf].find(r => r?.result === 'pass' && r.domain);
  return proven?.domain ? organizationalDomain(proven.domain) ?? proven.domain : null;
}

function reject(message: ForwardableEmailMessage, reason: string, fields: Record<string, unknown> = {}): void {
  console.warn('[canary] rejected', JSON.stringify({ ...fields, reason }));
  message.setReject(reason);
}

export async function handleCanaryEmail(message: ForwardableEmailMessage, env: BoundEnv, rcpt: ParsedRecipient): Promise<void> {
  const { canaryDomain } = hostedConfig(env);
  if (rcpt.base !== 'check' || !rcpt.tag || !isTokenShaped(rcpt.tag)) return reject(message, 'Unknown recipient');
  if (message.rawSize > MAX_CANARY_BYTES) return reject(message, 'Message too large');

  const db = globalQueries(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const hash = await hashToken(rcpt.tag);
  if (!(await db.canary.consume(hash, now))) return reject(message, 'This check address is unknown, expired or already used', { token: hash.slice(0, 8) });

  // Rate limits. A spoofed From must not be able to use up a real domain's allowance, so the per-domain bucket is keyed
  // on the authenticated domain only; everything else shares one small bucket, and one global cap bounds the total.
  const domain = authenticatedDomain(message.headers);
  const now_ms = Date.now();
  if ((await db.rateLimit.hit('canary:global', now_ms, CANARY_WINDOW_MS)).count > CANARY_GLOBAL_LIMIT) return reject(message, 'Free checks are busy, try again later');
  const bucket = domain ? `canary:${domain}` : 'canary:unauthenticated';
  const limit = domain ? CANARY_PER_DOMAIN_LIMIT : CANARY_UNAUTHENTICATED_LIMIT;
  if ((await db.rateLimit.hit(bucket, now_ms, CANARY_WINDOW_MS)).count > limit) return reject(message, 'Too many checks from this domain, try again later', { bucket });

  const tenant = new TenantContext({
    env,
    accountId: ANONYMOUS_ACCOUNT_ID,
    mode: 'saas',
    settings: { reportsDomain: canaryDomain, fromEmail: `noreply@${canaryDomain}` },
  });
  // Loaded on demand: free-check imports cloudflare:email, which only exists inside the Workers runtime.
  const { handleFreeCheck } = await import('../email/free-check');
  const { result } = await handleFreeCheck(message, tenant, rcpt.tag);
  track(tenant, { event: 'check.received', result });
}
