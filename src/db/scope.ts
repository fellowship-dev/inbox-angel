/**
 * Account-scoped queries. The account is always explicit: there is no default,
 * so a call site that forgets its tenant fails to compile instead of silently
 * acting on the implicit account. Request and cron code gets it from
 * `tenant.scope` (src/tenancy/context.ts).
 */
import { forAccount, globalQueries, type AccountScope, type DbLike } from '@inbox-angel/db';

export type { AccountScope };

/** Account-scoped queries for one tenant. */
export function scope(db: DbLike, accountId: string): AccountScope {
	return forAccount(db, accountId);
}

/** Queries on tables that are not tenant data (credentials, free checks, IP cache). */
export const globals = globalQueries;
