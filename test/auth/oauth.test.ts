import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../src/index';

vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    enrichEnv: vi.fn().mockResolvedValue(undefined),
    getZoneId: vi.fn().mockReturnValue(undefined),
    getAccountId: vi.fn().mockReturnValue(undefined),
    getBaseDomain: vi.fn().mockReturnValue(undefined),
    reportsDomain: vi.fn().mockReturnValue('reports.example.com'),
    fromEmail: vi.fn().mockReturnValue('noreply@reports.example.com'),
  };
});
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, setupOwner, inviteAndAccept } from './helpers';
import { assertMaySignUp, provisionUser } from '../../src/auth/signup-policy';
import { enabledOAuthProviders } from '../../src/auth/config';

const GITHUB = { GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' };
const GOOGLE = { GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' };
const rows = (db: ReturnType<typeof createMigratedD1>, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];

const social = (env: Env, provider: string) =>
  call(env, 'POST', '/api/auth/sign-in/social', { body: { provider, callbackURL: '/' }, headers: { origin: 'https://ia.example.com' } });

describe('OAuth providers are on only when configured', () => {
  it('none by default', async () => {
    const env = makeEnv();
    expect(enabledOAuthProviders(env as any)).toEqual([]);
    expect(((await (await call(env, 'GET', '/api/auth/status')).json()) as any).oauth_providers).toEqual([]);
    const res = await social(env, 'github');
    expect(res.ok).toBe(false);
  });

  it('a provider needs both id and secret', async () => {
    expect(enabledOAuthProviders({ GITHUB_CLIENT_ID: 'x' } as any)).toEqual([]);
    expect(enabledOAuthProviders({ GITHUB_CLIENT_SECRET: 'x' } as any)).toEqual([]);
    expect(enabledOAuthProviders({ ...GITHUB, ...GOOGLE } as any)).toEqual(['github', 'google']);
  });

  it('GitHub only: status lists it and sign-in returns the GitHub authorize URL; Google stays off', async () => {
    const env = makeEnv(createMigratedD1(), GITHUB);
    expect(((await (await call(env, 'GET', '/api/auth/status')).json()) as any).oauth_providers).toEqual(['github']);
    const res = await social(env, 'github');
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(body.url).toContain('client_id=gh-id');
    expect(decodeURIComponent(body.url)).toContain('redirect_uri=https://ia.example.com/api/auth/callback/github');
    expect((await social(env, 'google')).ok).toBe(false);
  });

  it('Google when configured', async () => {
    const env = makeEnv(createMigratedD1(), GOOGLE);
    expect(((await (await call(env, 'GET', '/api/auth/status')).json()) as any).oauth_providers).toEqual(['google']);
    const body = await (await social(env, 'google')).json() as { url: string };
    expect(body.url).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it('the status response never exposes secrets', async () => {
    const env = makeEnv(createMigratedD1(), { ...GITHUB, ...GOOGLE });
    const text = await (await call(env, 'GET', '/api/auth/status')).text();
    expect(text).not.toContain('gh-secret');
    expect(text).not.toContain('g-secret');
  });
});

describe('sign-up policy for OAuth (external) sign-ups', () => {
  const user = (id: string, email: string) => ({ id, email, name: email });
  const insertUser = (db: ReturnType<typeof createMigratedD1>, id: string, email: string) =>
    db.sqlite.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').run(id, email, email);

  it('self-host: first user is allowed and becomes owner', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    await assertMaySignUp(env as any, { kind: 'external' }, 'first@example.com');
    insertUser(db, 'u1', 'first@example.com');
    expect(await provisionUser(env as any, { kind: 'external' }, user('u1', 'first@example.com'))).toEqual({ workspaceId: 'ws_default', role: 'owner' });
  });

  it('self-host: closed to strangers once an owner exists, open to invited emails', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    await expect(assertMaySignUp(env as any, { kind: 'external' }, 'stranger@example.com')).rejects.toThrow(/closed/);

    await call(env, 'POST', '/api/team/invite', { key: owner, body: { email: 'friend@example.com', role: 'admin' } });
    await assertMaySignUp(env as any, { kind: 'external' }, 'friend@example.com');
    insertUser(db, 'u9', 'friend@example.com');
    expect(await provisionUser(env as any, { kind: 'external' }, user('u9', 'friend@example.com'))).toEqual({ workspaceId: 'ws_default', role: 'admin' });
    expect(rows(db, 'SELECT used_at FROM invites')[0].used_at).not.toBeNull();
  });

  it('saas: anyone may sign up and gets their own workspace', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
    await assertMaySignUp(env as any, { kind: 'external' }, 'anyone@example.com');
    insertUser(db, 'u1', 'anyone@example.com');
    const placed = await provisionUser(env as any, { kind: 'external' }, user('u1', 'anyone@example.com'));
    expect(placed.role).toBe('owner');
    expect(placed.workspaceId).not.toBe('ws_default');
  });

  it('a password sign-up cannot claim someone else’s invite by email alone', async () => {
    const env = makeEnv();
    const owner = await setupOwner(env);
    await inviteAndAccept(env, owner, 'ok@example.com', 'member');
    // The setup/signup intents never match invites: they are decided by owner / mode only.
    await expect(assertMaySignUp(env as any, { kind: 'setup' }, 'x@example.com')).rejects.toThrow(/configured/);
    await expect(assertMaySignUp(env as any, { kind: 'invite', token: 'nope' }, 'x@example.com')).rejects.toThrow(/invite/);
  });
});
