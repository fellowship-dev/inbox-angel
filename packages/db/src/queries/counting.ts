import { sql, type SQL } from 'drizzle-orm';

/**
 * Which stored aggregate reports feed the numbers (pass rates, failing senders, anomalies, safe-to-enforce, levels, digests, MCP):
 *   registry       only reports the intake classed 'counted': the carrier email authenticated AND its sender is in the reporter registry
 *                  (src/dmarc/known-reporters.ts). NULL (stored before the column existed), 'unknown' and 'unauthenticated' are not counted.
 *                  The hosted mode.
 *   authenticated  every report whose carrier authenticated (`reporter_auth = 'pass'`), registry reporter or not.
 *   all            every stored report (the self-host default: an upgrade must not zero a dashboard).
 * The mode is fixed when the workspace's queries are built (`forWorkspace(db, id, { counting })`), so a query cannot forget it.
 */
export type CountingMode = 'registry' | 'authenticated' | 'all';

/** SQL for "this aggregate report counts"; `alias` is the table or alias of aggregate_reports in the statement. */
export function counted(alias: string, mode: CountingMode): SQL {
	if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('bad alias');
	if (mode === 'all') return sql`1 = 1`;
	// COALESCE: a legacy row (NULL column) is plainly "not counted", so NOT (counted) selects it (NOT NULL would be NULL and drop it).
	return mode === 'authenticated' ? sql.raw(`COALESCE(${alias}.reporter_auth, '') = 'pass'`) : sql.raw(`COALESCE(${alias}.reporter_tier, '') = 'counted'`);
}
