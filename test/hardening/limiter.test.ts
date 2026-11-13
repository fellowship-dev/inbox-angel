// Item 8: a hosted instance without the DNS_PREVIEW_LIMITER binding says so: one warning per isolate, one fact for the owner.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, setupOwner } from '../auth/helpers';
import { __resetPreviewCacheForTests, claimPreviewResponse } from '../../src/domains/claim-preview';
import { makeTenant } from '../helpers/tenant';
import { dohFetch } from '../../packages/dns-checks/test/helpers';
import { hosted, json } from './helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const MESSAGE = '[claim-preview] DNS_PREVIEW_LIMITER binding missing: falling back to a per-isolate counter; add the ratelimit binding for hosted mode.';

beforeEach(() => {
  __resetPreviewCacheForTests();
  vi.stubGlobal('fetch', dohFetch({}));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const claimFor = async (w: Awaited<ReturnType<typeof hosted>>, who: { token: string; ws: string; id: string }, domain: string) =>
  (await json(await w.api(who, 'POST', '/api/domains', { domain }))).claim.id as number;

describe('the missing-limiter warning', () => {
  it('fires once, on first use, however many previews follow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = await hosted();
    const a = await w.user('a@example.com');
    const ids = [await claimFor(w, a, 'one.org'), await claimFor(w, a, 'two.org'), await claimFor(w, a, 'three.org')];
    expect(warn.mock.calls.filter(c => c[0] === MESSAGE)).toHaveLength(0); // nothing yet: it is a first-use message
    for (const id of ids) expect((await w.api(a, 'GET', `/api/domains/claims/${id}/preview`)).status).toBe(200);
    expect(warn.mock.calls.filter(c => c[0] === MESSAGE)).toHaveLength(1);
  });

  it('does not fire when the binding is present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = await hosted({ DNS_PREVIEW_LIMITER: { limit: async () => ({ success: true }) } });
    const a = await w.user('a@example.com');
    const id = await claimFor(w, a, 'one.org');
    expect((await w.api(a, 'GET', `/api/domains/claims/${id}/preview`)).status).toBe(200);
    expect(warn.mock.calls.filter(c => c[0] === MESSAGE)).toHaveLength(0);
  });

  it('does not fire on a self-hosted instance', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tenant = makeTenant({ mode: 'selfhost' });
    const claim = { id: 1, domain: 'one.org', status: 'pending' } as never;
    expect((await claimPreviewResponse(tenant, claim, { userId: 'u' })).status).toBe(200);
    expect(warn.mock.calls.filter(c => c[0] === MESSAGE)).toHaveLength(0);
  });

  it('fires again after the isolate state is reset (the test hook), proving the once-flag is the guard', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tenant = makeTenant({ mode: 'saas', env: { MODE: 'saas' } as never });
    const claim = (domain: string) => ({ id: 1, domain, status: 'pending' }) as never;
    await claimPreviewResponse(tenant, claim('one.org'), { userId: 'u' });
    await claimPreviewResponse(tenant, claim('two.org'), { userId: 'u' });
    __resetPreviewCacheForTests();
    await claimPreviewResponse(tenant, claim('three.org'), { userId: 'u' });
    expect(warn.mock.calls.filter(c => c[0] === MESSAGE)).toHaveLength(2);
  });
});

describe('GET /api/me: dns_preview_limiter', () => {
  const OWNER = 'owner@example.com';
  it('the instance owner sees "fallback" without the binding and "binding" with it', async () => {
    const w = await hosted({ OWNER_EMAIL: OWNER });
    const owner = await w.user(OWNER);
    expect((await json(await w.api(owner, 'GET', '/api/me'))).dns_preview_limiter).toBe('fallback');
    const bound = await hosted({ OWNER_EMAIL: OWNER, DNS_PREVIEW_LIMITER: { limit: async () => ({ success: true }) } });
    const owner2 = await bound.user(OWNER);
    expect((await json(await bound.api(owner2, 'GET', '/api/me'))).dns_preview_limiter).toBe('binding');
  });

  it('nobody else sees the field', async () => {
    const w = await hosted({ OWNER_EMAIL: OWNER });
    const other = await w.user('someone@example.com');
    const me = await json(await w.api(other, 'GET', '/api/me'));
    expect(me.instance_owner).toBe(false);
    expect('dns_preview_limiter' in me).toBe(false);
  });

  it('a self-hosted owner does not get it (no hosted limiter to report on)', async () => {
    const env = makeEnv(createMigratedD1());
    const owner = await setupOwner(env);
    const me = await json(await call(env, 'GET', '/api/me', { key: owner }));
    expect(me.instance_owner).toBe(true);
    expect('dns_preview_limiter' in me).toBe(false);
  });
});
