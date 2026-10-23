// Who is this request for?
//
// `WorkspaceResolver` is the seam between tenancy and authentication. The default
// (self-host) resolver always answers with the one implicit workspace. A session-based
// resolver (Better Auth) plugs in here later without touching anything else.
//
// A resolver returns null when the request belongs to no workspace; callers treat
// that as "unauthenticated".

import type { Env } from '../index';
import { IMPLICIT_WORKSPACE_ID, globalQueries, intakeLookups, workspaceLifecycle } from '@inbox-angel/db';
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
 * (src/auth/resolver.ts). The caller acts in the workspace named by X-Workspace-Id (oldest membership if absent).
 */
export function defaultResolver(_env: Env): WorkspaceResolver {
  return sessionWorkspaceResolver;
}

/** Workspaces a cron run has to cover: all of them (self-host installs may have several too). */
export async function listCronWorkspaces(env: Env): Promise<string[]> {
  if (!env.DB) return [IMPLICIT_WORKSPACE_ID];
  return globalQueries(env.DB).workspaces.ids();
}

/**
 * Workspace an inbound email belongs to. Self-host: the workspace that owns the address's reports domain
 * (each workspace has its own base/reports domain), else the implicit one. In saas there is deliberately
 * no answer here: mail is routed by the token in its address (src/hosted/intake.ts), and falling back
 * to a default workspace would file one customer's reports under another's.
 */
export async function resolveInboundWorkspace(env: Env, toAddress: string): Promise<string> {
  if (getMode(env) === 'saas') throw new Error('resolveInboundWorkspace: MODE=saas routes inbound mail by token (src/hosted/intake.ts)');
  const host = (toAddress ?? '').toLowerCase().split('@')[1];
  if (!env.DB || !host) return IMPLICIT_WORKSPACE_ID;
  return (await workspaceLifecycle(env.DB).byReportsDomain(host)) ?? IMPLICIT_WORKSPACE_ID;
}

/**
 * Workspace that owns a monitored domain, for unauthenticated lookups keyed by hostname
 * (the MTA-STS policy file). Self-host: the workspace monitoring that hostname, else the implicit one.
 * Saas: the workspace of the hosted domain, or null when nobody hosts it (the caller answers 404).
 */
export async function resolveDomainOwner(env: Env, domain: string): Promise<string | null> {
  if (getMode(env) !== 'saas') return (env.DB && (await workspaceLifecycle(env.DB).byDomain(domain.toLowerCase()))) || IMPLICIT_WORKSPACE_ID;
  if (!env.DB) return null;
  return (await intakeLookups(env.DB).hostedByDomain(domain.toLowerCase()))?.workspace_id ?? null;
}
