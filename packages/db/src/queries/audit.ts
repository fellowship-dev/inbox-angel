import { and, desc, eq, gte, like, lte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { auditLog } from '../schema';

export interface AuditEntryRow {
	actor_id?: string | null;
	actor_email?: string | null;
	actor_type?: 'user' | 'system';
	action: string;
	resource_type?: string | null;
	resource_id?: string | null;
	resource_name?: string | null;
	/** Already-serialised JSON, or null. */
	before_value?: string | null;
	after_value?: string | null;
	meta?: string | null;
}

export interface AuditListOptions {
	page?: number;
	limit?: number;
	action?: string;
	domain_id?: string;
	actor_id?: string;
	since?: number;
	until?: number;
}

export function auditQueries(db: Db, accountId: string) {
	return {
		insert(e: AuditEntryRow) {
			return db
				.insert(auditLog)
				.values({
					account_id: accountId,
					actor_id: e.actor_id ?? null,
					actor_email: e.actor_email ?? null,
					actor_type: e.actor_type ?? 'user',
					action: e.action,
					resource_type: e.resource_type ?? null,
					resource_id: e.resource_id ?? null,
					resource_name: e.resource_name ?? null,
					before_value: e.before_value ?? null,
					after_value: e.after_value ?? null,
					meta: e.meta ?? null,
				})
				.run();
		},

		list(opts: AuditListOptions = {}) {
			const { page = 1, limit = 50, action, domain_id, actor_id, since, until } = opts;
			const safeLimit = Math.min(limit, 200);
			const offset = (page - 1) * safeLimit;

			const where: (SQL | undefined)[] = [];
			if (action) where.push(like(auditLog.action, action.replace(/%/g, '') + '%'));
			if (domain_id) where.push(and(eq(auditLog.resource_id, domain_id), eq(auditLog.resource_type, 'domain')));
			if (actor_id) where.push(eq(auditLog.actor_id, actor_id));
			if (since) where.push(gte(auditLog.created_at, since));
			if (until) where.push(lte(auditLog.created_at, until));

			return db
				.select()
				.from(auditLog)
				.where(and(eq(auditLog.account_id, accountId), ...where))
				.orderBy(desc(auditLog.created_at))
				.limit(safeLimit)
				.offset(offset)
				.all();
		},
	};
}
