// A hosted (saas) D1 world with signed-up users, shared by the sign-up hardening tests.
import { vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';

export const json = async (r: Response) => await r.json() as any;
export const nxdomain = () => vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 }));

export async function hosted(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const user = async (email: string) => {
    const token = await signupVerified(env, email);
    const r = rows('SELECT m.workspace_id, m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0];
    db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'reports_domain', ?)").run(r.workspace_id, `reports.${email.split('@')[0]}.test`);
    return { token, ws: r.workspace_id as string, id: r.user_id as string };
  };
  const api = (who: { token: string }, method: string, path: string, body?: unknown) => call(env, method, path, { key: who.token, body });
  return { db, env, rows, user, api };
}

export const fillDomains = (db: ReturnType<typeof createMigratedD1>, ws: string, n: number, prefix = 'f') => {
  for (let i = 0; i < n; i++) db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES (?, 'x', ?, 'txt')").run(`${prefix}${i}.example.com`, ws);
};

/** DNS where `host` has the TXT `txt` and everything else does not exist. */
export const provenDns = (host: string, txt: string) => vi.stubGlobal('fetch', async (url: string) => {
  const name = new URL(url).searchParams.get('name');
  return new Response(JSON.stringify(name === host ? { Status: 0, Answer: [{ name, type: 16, TTL: 60, data: `"${txt}"` }] } : { Status: 3 }));
});
