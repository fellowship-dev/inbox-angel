import { metricQueries } from './metrics';
import { accessQueries } from './access-grants';
export * from './access-grants';
import { getDb, type DbLike } from '../client';
import { IMPLICIT_WORKSPACE_ID } from '../schema';
import { apiKeyQueries } from './api-keys';
import { analyticsQueries } from './analytics';
import { auditQueries } from './audit';
import { baseDomainQueries } from './base-domain';
import { claimQueries } from './claims';
import { connectionQueries } from './connections';
import { domainQueries } from './domains';
export type { DomainRow, DmarcFacts } from './domains';
import { mtaStsQueries, spfFlattenQueries } from './domain-config';
import { heartbeatStats } from './heartbeat';
import { hostedQueries, intakeQueries } from './intake';
import { monitorQueries } from './monitor';
import { reportQueries } from './reports';
import type { CountingMode } from './counting';
import { settingsQueries } from './settings';
import { teamQueries } from './team';

export * from './reports';
export { counted, type CountingMode } from './counting';
export type { DomainClaimRow } from './claims';
export { claimLookups } from './claims';
export type { SenderRow, TrendRow } from './analytics';
export { FIRST_SEEN_HORIZON_DAYS } from './analytics';
export * from './audit';
export * from './team';
export * from './api-keys';
export type { CfConnectionInfo, CfConnectionZone } from './connections';
export { authLookups } from './auth';
export { PlanLimitError } from './plan-limit';
export { workspaceLifecycle, type WorkspaceSummary } from './workspaces';
export { intakeLookups, STORED_ROW, UNCOUNTED_ROW, isUncountedTier, type DropRow, TOKEN_ROTATION_GRACE_SECONDS, type QuotaLimits, type QuotaResult, type QuotaScope, type FailureRow, type IntakeTarget, type HostedDomainRow, type PointerStatus } from './intake';
export * from './heartbeat';
export type { MtaStsMode } from './domain-config';
export { globalQueries, type IpInfoRow } from './global';
export { byteLength, chunkJson, storeStatements, JSON_PARAM_MAX_BYTES, SQL_MAX_BYTES, type RecordTuple, type StoreReportInput } from './report-store';
export { lifecycleQueries, sweepLimits, DEFAULT_STATEMENT_BUDGET, type SweepLimits, type SweepResult, type Tombstone } from './global-lifecycle';
export { exportQueries, EXPORT_COLUMNS, EXPORT_EXCLUDED, EXPORT_SETTING_KEYS } from './export';
export { funnelQueries, hashEmail, type LeadRow } from './funnel';

/**
 * Every tenant-data query, bound to one workspace. There is deliberately no way
 * to build a query on these tables without a workspace id.
 *
 *   const q = forWorkspace(env.DB, workspaceId);
 *   const domains = await q.domains.list();
 */
export interface ScopeOptions {
	/** Which stored reports feed the numbers. Default `registry`: a caller that does not say counts only registry reporters. */
	counting?: CountingMode;
}

export function forWorkspace(db: DbLike, workspaceId: string, opts: ScopeOptions = {}) {
	const d = getDb(db);
	const counting = opts.counting ?? 'registry';
	return {
		workspaceId,
		metrics: metricQueries(d, workspaceId),
		access: accessQueries(d, workspaceId),
		domains: domainQueries(d, workspaceId),
		claims: claimQueries(d, workspaceId),
		reports: reportQueries(d, workspaceId, counting),
		analytics: analyticsQueries(d, workspaceId, counting),
		counting,
		monitor: monitorQueries(d, workspaceId),
		settings: settingsQueries(d, workspaceId),
		baseDomain: baseDomainQueries(d, workspaceId),
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
