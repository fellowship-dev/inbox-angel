import { describe, it, expect } from 'vitest';
import { mcpInstallation } from '../../src/mcp/discovery';
import { resolveMcpIdentity } from '../../src/auth/mcp-issuer';
import { connection } from './helpers';
describe('installation identity', () => {
 it('uses a configured canonical HTTPS origin', () => {
  expect(mcpInstallation({ BETTER_AUTH_URL: 'https://my-host.example' })).toEqual({ issuer: 'https://my-host.example', resource: 'https://my-host.example/mcp' });
  expect(() => mcpInstallation({})).toThrow();
  expect(() => mcpInstallation({ BETTER_AUTH_URL: 'http://my-host.example' })).toThrow();
  expect(() => mcpInstallation({ BETTER_AUTH_URL: 'https://my-host.example/path' })).toThrow();
  expect(() => mcpInstallation({ BETTER_AUTH_URL: 'https://my-host.example' }, 'https://attacker.example')).toThrow();
 });
 it('rejects another issuer/audience even with identical D1 IDs', async () => {
  const { env, props } = await connection();
  expect(await resolveMcpIdentity(env, props)).toMatchObject({ principalId: 'agent', kind: 'human' });
  expect(await resolveMcpIdentity(env, { ...props, issuer: 'https://other.example' })).toBeNull();
  expect(await resolveMcpIdentity(env, { ...props, resource: 'https://other.example/mcp' })).toBeNull();
 });
});
