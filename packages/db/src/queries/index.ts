import { getDb, type DbLike } from '../client';
import { IMPLICIT_WORKSPACE_ID } from '../schema';
import { apiKeyQueries } from './api-keys';
import { analyticsQueries } from './analytics';
import { auditQueries } from './audit';
import { connectionQueries } from './connections';
import { domainQueries } from './domains';
import { mtaStsQueries, spfFlattenQueries } from './domain-config';
import { heartbeatStats } from './heartbeat';
import { hostedQueries, intakeQueries } from './intake';
import { monitorQueries } from './monitor';
import { reportQueries } from './reports';
import { settingsQueries } from './settings';
import { teamQueries } from './team';

export * from './reports';
export type { SenderRow, TrendRow } from './analytics';
export { FIRST_SEEN_HORIZON_DAYS } from './analytics';
export * from './audit';
export * from './team';
export * from './api-keys';
export type { CfConnectionInfo, CfConnectionZone } from './connections';
export { authLookups } from './auth';
export { workspaceLifecycle, type WorkspaceSummary } from './workspaces';
export { intakeLookups, TOKEN_ROTATION_GRACE_SECONDS, type IntakeTarget, type HostedDomainRow, type PointerStatus } from './intake';
export * from './heartbeat';
export type { MtaStsMode } from './domain-config';
export { globalQueries } from './global';

/**
 * Every tenant-data query, bound to one workspace. There is deliberately no way
 * to build a query on these tables without a workspace id.
 *
 *   const q = forWorkspace(env.DB, workspaceId);
 *   const domains = await q.domains.list();
 */
export function forWorkspace(db: DbLike, workspaceId: string) {
	const d = getDb(db);
	return {
		workspaceId,
		domains: domainQueries(d, workspaceId),
		reports: reportQueries(d, workspaceId),
		analytics: analyticsQueries(d, workspaceId),
		monitor: monitorQueries(d, workspaceId),
		settings: settingsQueries(d, workspaceId),
		spf: spfFlattenQueries(d, workspaceId),
		mtaSts: mtaStsQueries(d, workspaceId),
		audit: auditQueries(d, workspaceId),
		team: teamQueries(d, workspaceId),
		apiKeys: apiKeyQueries(d, workspaceId),
		connections: connectionQueries(d, workspaceId),
		intake: intakeQueries(d, workspaceId),
		hosted: hostedQueries(d, workspaceId),
		heartbeat: () => heartbeatStats(d, workspaceId),
	};
}

export type WorkspaceScope = ReturnType<typeof forWorkspace>;

/** Self-hosted installs have exactly one workspace. */
export const forImplicitWorkspace = (db: DbLike) => forWorkspace(db, IMPLICIT_WORKSPACE_ID);
