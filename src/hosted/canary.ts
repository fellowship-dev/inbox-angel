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
import { generateToken, hashToken, isTokenShaped, type ParsedRecipient } from './tokens';

/** How long a canary address works after it is handed out. */
export const CANARY_TTL_SECONDS = 3600;
/** Checks accepted per sender domain per window (the reply is a full DNS audit, so it is not free). */
export const CANARY_PER_DOMAIN_LIMIT = 5;
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

function senderDomain(from: string): string {
  const at = from.lastIndexOf('@');
  return (at >= 0 ? from.slice(at + 1) : from).toLowerCase();
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

  const domain = senderDomain(message.from);
  const { count } = await db.rateLimit.hit(`canary:${domain}`, Date.now(), CANARY_WINDOW_MS);
  if (count > CANARY_PER_DOMAIN_LIMIT) return reject(message, 'Too many checks from this domain, try again later', { sender_domain: domain });

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
