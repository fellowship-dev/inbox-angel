import { describe, it, expect } from 'vitest';
import { makeEnv, call } from '../auth/helpers';
describe('installer bootstrap', () => {
 it('email knowledge does not grant ownership without installer proof', async () => {
  const env = makeEnv(undefined, { OWNER_EMAIL: 'owner@example.com', BOOTSTRAP_SECRET: 'installer-proof-with-at-least-32-characters' });
  const response = await call(env, 'POST', '/api/auth/setup', { body: { email: 'owner@example.com', password: 'owner-password' }, headers: { 'x-inbox-angel-bootstrap': '' } });
  expect(response.status).toBe(403);
 });
 it('fails closed when operator did not provision proof', async () => {
  const env = makeEnv(undefined, { BOOTSTRAP_SECRET: undefined });
  const response = await call(env, 'POST', '/api/auth/setup', { body: { email: 'owner@example.com', password: 'owner-password' } });
  expect(response.status).toBe(403);
 });
});
