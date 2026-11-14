import { sql, type SQL } from 'drizzle-orm';

/**
 * Which stored aggregate reports feed the numbers (pass rates, failing senders, anomalies, safe-to-enforce, levels, digests, MCP):
 *   proven  only reports whose email proved the reporting organisation (`reporter_auth = 'pass'`). NULL (stored before the column
 *           existed or never judged), 'fail' and 'none' are not counted.
 *   all     every stored report (the self-host default: one tenant, a private address, and `AUTHSERV_*` unset means nothing is proven).
 * The mode is fixed when the workspace's queries are built (`forWorkspace(db, id, { counting })`), so a query cannot forget it.
 */
export type CountingMode = 'proven' | 'all';

/** SQL for "this aggregate report counts"; `alias` is the table or alias of aggregate_reports in the statement. */
export function counted(alias: string, mode: CountingMode): SQL {
	if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('bad alias');
	return mode === 'all' ? sql`1 = 1` : sql.raw(`${alias}.reporter_auth = 'pass'`);
}
