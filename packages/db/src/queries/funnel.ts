/**
 * Email-funnel queries: leads and the suppression list. Both tables are global (platform marketing
 * data, see GLOBAL_TABLES), so nothing here touches tenant data except `deleteSubscriptionsFor`, which an
 * unsubscribe needs: it removes one address from every workspace's monitor subscriptions.
 */
import { and, asc, desc, eq, lt, lte, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { leads, suppression, monitorSubscriptions, type LeadStatus } from '../schema';

export type LeadRow = typeof leads.$inferSelect;

/** SHA-256 hex of the normalised (trimmed, lower-cased) address: the only form in which a suppressed address is kept. */
export async function hashEmail(email: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface LeadUpsert {
	email: string;
	domain: string;
	check_level: string | null;
	check_summary: string | null;
	/** When the first email is due if this is a new lead. */
	first_send_at: number;
	now: number;
}

export function funnelQueries(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		suppression: {
			add: async (email: string, reason: string) =>
				db.insert(suppression).values({ email_hash: await hashEmail(email), reason }).onConflictDoNothing().run(),
			has: async (email: string) => !!(await db.select({ h: suppression.email_hash }).from(suppression).where(eq(suppression.email_hash, await hashEmail(email))).get()),
		},

		leads: {
			byEmail: (email: string) => db.select().from(leads).where(eq(leads.email, email)).get().then((r) => r ?? null),
			byId: (id: number) => db.select().from(leads).where(eq(leads.id, id)).get().then((r) => r ?? null),

			/** New lead, or an existing one with fresh activity and its latest check (the sequence is not restarted). */
			async upsert(l: LeadUpsert): Promise<'created' | 'existing'> {
				const existing = await db.select({ id: leads.id }).from(leads).where(eq(leads.email, l.email)).get();
				if (existing) {
					await db.update(leads).set({ domain: l.domain, check_level: l.check_level, check_summary: l.check_summary, last_activity_at: l.now }).where(eq(leads.id, existing.id)).run();
					return 'existing';
				}
				await db
					.insert(leads)
					.values({ email: l.email, domain: l.domain, check_level: l.check_level, check_summary: l.check_summary, created_at: l.now, last_activity_at: l.now, next_send_at: l.first_send_at })
					.onConflictDoNothing()
					.run();
				return 'created';
			},

			due: (now: number, limit: number) =>
				db.select().from(leads).where(and(eq(leads.status, 'active'), lte(leads.next_send_at, now))).orderBy(asc(leads.next_send_at)).limit(limit).all(),

			/**
			 * Record that the email for `step` is being sent, BEFORE sending it: step +1, next due time, status completed when
			 * there is no next (null). True only for the one caller whose step and due time still match, so a repeated or
			 * overlapping run cannot take the same step. A crash after this point loses that one email rather than repeating it.
			 */
			advance: (id: number, step: number, nextSendAt: number | null, now: number) =>
				db
					.update(leads)
					.set({ step: step + 1, next_send_at: nextSendAt, last_sent_at: now, status: nextSendAt === null ? 'completed' : 'active' })
					.where(and(eq(leads.id, id), eq(leads.status, 'active'), eq(leads.step, step), lte(leads.next_send_at, now)))
					.returning({ id: leads.id })
					.all()
					.then((r) => r.length === 1),

			/** Undo an `advance` when the provider definitely did not take the email (a configuration error). */
			restore: (id: number, advancedTo: number, step: number, nextSendAt: number, lastSentAt: number | null) =>
				db.update(leads).set({ step, next_send_at: nextSendAt, last_sent_at: lastSentAt, status: 'active' }).where(and(eq(leads.id, id), eq(leads.step, advancedTo))).run(),

			/** Push the next send out (the step is held, not sent). */
			release: (id: number, nextSendAt: number) => db.update(leads).set({ next_send_at: nextSendAt }).where(eq(leads.id, id)).run(),

			setStatus: (id: number, status: LeadStatus) => db.update(leads).set({ status, next_send_at: null }).where(eq(leads.id, id)).run(),

			delete: (email: string) => db.delete(leads).where(eq(leads.email, email)).run(),

			list: (limit: number, offset = 0) => db.select().from(leads).orderBy(desc(leads.created_at)).limit(limit).offset(offset).all(),

			counts: () =>
				db
					.select({ status: leads.status, n: sql<number>`count(*)` })
					.from(leads)
					.groupBy(leads.status)
					.all(),

			/** Retention: leads with no activity since `cutoff`. */
			deleteInactiveBefore: (cutoff: number) => db.delete(leads).where(lt(leads.last_activity_at, cutoff)).run().then((r) => r.meta.changes ?? 0),
		},

		/** An unsubscribed address leaves every workspace's change-alert subscriptions too. */
		deleteSubscriptionsFor: (email: string) =>
			db.delete(monitorSubscriptions).where(/* workspace-scope-exempt: an unsubscribe applies to the address in every workspace */ eq(monitorSubscriptions.email, email)).run(),
	};
}
