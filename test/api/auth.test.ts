import { describe, it, expect } from 'vitest';
import { requireAuth, AuthError } from '../../src/api/auth';
import type { AuthEnv } from '../../src/api/auth';

const ENV: AuthEnv = { API_KEY: 'test-key-org_abc123' };

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://api.inboxangel.com/api/domains', { headers });
}

describe('requireAuth', () => {
  it('rejects the retired instance API_KEY even when it matches the configuration', async () => {
    const req = makeRequest({ 'x-api-key': 'test-key-org_abc123' });
    await expect(requireAuth(req, ENV)).rejects.toMatchObject({ status: 401 });
  });

  it('throws AuthError when x-api-key is missing', async () => {
    const req = makeRequest();
    await expect(requireAuth(req, ENV)).rejects.toThrow(AuthError);
  });

  it('throws AuthError when x-api-key does not match', async () => {
    const req = makeRequest({ 'x-api-key': 'wrong-key' });
    await expect(requireAuth(req, ENV)).rejects.toThrow(AuthError);
  });

  it('throws AuthError when API_KEY is not configured in env', async () => {
    const env: AuthEnv = {}; // no API_KEY
    const req = makeRequest({ 'x-api-key': 'any-key' });
    await expect(requireAuth(req, env)).rejects.toThrow(AuthError);
  });

  it('AuthError has status 401', async () => {
    const req = makeRequest();
    try {
      await requireAuth(req, ENV);
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
    }
  });
});

describe('AuthError', () => {
  it('has name AuthError', () => {
    expect(new AuthError('msg').name).toBe('AuthError');
  });

  it('defaults to status 401', () => {
    expect(new AuthError('msg').status).toBe(401);
  });

  it('accepts status 403', () => {
    expect(new AuthError('msg', 403).status).toBe(403);
  });
});
