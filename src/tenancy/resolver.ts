// Who is this request for?
//
// `AccountResolver` is the seam between tenancy and authentication. The default
// (self-host) resolver always answers with the one implicit account. A session-based
// resolver (Better Auth) plugs in here later without touching anything else.
//
// A resolver returns null when the request belongs to no account; callers treat
// that as "unauthenticated".

import type { Env } from '../index';
import { IMPLICIT_ACCOUNT_ID, globalQueries, intakeLookups } from '@inbox-angel/db';
import { getMode } from './mode';
import { sessionAccountResolver } from '../auth/resolver';

export interface ResolvedAccount {
  accountId: string;
  userId?: string;
  role?: string;
}

export type AccountResolver = (request: Request, env: Env) => Promise<ResolvedAccount | null>;

/** Self-host: every request acts on the single implicit account. */
export const selfHostResolver: AccountResolver = async () => ({ accountId: IMPLICIT_ACCOUNT_ID });

/**
 * The resolver used when none is injected: session / API key → user → membership → account
 * (src/auth/resolver.ts). Self-host callers resolve to acct_default; saas callers to their own account.
 */
export function defaultResolver(_env: Env): AccountResolver {
  return sessionAccountResolver;
}

/**
 * Accounts a cron run has to cover. Self-host has exactly one, without a lookup;
 * saas enumerates the accounts table.
 */
export async function listCronAccounts(env: Env): Promise<string[]> {
  if (getMode(env) === 'selfhost' || !env.DB) return [IMPLICIT_ACCOUNT_ID];
  return globalQueries(env.DB).accounts.ids();
}

/**
 * Account an inbound email belongs to. Self-host: the implicit account. In saas there is deliberately
 * no answer here: mail is routed by the token in its address (src/hosted/intake.ts), and falling back
 * to a default account would file one customer's reports under another's.
 */
export async function resolveInboundAccount(env: Env, _toAddress: string): Promise<string> {
  if (getMode(env) === 'saas') throw new Error('resolveInboundAccount: MODE=saas routes inbound mail by token (src/hosted/intake.ts)');
  return IMPLICIT_ACCOUNT_ID;
}

/**
 * Account that owns a monitored domain, for unauthenticated lookups keyed by hostname
 * (the MTA-STS policy file). Self-host: the implicit account. Saas: the account of the hosted
 * domain, or null when nobody hosts it (the caller answers 404).
 */
export async function resolveDomainOwner(env: Env, domain: string): Promise<string | null> {
  if (getMode(env) !== 'saas') return IMPLICIT_ACCOUNT_ID;
  if (!env.DB) return null;
  return (await intakeLookups(env.DB).hostedByDomain(domain.toLowerCase()))?.account_id ?? null;
}
