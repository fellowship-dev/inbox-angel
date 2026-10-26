import { accessLookups, forWorkspace } from '@inbox-angel/db';
import type { AccessSubject } from './principal';
import { authorizeResource } from './resolve';
import { validActions, type AccessAction } from './grant';
import { AccessDenied } from './policy';
import { issueAccessCredential } from '../auth/api-keys';
import { normalizeDomain, organizationalDomain } from '@inbox-angel/dns-checks';

/** Owner operations never accept a delegated actor, even one holding the same action string. */
export class AccessService {
 constructor(readonly db: D1Database, readonly actor: AccessSubject) {}
 private async owner(workspaceId: string) { await authorizeResource(this.db, this.actor, 'access:manage', { workspaceId }); }
 async createProduct(workspaceId: string, name: string) {
  await this.owner(workspaceId); const id = crypto.randomUUID();
  await forWorkspace(this.db, workspaceId).access.products.create({ id, name: this.name(name) }); return { id, workspaceId, name };
 }
 async list(workspaceId: string) {
  await this.owner(workspaceId); const q = forWorkspace(this.db, workspaceId).access;
  const [products, principals, grants, credentials] = await Promise.all([q.products.list(), q.principals.list(), q.grants.list(), q.credentials.list()]);
  return { products, principals, grants, credentials };
 }
 async updateProduct(workspaceId: string, productId: string, update: { name?: string; archived?: boolean }) {
  await this.owner(workspaceId); const q = forWorkspace(this.db, workspaceId).access;
  if (!await q.products.get(productId)) throw new AccessDenied();
  if (update.name !== undefined) await q.products.rename(productId, this.name(update.name));
  if (update.archived) await q.products.archive(productId, Math.floor(Date.now() / 1000));
 }
 async mapDomain(workspaceId: string, productId: string, domainId: number, remove = false) {
  await this.owner(workspaceId); const scope = forWorkspace(this.db, workspaceId);
  if (!await scope.access.products.get(productId) || !await scope.domains.getById(domainId)) throw new AccessDenied();
  if (remove) await scope.access.products.unmap(productId, domainId); else await scope.access.products.map(productId, domainId);
 }
 async createPrincipal(workspaceId: string, name: string, kind: 'human' | 'service') {
  await this.owner(workspaceId);
  if (kind !== 'human' && kind !== 'service') throw new Error('kind must be human or service');
  const id = crypto.randomUUID();
  await forWorkspace(this.db, workspaceId).access.principals.create({ id, name: this.name(name), kind, user_id: kind === 'human' ? this.actor.userId : null });
  return { id, workspaceId, kind, name };
 }
 async grant(p: { workspaceId: string; principalId: string; productId?: string; domain?: string; actions: AccessAction[]; expiresAt: number }) {
  await this.owner(p.workspaceId);
  const principal = await accessLookups(this.db).principalById(p.principalId);
  if (!principal || principal.disabled_at !== null || (principal.kind === 'service' && principal.workspace_id !== p.workspaceId) || (principal.kind === 'human' && principal.user_id !== this.actor.userId)) throw new AccessDenied();
  if (!validActions(p.actions) || p.actions.includes('access:manage')) throw new Error('invalid delegated actions');
  this.expiry(p.expiresAt);
  const scope = forWorkspace(this.db, p.workspaceId);
  if (p.productId && !await scope.access.products.get(p.productId)) throw new AccessDenied();
  const domain = p.domain === undefined ? undefined : normalizeDomain(p.domain);
  if (p.domain !== undefined && (typeof p.domain !== 'string' || !domain || !organizationalDomain(domain))) throw new Error('invalid domain');
  if (!domain && p.actions.some(a => a !== 'resources:read')) throw new Error('domain capabilities require an exact hostname');
  if (!domain && !p.productId) throw new Error('grant must enumerate a product or exact domain');
  if (p.productId && domain) {
   const known = (await scope.domains.list()).find(d => d.domain === domain);
   if (known && !(await scope.access.products.mappings(p.productId)).some(m => m.domain_id === known.id)) throw new AccessDenied();
   // An exact new hostname may be preconsented for onboarding; no sibling/parent expansion.
   if (!known && p.actions.some(a => a !== 'domains:manage' && a !== 'resources:read' && a !== 'reports:read' && a !== 'metrics:read' && a !== 'diagnostics:run' && a !== 'remediation:plan')) throw new AccessDenied();
  }
  const id = crypto.randomUUID();
  await scope.access.grants.create({ id, workspace_id: p.workspaceId, principal_id: p.principalId, product_id: p.productId ?? null, domain: domain ?? null, actions: JSON.stringify(p.actions), expires_at: p.expiresAt });
  return { id, ...p, domain };
 }
 async issueCredential(workspaceId: string, principalId: string, name: string, expiresAt: number) {
  await this.owner(workspaceId); this.expiry(expiresAt);
  const principal = await forWorkspace(this.db, workspaceId).access.principals.get(principalId);
  if (!principal || (principal.kind === 'human' && principal.user_id !== this.actor.userId)) throw new AccessDenied();
  return issueAccessCredential(this.db, { workspaceId, principalId, name: this.name(name), expiresAt });
 }
 async revoke(workspaceId: string, type: 'grants' | 'credentials' | 'principals', id: string) {
  await this.owner(workspaceId); const q = forWorkspace(this.db, workspaceId).access, now = Math.floor(Date.now() / 1000);
  if (type === 'principals') await q.principals.disable(id, now); else await q[type].revoke(id, now);
 }
 private name(value: string) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('name required (max 80 characters)'); return value.trim(); }
 private expiry(value: number) { if (!Number.isSafeInteger(value) || value <= Math.floor(Date.now() / 1000)) throw new Error('expiry must be a future timestamp'); }
}
