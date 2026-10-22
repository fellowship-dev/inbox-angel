// Who is this request for?
//
// `AccountResolver` is the seam between tenancy and authentication. The default
// (self-host) resolver always answers with the one implicit account. A session-based
// resolver (Better Auth) plugs in here later without touching anything else.
//
// A resolver returns null when the request belongs to no account; callers treat
// that as "unauthenticated".

import type { Env } from '../index';
import { IMPLICIT_ACCOUNT_ID, globalQueries } from '@inbox-angel/db';
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
 * Account an inbound email belongs to. Self-host: the implicit account. For saas this is
 * where routing by recipient (reports domain / per-account address) will live.
 */
export async function resolveInboundAccount(_env: Env, _toAddress: string): Promise<string> {
  return IMPLICIT_ACCOUNT_ID;
}

/**
 * Account that owns a monitored domain, for unauthenticated lookups keyed by hostname
 * (the MTA-STS policy file). Self-host: the implicit account. Saas will look the domain up.
 */
export async function resolveDomainOwner(_env: Env, _domain: string): Promise<string> {
  return IMPLICIT_ACCOUNT_ID;
}
