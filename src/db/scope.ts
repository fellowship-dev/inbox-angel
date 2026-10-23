/**
 * Workspace-scoped queries. The workspace is always explicit: there is no default,
 * so a call site that forgets its tenant fails to compile instead of silently
 * acting on the implicit workspace. Request and cron code gets it from
 * `tenant.scope` (src/tenancy/context.ts).
 */
import { forWorkspace, globalQueries, type WorkspaceScope, type DbLike } from '@inbox-angel/db';

export type { WorkspaceScope };

/** Workspace-scoped queries for one tenant. */
export function scope(db: DbLike, workspaceId: string): WorkspaceScope {
	return forWorkspace(db, workspaceId);
}

/** Queries on tables that are not tenant data (credentials, free checks, IP cache). */
export const globals = globalQueries;
