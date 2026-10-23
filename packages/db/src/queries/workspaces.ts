/**
 * User-level workspace lifecycle: list the workspaces a user belongs to, rename, leave, delete.
 * These run on a *user* and a workspace id taken from the URL, so each checks membership
 * itself (the caller passes the role it looked up); nothing here is reachable without one.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import {
	apiKeys, auditLog, aggregateReports, cloudflareConnectionBlockedZones, cloudflareConnectionZones, cloudflareConnections,
	domains, hostedDomains, intakeTokens, invites, memberships, monitorSubscriptions, mtaStsConfig, reportRecords, settings,
	spfFlattenConfig, tlsReports, workspaces, type MembershipRole,
} from '../schema';

export interface WorkspaceSummary {
	id: string;
	name: string;
	role: MembershipRole;
	member_count: number;
	created_at: number;
}

export function workspaceLifecycle(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		/** Every workspace the user belongs to (oldest membership first) with their role and the member count. */
		listForUser: (userId: string): Promise<WorkspaceSummary[]> =>
			db
				.select({
					id: workspaces.id,
					name: workspaces.name,
					role: memberships.role,
					member_count: sql<number>`(SELECT COUNT(*) FROM memberships m2 WHERE m2.workspace_id = ${workspaces.id})`,
					created_at: workspaces.created_at,
				})
				.from(memberships)
				.innerJoin(workspaces, eq(workspaces.id, memberships.workspace_id))
				.where(/* workspace-scope-exempt: listing a user's own workspaces is the point of this lookup */ eq(memberships.user_id, userId))
				.orderBy(memberships.created_at, sql`${memberships}.rowid`)
				.all(),

		/** The user's role in a workspace, or null when they are not a member (or it does not exist). */
		roleOf: (userId: string, workspaceId: string) =>
			db
				.select({ role: memberships.role })
				.from(memberships)
				.where(and(eq(memberships.workspace_id, workspaceId), eq(memberships.user_id, userId)))
				.get()
				.then((r) => r?.role ?? null),

		get: (workspaceId: string) =>
			db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get().then((r) => r ?? null),

		rename: (workspaceId: string, name: string) => db.update(workspaces).set({ name }).where(eq(workspaces.id, workspaceId)).run(),

		/** Create a workspace and its first owner in one batch. */
		create: (id: string, name: string, ownerId: string) =>
			db.batch([
				db.insert(workspaces).values({ id, name }),
				db.insert(memberships).values({ workspace_id: id, user_id: ownerId, role: 'owner' }),
			]),

		/**
		 * Leave a workspace unless that would orphan it: one statement, so two owners leaving at once
		 * cannot both succeed. Returns whether the membership was removed.
		 */
		async leave(userId: string, workspaceId: string): Promise<boolean> {
			const res = await db.run(sql`DELETE FROM memberships
				WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
				AND (role <> 'owner' OR EXISTS (SELECT 1 FROM memberships o WHERE o.workspace_id = ${workspaceId} AND o.role = 'owner' AND o.user_id <> ${userId}))`);
			return ((res as any).meta?.changes ?? (res as any).changes ?? 0) > 0;
		},

		/** Delete a workspace and everything it owns (domains cascade to their reports and per-domain config). */
		purge: (workspaceId: string) =>
			db.batch([
				db.delete(reportRecords).where(eq(reportRecords.workspace_id, workspaceId)),
				db.delete(aggregateReports).where(eq(aggregateReports.workspace_id, workspaceId)),
				db.delete(tlsReports).where(eq(tlsReports.workspace_id, workspaceId)),
				db.delete(spfFlattenConfig).where(eq(spfFlattenConfig.workspace_id, workspaceId)),
				db.delete(mtaStsConfig).where(eq(mtaStsConfig.workspace_id, workspaceId)),
				db.delete(hostedDomains).where(eq(hostedDomains.workspace_id, workspaceId)),
				db.delete(intakeTokens).where(eq(intakeTokens.workspace_id, workspaceId)),
				db.delete(domains).where(eq(domains.workspace_id, workspaceId)),
				db.delete(cloudflareConnectionBlockedZones).where(eq(cloudflareConnectionBlockedZones.workspace_id, workspaceId)),
				db.delete(cloudflareConnectionZones).where(eq(cloudflareConnectionZones.workspace_id, workspaceId)),
				db.delete(cloudflareConnections).where(eq(cloudflareConnections.workspace_id, workspaceId)),
				db.delete(monitorSubscriptions).where(eq(monitorSubscriptions.workspace_id, workspaceId)),
				db.delete(settings).where(eq(settings.workspace_id, workspaceId)),
				db.delete(invites).where(eq(invites.workspace_id, workspaceId)),
				db.delete(auditLog).where(eq(auditLog.workspace_id, workspaceId)),
				db.delete(apiKeys).where(eq(apiKeys.workspace_id, workspaceId)),
				db.delete(memberships).where(eq(memberships.workspace_id, workspaceId)),
				db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
			]),

		/** Self-host: the workspace whose reports domain an inbound address belongs to. */
		byReportsDomain: (reportsDomain: string) =>
			db
				.select({ workspace_id: settings.workspace_id })
				.from(settings)
				.where(/* workspace-scope-exempt: routing inbound mail to the workspace that owns the reports domain */ and(eq(settings.key, 'reports_domain'), eq(settings.value, reportsDomain)))
				.limit(1)
				.get()
				.then((r) => r?.workspace_id ?? null),

		/** Self-host: the workspace that monitors a hostname. */
		byDomain: (domain: string) =>
			db
				.select({ workspace_id: domains.workspace_id })
				.from(domains)
				.where(/* workspace-scope-exempt: a hostname is globally unique and identifies its workspace */ eq(domains.domain, domain))
				.get()
				.then((r) => r?.workspace_id ?? null),
	};
}
