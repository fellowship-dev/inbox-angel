import { getDb, type DbLike } from '../client';
import { IMPLICIT_ACCOUNT_ID } from '../schema';
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
export { intakeLookups, TOKEN_ROTATION_GRACE_SECONDS, type IntakeTarget, type HostedDomainRow, type PointerStatus } from './intake';
export * from './heartbeat';
export type { MtaStsMode } from './domain-config';
export { globalQueries } from './global';

/**
 * Every tenant-data query, bound to one account. There is deliberately no way
 * to build a query on these tables without an account id.
 *
 *   const q = forAccount(env.DB, accountId);
 *   const domains = await q.domains.list();
 */
export function forAccount(db: DbLike, accountId: string) {
	const d = getDb(db);
	return {
		accountId,
		domains: domainQueries(d, accountId),
		reports: reportQueries(d, accountId),
		analytics: analyticsQueries(d, accountId),
		monitor: monitorQueries(d, accountId),
		settings: settingsQueries(d, accountId),
		spf: spfFlattenQueries(d, accountId),
		mtaSts: mtaStsQueries(d, accountId),
		audit: auditQueries(d, accountId),
		team: teamQueries(d, accountId),
		apiKeys: apiKeyQueries(d, accountId),
		connections: connectionQueries(d, accountId),
		intake: intakeQueries(d, accountId),
		hosted: hostedQueries(d, accountId),
		heartbeat: () => heartbeatStats(d, accountId),
	};
}

export type AccountScope = ReturnType<typeof forAccount>;

/** Self-hosted installs have exactly one account. */
export const forImplicitAccount = (db: DbLike) => forAccount(db, IMPLICIT_ACCOUNT_ID);
