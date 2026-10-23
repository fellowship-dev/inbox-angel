// Who is this request for?
//
// `WorkspaceResolver` is the seam between tenancy and authentication. The default
// (self-host) resolver always answers with the one implicit workspace. A session-based
// resolver (Better Auth) plugs in here later without touching anything else.
//
// A resolver returns null when the request belongs to no workspace; callers treat
// that as "unauthenticated".

import type { Env } from '../index';
import { IMPLICIT_WORKSPACE_ID, globalQueries, intakeLookups } from '@inbox-angel/db';
import { getMode } from './mode';
import { sessionWorkspaceResolver } from '../auth/resolver';

export interface ResolvedWorkspace {
  workspaceId: string;
  userId?: string;
  role?: string;
}

export type WorkspaceResolver = (request: Request, env: Env) => Promise<ResolvedWorkspace | null>;

/** Self-host: every request acts on the single implicit workspace. */
export const selfHostResolver: WorkspaceResolver = async () => ({ workspaceId: IMPLICIT_WORKSPACE_ID });

/**
 * The resolver used when none is injected: session / API key → user → membership → workspace
 * (src/auth/resolver.ts). Self-host callers resolve to ws_default; saas callers to their own workspace.
 */
export function defaultResolver(_env: Env): WorkspaceResolver {
  return sessionWorkspaceResolver;
}

/**
 * Workspaces a cron run has to cover. Self-host has exactly one, without a lookup;
 * saas enumerates the workspaces table.
 */
export async function listCronWorkspaces(env: Env): Promise<string[]> {
  if (getMode(env) === 'selfhost' || !env.DB) return [IMPLICIT_WORKSPACE_ID];
  return globalQueries(env.DB).workspaces.ids();
}

/**
 * Workspace an inbound email belongs to. Self-host: the implicit workspace. In saas there is deliberately
 * no answer here: mail is routed by the token in its address (src/hosted/intake.ts), and falling back
 * to a default workspace would file one customer's reports under another's.
 */
export async function resolveInboundWorkspace(env: Env, _toAddress: string): Promise<string> {
  if (getMode(env) === 'saas') throw new Error('resolveInboundWorkspace: MODE=saas routes inbound mail by token (src/hosted/intake.ts)');
  return IMPLICIT_WORKSPACE_ID;
}

/**
 * Workspace that owns a monitored domain, for unauthenticated lookups keyed by hostname
 * (the MTA-STS policy file). Self-host: the implicit workspace. Saas: the workspace of the hosted
 * domain, or null when nobody hosts it (the caller answers 404).
 */
export async function resolveDomainOwner(env: Env, domain: string): Promise<string | null> {
  if (getMode(env) !== 'saas') return IMPLICIT_WORKSPACE_ID;
  if (!env.DB) return null;
  return (await intakeLookups(env.DB).hostedByDomain(domain.toLowerCase()))?.workspace_id ?? null;
}
