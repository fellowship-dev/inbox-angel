import type { AccessSubject } from './principal';
import type { AccessAction, AccessResource } from './grant';
export type { AccessAction, AccessResource } from './grant';
export class AccessDenied extends Error { readonly status = 403; constructor() { super('resource or capability not authorized'); } }
export function canAccess(subject: AccessSubject, action: AccessAction, resource: AccessResource, now = Math.floor(Date.now() / 1000)): boolean {
  if (subject.disabledAt != null) return false;
  const membership = subject.memberships?.find(m => m.workspaceId === resource.workspaceId);
  if (subject.kind === 'human') {
    if (!membership) return false;
    if (action === 'access:manage') return subject.session === true && membership.role === 'owner';
    if (membership.role === 'member' && action === 'domains:manage') return false;
    if (subject.session) return true;
  } else if (resource.workspaceId !== subject.workspaceId || action === 'access:manage') return false;
  return subject.grants.some(g => g.revokedAt == null && g.expiresAt > now && g.workspaceId === resource.workspaceId && g.productId === resource.productId && g.domain === resource.domain && g.actions.includes(action));
}
export function assertAccess(subject: AccessSubject, action: AccessAction, resource: AccessResource, now?: number): void {
  if (!canAccess(subject, action, resource, now)) throw new AccessDenied();
}
