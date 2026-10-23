// Shared setup: a saas D1 with two workspaces (A has two domains), a fake Cloudflare, and the mock OAuth server.
import { vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, inviteAndAccept, makeEnv } from '../auth/helpers';
import { FakeCloudflare } from '../helpers/cf-fake';
import { seedSettings } from '../helpers/tenant';
import { AUTH, MockAuthServer } from './mock-oauth';

export const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

export async function world(extraEnv: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1', TOKEN_ENCRYPTION_KEY: `k1:${KEY}`, SEND_EMAIL: { send }, ...AUTH, ...extraEnv }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];

  const signup = async (email: string) => {
    const r = await call(env, 'POST', '/api/auth/signup', { body: { name: email, email, password: 'password-123' } });
    if (r.status !== 201) throw new Error(`signup ${r.status} ${await r.text()}`);
    const { token } = await r.json() as { token: string };
    const ws = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].workspace_id as string;
    return { token, ws, email };
  };
  const A = await signup('a@example.com');
  const B = await signup('b@example.com');
  const member = await inviteAndAccept(env, A.token, 'member@example.com', 'member');
  const admin = await inviteAndAccept(env, A.token, 'admin@example.com', 'admin');

  const insert = db.sqlite.prepare('INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (?, ?, ?, ?)');
  insert.run(1, A.ws, 'a-corp.com', 'rua@x');
  insert.run(2, A.ws, 'a-two.org', 'rua@x');
  insert.run(3, B.ws, 'b-corp.org', 'rua@x');
  seedSettings(db, { from_email: 'noreply@reports.a-corp.com' }, A.ws);

  const cf = new FakeCloudflare({
    'a-corp.com': { id: Z.a1, cfAccountId: 'cf-1' },
    'a-two.org': { id: Z.a2, cfAccountId: 'cf-1' },
    'b-corp.org': { id: Z.b, cfAccountId: 'cf-1' },
  });
  cf.accounts = [{ id: 'cf-1', name: 'Fellowship' }];
  cf.validTokens = new Set();
  const auth = new MockAuthServer();
  auth.onIssue = access => cf.validTokens!.add(access);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => (await auth.handle(input, init)) ?? cf.fetch(input, init));

  const api = (token: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    call(env, method, path, { key: token, body, headers });

  /** Paste a token as a connection. */
  const addToken = async (token: string, secret: string, label?: string) => {
    cf.validTokens!.add(secret);
    const r = await api(token, 'POST', '/api/cloudflare/connections', { token: secret, label });
    if (r.status !== 201) throw new Error(`addToken ${r.status} ${await r.text()}`);
    return ((await r.json()) as any).connection as { id: string };
  };

  /** Run the whole OAuth dance as `token`'s user. */
  const connectOAuth = async (token: string, opts: { label?: string; connectionId?: string; approve?: boolean; returnTo?: string; defer?: boolean } = {}) => {
    const start = await api(token, 'POST', '/api/cloudflare/oauth/start', { label: opts.label, connection_id: opts.connectionId, return_to: opts.returnTo ?? '/settings/cloudflare' });
    if (start.status !== 200) throw new Error(`start ${start.status} ${await start.text()}`);
    const { authorize_url } = await start.json() as { authorize_url: string };
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const back = new URL(auth.authorize(authorize_url, { approve: opts.approve }));
    const callback = (state?: string, c = cookie) => {
      const u = new URL(back);
      if (state !== undefined) u.searchParams.set('state', state);
      return api(token, 'GET', u.pathname + u.search, undefined, c ? { cookie: c } : {});
    };
    return { authorizeUrl: authorize_url, cookie, back, callback, res: opts.defer ? (undefined as unknown as Response) : await callback() };
  };

  const connectionId = (res: Response) => new URL(res.headers.get('location')!, 'https://x').searchParams.get('cf_connection')!;
  const dmarc = (token: string, id: number, record = 'v=DMARC1; p=none') => api(token, 'POST', `/api/domains/${id}/apply-dmarc`, { record });

  return { db, env, rows, send, cf, auth, A, B, member, admin, api, addToken, connectOAuth, connectionId, dmarc };
}

export type World = Awaited<ReturnType<typeof world>>;

/** Zone ids as Cloudflare issues them: 32 hex characters. */
export const Z = {
  a1: 'a1'.repeat(16),
  a2: 'a2'.repeat(16),
  b: 'b0'.repeat(16),
} as const;
