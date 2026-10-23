import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/api/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', workspaceId: 'ws_default', role: 'owner', kind: 'instance', user: null }),
  AuthError: class AuthError extends Error {
    constructor(msg: string, public status = 401) { super(msg); this.name = 'AuthError'; }
  },
}));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { getMode } from '../../src/tenancy/mode';
import { defaultResolver, resolveDomainOwner, resolveInboundWorkspace, selfHostResolver, type WorkspaceResolver } from '../../src/tenancy/resolver';
import { DEFAULT_WORKER_NAME, workerName } from '../../src/tenancy/context';
import { sessionWorkspaceResolver } from '../../src/auth/resolver';
import { handleApi } from '../../src/api/router';
import { makeTenant } from '../helpers/tenant';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
afterEach(() => vi.unstubAllGlobals());

describe('getMode', () => {
  it('defaults to selfhost', () => {
    expect(getMode({})).toBe('selfhost');
    expect(getMode({ MODE: '' })).toBe('selfhost');
    expect(getMode({ MODE: 'something-else' })).toBe('selfhost');
  });
  it('reads MODE=saas (case-insensitive) and MODE=selfhost', () => {
    expect(getMode({ MODE: 'saas' })).toBe('saas');
    expect(getMode({ MODE: ' SaaS ' })).toBe('saas');
    expect(getMode({ MODE: 'selfhost' })).toBe('selfhost');
  });
  it('is carried by the tenant context', () => {
    expect(makeTenant({}).mode).toBe('selfhost');
    expect(makeTenant({ mode: 'saas' }).mode).toBe('saas');
  });
});

describe('self-host workspace resolution', () => {
  it('every request, inbound email and hostname belongs to the one implicit workspace', async () => {
    const req = new Request('https://x.test/api/domains');
    expect(await selfHostResolver(req, {} as any)).toEqual({ workspaceId: 'ws_default' });
    expect(await resolveInboundWorkspace({} as any, 'rua@reports.acme.com')).toBe('ws_default');
    expect(await resolveDomainOwner({} as any, 'acme.com')).toBe('ws_default');
  });
});

describe('the default resolver is session-based', () => {
  it('defaultResolver is the session / API-key resolver, not an implicit workspace', () => {
    expect(defaultResolver({} as any)).toBe(sessionWorkspaceResolver);
  });
});

describe('the WorkspaceResolver seam', () => {
  const env = () => ({ DB: createMigratedD1() as unknown as D1Database, API_KEY: 'k' }) as any;
  const get = () => new Request('https://x.test/api/domains', { headers: { 'x-api-key': 'k' } });

  it('answers 401 when the resolver finds no workspace, without touching tenant data', async () => {
    const none: WorkspaceResolver = async () => null;
    const res = await handleApi(get(), env(), ctx, none);
    expect(res.status).toBe(401);
  });

  it('/health needs no workspace', async () => {
    const none: WorkspaceResolver = async () => null;
    expect((await handleApi(new Request('https://x.test/health'), env(), ctx, none)).status).toBe(200);
  });

  it('passes the request and env to the resolver', async () => {
    const seen = vi.fn(async () => ({ workspaceId: 'ws_default', userId: 'u1', role: 'admin' }));
    const e = env();
    await handleApi(get(), e, ctx, seen);
    expect(seen).toHaveBeenCalledWith(expect.any(Request), e);
  });
});

describe('WORKER_NAME', () => {
  it('keeps inbox-angel-worker as the default script name', () => {
    expect(DEFAULT_WORKER_NAME).toBe('inbox-angel-worker');
    expect(workerName({})).toBe('inbox-angel-worker');
    expect(workerName({ WORKER_NAME: '' })).toBe('inbox-angel-worker');
    expect(workerName({ WORKER_NAME: 'custom' })).toBe('custom');
    expect(makeTenant({ env: { WORKER_NAME: 'mine' } }).workerName).toBe('mine');
  });
});
