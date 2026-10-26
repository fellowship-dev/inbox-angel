import { and, eq, isNull } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { accessPrincipals, accessGrants, accessCredentials, products, productDomains, domains } from '../schema';

/** The only unscoped reads identify a credential/principal before selecting its workspace. */
export function accessLookups(dbLike: DbLike) {
 const db = getDb(dbLike);
 return {
  credentialById: (id: string) => db.select().from(accessCredentials).where(/* workspace-scope-exempt: rechecking the authenticated credential */ eq(accessCredentials.id, id)).get(),
  credentialByHash: (hash: string) => db.select().from(accessCredentials).where(/* workspace-scope-exempt: credential hash identifies its workspace */ eq(accessCredentials.key_hash, hash)).get(),
  principalById: (id: string) => db.select().from(accessPrincipals).where(/* workspace-scope-exempt: resolving an authenticated principal identity */ eq(accessPrincipals.id, id)).get(),
  humanPrincipalsForUser: (userId: string) => db.select().from(accessPrincipals).where(/* workspace-scope-exempt: own-user connection management survives membership removal */ and(eq(accessPrincipals.user_id, userId), eq(accessPrincipals.kind, 'human'))).all(),
  grantsForPrincipal: (id: string) => db.select().from(accessGrants).where(/* workspace-scope-exempt: finite portfolio consent enumerates workspaces */ eq(accessGrants.principal_id, id)).all(),
 };
}
export function accessQueries(dbLike: DbLike, workspaceId: string) {
 const db = getDb(dbLike);
 const principalWhere = (id: string) => and(eq(accessPrincipals.workspace_id, workspaceId), eq(accessPrincipals.id, id));
 return {
  products: {
   list: () => db.select().from(products).where(and(eq(products.workspace_id, workspaceId), isNull(products.archived_at))).all(),
   get: (id: string) => db.select().from(products).where(and(eq(products.workspace_id, workspaceId), eq(products.id, id), isNull(products.archived_at))).get(),
   create: (p: { id: string; name: string }) => db.insert(products).values({ ...p, workspace_id: workspaceId }).run(),
   rename: (id: string, name: string) => db.update(products).set({ name }).where(and(eq(products.workspace_id, workspaceId), eq(products.id, id))).run(),
   archive: (id: string, now: number) => db.update(products).set({ archived_at: now }).where(and(eq(products.workspace_id, workspaceId), eq(products.id, id))).run(),
   mappings: (productId: string) => db.select({ domain_id: domains.id, domain: domains.domain }).from(productDomains).innerJoin(domains, and(eq(domains.id, productDomains.domain_id), eq(domains.workspace_id, workspaceId))).where(and(eq(productDomains.workspace_id, workspaceId), eq(productDomains.product_id, productId))).all(),
   map: (productId: string, domainId: number) => db.insert(productDomains).values({ workspace_id: workspaceId, product_id: productId, domain_id: domainId }).onConflictDoNothing().run(),
   unmap: (productId: string, domainId: number) => db.delete(productDomains).where(and(eq(productDomains.workspace_id, workspaceId), eq(productDomains.product_id, productId), eq(productDomains.domain_id, domainId))).run(),
   domainProducts: (domainId: number) => db.select({ product_id: productDomains.product_id }).from(productDomains).innerJoin(products, and(eq(products.id, productDomains.product_id), eq(products.workspace_id, workspaceId), isNull(products.archived_at))).where(and(eq(productDomains.workspace_id, workspaceId), eq(productDomains.domain_id, domainId))).all(),
  },
  principals: {
   create: (p: { id: string; name: string; kind: 'human' | 'service'; user_id?: string | null }) => db.insert(accessPrincipals).values({ ...p, workspace_id: workspaceId }).run(),
   get: (id: string) => db.select().from(accessPrincipals).where(principalWhere(id)).get(),
   list: () => db.select().from(accessPrincipals).where(eq(accessPrincipals.workspace_id, workspaceId)).all(),
   disable: (id: string, now: number) => db.update(accessPrincipals).set({ disabled_at: now }).where(principalWhere(id)).run(),
  },
  grants: {
   create: (g: typeof accessGrants.$inferInsert) => db.insert(accessGrants).values({ ...g, workspace_id: workspaceId }).run(),
   list: () => db.select().from(accessGrants).where(eq(accessGrants.workspace_id, workspaceId)).all(),
   revoke: (id: string, now: number) => db.update(accessGrants).set({ revoked_at: now }).where(and(eq(accessGrants.workspace_id, workspaceId), eq(accessGrants.id, id))).run(),
  },
  credentials: {
   create: (c: typeof accessCredentials.$inferInsert) => db.insert(accessCredentials).values({ ...c, workspace_id: workspaceId }).run(),
   list: async () => (await db.select().from(accessCredentials).where(eq(accessCredentials.workspace_id, workspaceId)).all()).map(({ key_hash: _, ...safe }) => safe),
   revoke: (id: string, now: number) => db.update(accessCredentials).set({ revoked_at: now }).where(and(eq(accessCredentials.workspace_id, workspaceId), eq(accessCredentials.id, id))).run(),
   touch: (id: string, now: number) => db.update(accessCredentials).set({ last_used_at: now }).where(and(eq(accessCredentials.workspace_id, workspaceId), eq(accessCredentials.id, id))).run(),
  },
 };
}
