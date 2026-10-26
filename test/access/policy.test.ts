import { describe, it, expect } from 'vitest';
import { canAccess } from '../../src/access/policy';
import type { AccessSubject } from '../../src/access/principal';

const actor: AccessSubject = { principalId: 'svc', kind: 'service', workspaceId: 'a', grants: [{ id: 'g', workspaceId: 'a', productId: 'p', domain: 'mail.example.com', actions: ['reports:read'], expiresAt: 200, revokedAt: null }] };
describe('explicit resource policy', () => {
 it('allows exact tuples and denies sibling, parent, product and workspace guesses', () => {
  expect(canAccess(actor, 'reports:read', { workspaceId: 'a', productId: 'p', domain: 'mail.example.com' }, 100)).toBe(true);
  for (const resource of [{ workspaceId: 'b', productId: 'p', domain: 'mail.example.com' }, { workspaceId: 'a', productId: 'q', domain: 'mail.example.com' }, { workspaceId: 'a', productId: 'p', domain: 'other.example.com' }, { workspaceId: 'a', productId: 'p', domain: 'example.com' }]) expect(canAccess(actor, 'reports:read', resource, 100)).toBe(false);
 });
 it('denies revocation, expiry and service credential minting', () => {
  expect(canAccess(actor, 'reports:read', { workspaceId: 'a', productId: 'p', domain: 'mail.example.com' }, 200)).toBe(false);
  expect(canAccess({ ...actor, disabledAt: 99 }, 'reports:read', { workspaceId: 'a', productId: 'p', domain: 'mail.example.com' }, 100)).toBe(false);
  expect(canAccess(actor, 'access:manage', { workspaceId: 'a' }, 100)).toBe(false);
 });
 it('intersects finite human portfolio consent with current membership and role', () => {
  const human: AccessSubject = { ...actor, kind: 'human', userId: 'u', memberships: [{ workspaceId: 'a', role: 'member' }, { workspaceId: 'later', role: 'owner' }] };
  expect(canAccess(human, 'reports:read', { workspaceId: 'a', productId: 'p', domain: 'mail.example.com' }, 100)).toBe(true);
  expect(canAccess(human, 'reports:read', { workspaceId: 'later', productId: 'p', domain: 'mail.example.com' }, 100)).toBe(false);
  expect(canAccess({ ...human, memberships: [] }, 'reports:read', { workspaceId: 'a', productId: 'p', domain: 'mail.example.com' }, 100)).toBe(false);
 });
});
