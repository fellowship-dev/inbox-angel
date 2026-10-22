/**
 * The one place the Worker decides which account a request acts on.
 *
 * Self-hosted installs have a single implicit account, so every call site gets
 * it. The TEN lane replaces this with a TenantContext resolved per request.
 */
import { forAccount, globalQueries, IMPLICIT_ACCOUNT_ID, type AccountScope, type DbLike } from '@inbox-angel/db';

export type { AccountScope };

/** Account-scoped queries for the current request. */
export function scope(db: DbLike): AccountScope {
	return forAccount(db, IMPLICIT_ACCOUNT_ID);
}

/** Queries on tables that are not tenant data (credentials, free checks, IP cache). */
export const globals = globalQueries;
