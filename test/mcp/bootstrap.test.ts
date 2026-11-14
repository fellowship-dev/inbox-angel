import { describe, it, expect } from 'vitest';
import { makeEnv, call } from '../auth/helpers';
describe('installer bootstrap', () => {
 it('email knowledge does not grant ownership without installer proof', async () => {
  const env = makeEnv(undefined, { OWNER_EMAIL: 'owner@example.com', BOOTSTRAP_SECRET: 'installer-proof-with-at-least-32-characters' });
  const response = await call(env, 'POST', '/api/auth/setup', { body: { email: 'owner@example.com', password: 'owner-password' }, headers: { 'x-ready-set-mail-bootstrap': '' } });
  expect(response.status).toBe(403);
 });
 it('still accepts the proof in the header name used before the rename to Ready Set Mail', async () => {
  const env = makeEnv(undefined, { BOOTSTRAP_SECRET: 'installer-proof-with-at-least-32-characters' });
  const headers = { 'x-ready-set-mail-bootstrap': '', 'x-inbox-angel-bootstrap': 'installer-proof-with-at-least-32-characters' }; // @legacy-name
  const response = await call(env, 'POST', '/api/auth/setup', { body: { email: 'owner@example.com', password: 'owner-password' }, headers });
  expect(response.status).toBe(201);
 });
 it('fails closed when operator did not provision proof', async () => {
  const env = makeEnv(undefined, { BOOTSTRAP_SECRET: undefined });
  const response = await call(env, 'POST', '/api/auth/setup', { body: { email: 'owner@example.com', password: 'owner-password' } });
  expect(response.status).toBe(403);
 });
});
