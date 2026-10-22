import { getDb, type DbLike } from '../client';
import { IMPLICIT_ACCOUNT_ID } from '../schema';
import { auditQueries } from './audit';
import { domainQueries } from './domains';
import { mtaStsQueries, spfFlattenQueries } from './domain-config';
import { heartbeatStats } from './heartbeat';
import { monitorQueries } from './monitor';
import { reportQueries } from './reports';
import { settingsQueries } from './settings';
import { teamQueries } from './team';

export * from './reports';
export * from './audit';
export * from './team';
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
		monitor: monitorQueries(d, accountId),
		settings: settingsQueries(d, accountId),
		spf: spfFlattenQueries(d, accountId),
		mtaSts: mtaStsQueries(d, accountId),
		audit: auditQueries(d, accountId),
		team: teamQueries(d, accountId),
		heartbeat: () => heartbeatStats(d, accountId),
	};
}

export type AccountScope = ReturnType<typeof forAccount>;

/** Self-hosted installs have exactly one account. */
export const forImplicitAccount = (db: DbLike) => forAccount(db, IMPLICIT_ACCOUNT_ID);
