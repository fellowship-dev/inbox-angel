import { accessLookups, authLookups, forWorkspace } from '@inbox-angel/db';
import type { AccessSubject } from './principal';
import { assertAccess, canAccess } from './policy';
import { validActions, type AccessAction, type AccessResource, type AccessGrant } from './grant';

export async function resolveAccessSubject(db: D1Database, principalId: string): Promise<AccessSubject | null> {
 const lookups = accessLookups(db);
 const p = await lookups.principalById(principalId);
 if (!p || p.disabled_at !== null || (p.kind === 'human' && !p.user_id)) return null;
 const grants: AccessGrant[] = [];
 for (const g of await lookups.grantsForPrincipal(principalId)) {
  let actions: unknown; try { actions = JSON.parse(g.actions); } catch { continue; }
  if (!validActions(actions)) continue;
  // A product may be archived after consent; its grants must stop too.
  if (g.product_id && !await forWorkspace(db, g.workspace_id).access.products.get(g.product_id)) continue;
  grants.push({ id: g.id, workspaceId: g.workspace_id, productId: g.product_id ?? undefined, domain: g.domain ?? undefined, actions, expiresAt: g.expires_at, revokedAt: g.revoked_at });
 }
 return { principalId: p.id, kind: p.kind, workspaceId: p.workspace_id, userId: p.user_id ?? undefined, disabledAt: p.disabled_at, grants, memberships: p.user_id ? (await authLookups(db).membershipsOf(p.user_id)).map(m => ({ workspaceId: m.workspace_id, role: m.role })) : undefined };
}
async function currentSubject(db: D1Database, subject: AccessSubject): Promise<AccessSubject | null> {
 if (subject.credentialId) {
  const credential = await accessLookups(db).credentialById(subject.credentialId);
  if (!credential || credential.principal_id !== subject.principalId || credential.revoked_at !== null || credential.expires_at <= Math.floor(Date.now() / 1000)) return null;
 }
 if (subject.session && subject.userId) return { ...subject, memberships: (await authLookups(db).membershipsOf(subject.userId)).map(m => ({ workspaceId: m.workspace_id, role: m.role })) };
 return resolveAccessSubject(db, subject.principalId);
}
/** Fresh read on every authorization; no cached role/grant survives revocation. */
export async function authorizeResource(db: D1Database, subject: AccessSubject, action: AccessAction, resource: AccessResource): Promise<void> {
 const current = await currentSubject(db, subject);
 if (!current) { assertAccess({ ...subject, disabledAt: 0 }, action, resource); return; }
 assertAccess(current, action, resource);
 if (resource.productId && resource.domain && action !== 'domains:manage') {
  const mappings = await forWorkspace(db, resource.workspaceId).access.products.mappings(resource.productId);
  if (!mappings.some(m => m.domain === resource.domain)) assertAccess({ ...current, disabledAt: 0 }, action, resource);
 }
}
/** Domain telemetry cannot identify a product's share, even with a product selector. */
export async function authorizedDomains(db: D1Database, subject: AccessSubject, selector: { workspaceId: string; productId?: string }, action: AccessAction = 'resources:read') {
 const current = await currentSubject(db, subject);
 if (!current) return [];
 const scope = forWorkspace(db, selector.workspaceId);
 const eligible = current.grants.filter(g => g.domain && canAccess(current, action, { ...selector, domain: g.domain }));
 if (!current.session && eligible.length === 0) return [];
 const mapped = selector.productId ? await scope.access.products.mappings(selector.productId) : null;
 const rows = current.session ? await scope.domains.list() : (await Promise.all([...new Set(eligible.map(g => g.domain!))].map(domain => scope.domains.getByName(domain)))).filter((d): d is NonNullable<typeof d> => d !== null);
 const result = [];
 for (const domain of rows) {
  if (mapped && !mapped.some(m => m.domain_id === domain.id)) continue;
  const resource = { ...selector, domain: domain.domain };
  if (!canAccess(current, action, resource)) continue;
  const products = await scope.access.products.domainProducts(domain.id);
  const mappedProductIds = products.filter(p =>
   canAccess(current, 'resources:read', { workspaceId: selector.workspaceId, productId: p.product_id, domain: domain.domain }) ||
   canAccess(current, 'resources:read', { workspaceId: selector.workspaceId, productId: p.product_id })
  ).map(p => p.product_id);
  result.push({ ...domain, productId: selector.productId, coverage: 'shared-domain' as const, mappedProductIds });
 }
 return result;
}
