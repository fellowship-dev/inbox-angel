// Reports-domain ownership, delete preflight, and single-use invites under concurrency.
import { describe, it, expect, vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { call, makeEnv, setupOwner, inviteAndAccept } from '../auth/helpers';
import { workspaceLifecycle } from '@inbox-angel/db';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const rows = (db: any, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
const json = async (res: Response) => (await res.json()) as any;
const ws = (id: string) => ({ 'x-workspace-id': id });

async function world(extra: Record<string, unknown> = {}) {
	const db = createMigratedD1();
	const env = makeEnv(db, extra);
	const owner = await setupOwner(env);
	const b = (await json(await call(env, 'POST', '/api/workspaces', { key: owner, body: { name: 'B' } }))).id as string;
	return { db, env, owner, b };
}

describe('reports domain and hostname belong to one workspace', () => {
	it('B cannot claim A’s base domain: refused before anything is written, A untouched', async () => {
		const { db, env, owner, b } = await world();
		expect((await call(env, 'POST', '/api/settings/base-domain', { key: owner, body: { domain: 'a.com' } })).status).toBe(201);
		const before = rows(db, "SELECT workspace_id, key, value FROM settings WHERE key IN ('base_domain','reports_domain','from_email') ORDER BY 1,2");
		const res = await call(env, 'POST', '/api/settings/base-domain', { key: owner, headers: ws(b), body: { domain: 'a.com' } });
		expect(res.status).toBe(409);
		expect(rows(db, "SELECT workspace_id, key, value FROM settings WHERE key IN ('base_domain','reports_domain','from_email') ORDER BY 1,2")).toEqual(before);
		expect(rows(db, 'SELECT COUNT(*) n FROM domains WHERE workspace_id = ?', b)).toEqual([{ n: 0 }]);
		expect(await workspaceLifecycle(db as any).byReportsDomain('reports.a.com')).toBe('ws_default');
	});

	it('a reports domain another workspace holds is refused even if the hostname is free', async () => {
		const { db, env, owner, b } = await world();
		// A holds reports.a.com without owning the hostname a.com (e.g. the hostname was removed later)
		await call(env, 'POST', '/api/settings/base-domain', { key: owner, body: { domain: 'a.com' } });
		db.sqlite.prepare("DELETE FROM domains WHERE domain = 'a.com'").run();
		const res = await call(env, 'POST', '/api/settings/base-domain', { key: owner, headers: ws(b), body: { domain: 'a.com' } });
		expect(res.status).toBe(409);
		expect(rows(db, "SELECT COUNT(*) n FROM settings WHERE workspace_id = ? AND key = 'reports_domain'", b)).toEqual([{ n: 0 }]);
	});

	it('the database refuses a second workspace’s reports_domain even if the API check were raced', async () => {
		const { db, env, owner, b } = await world();
		await call(env, 'POST', '/api/settings/base-domain', { key: owner, body: { domain: 'a.com' } });
		expect(() => db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'reports_domain', 'reports.a.com')").run(b)).toThrow(/UNIQUE/);
		// cleared values (empty) may repeat
		db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'reports_domain', '')").run(b);
		db.sqlite.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_c', 'C')").run();
		db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_c', 'reports_domain', '')").run();
	});

	it('a failed claim leaves no half-written state in the claimant’s own workspace either', async () => {
		const { db, env, owner, b } = await world();
		await call(env, 'POST', '/api/settings/base-domain', { key: owner, headers: ws(b), body: { domain: 'b.com' } });
		const before = rows(db, 'SELECT workspace_id, key, value FROM settings WHERE workspace_id = ? ORDER BY key', b);
		expect((await call(env, 'POST', '/api/settings/base-domain', { key: owner, headers: ws(b), body: { domain: 'a.com' } })).status).toBe(201); // free: fine
		// now B tries to take a domain A holds: B keeps its previous settings
		await call(env, 'POST', '/api/settings/base-domain', { key: owner, body: { domain: 'taken.com' } });
		const mid = rows(db, 'SELECT workspace_id, key, value FROM settings WHERE workspace_id = ? ORDER BY key', b);
		expect((await call(env, 'POST', '/api/settings/base-domain', { key: owner, headers: ws(b), body: { domain: 'taken.com' } })).status).toBe(409);
		expect(rows(db, 'SELECT workspace_id, key, value FROM settings WHERE workspace_id = ? ORDER BY key', b)).toEqual(mid);
		expect(before.length).toBeGreaterThan(0);
	});

	it('inbound mail goes to the workspace that owns the reports domain, deterministically', async () => {
		const { db, env, owner, b } = await world();
		await call(env, 'POST', '/api/settings/base-domain', { key: owner, headers: ws(b), body: { domain: 'b.com' } });
		await call(env, 'POST', '/api/settings/base-domain', { key: owner, body: { domain: 'a.com' } });
		const { resolveInboundWorkspace } = await import('../../src/tenancy/resolver');
		expect(await resolveInboundWorkspace(env, 'rua@reports.b.com')).toBe(b);
		expect(await resolveInboundWorkspace(env, 'rua@reports.a.com')).toBe('ws_default');
		expect(await resolveInboundWorkspace(env, 'rua@unknown.example')).toBe('ws_default');
		expect(db).toBeTruthy();
	});
});

describe('deleting a workspace with domains', () => {
	async function withDomains(extra: Record<string, unknown> = {}) {
		const w = await world(extra);
		// B owns a connection-linked setup: two domains, each in a zone Cloudflare knows
		w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (61, ?, 'one.example', 'r@x'), (62, ?, 'two.example', 'r@x')").run(w.b, w.b);
		return w;
	}

	it('with no Cloudflare connected there is nothing to clean up: it deletes', async () => {
		const { env, owner, b, db } = await withDomains();
		const res = await call(env, 'DELETE', `/api/workspaces/${b}?confirm=B`, { key: owner });
		expect(res.status).toBe(200);
		expect(rows(db, 'SELECT COUNT(*) n FROM domains WHERE workspace_id = ?', b)).toEqual([{ n: 0 }]);
	});

	it('Cloudflare unreachable for any domain: refused before anything is deleted, and the message says so', async () => {
		const { env, owner, b, db } = await withDomains();
		// B's second domain is linked to a connection whose token Cloudflare no longer accepts
		db.sqlite.prepare("INSERT INTO cloudflare_connections (id, workspace_id, label, auth_type, token_envelope, status) VALUES ('cfc_x', ?, 'x', 'token', 'junk', 'broken')").run(b);
		db.sqlite.prepare("UPDATE domains SET cf_connection_id = 'cfc_x' WHERE id = 62").run();
		const res = await call(env, 'DELETE', `/api/workspaces/${b}?confirm=B`, { key: owner });
		expect(res.status).toBe(502);
		const body = await json(res);
		expect(body.code).toBe('cloudflare_preflight_failed');
		expect(body.error).toContain('two.example');
		expect(body.error).toContain('nothing was deleted');
		expect(rows(db, 'SELECT COUNT(*) n FROM domains WHERE workspace_id = ?', b)).toEqual([{ n: 2 }]);
		expect(rows(db, 'SELECT id FROM workspaces WHERE id = ?', b)).toEqual([{ id: b }]);
	});

	it('a failure part-way says how many domains were already deleted, and keeps the workspace and the rest', async () => {
		const { db, owner, b } = await withDomains();
		const { handleWorkspaceRoutes } = await import('../../src/workspaces/routes');
		const { loadTenant } = await import('../../src/tenancy/load');
		const user = rows(db, 'SELECT id, email, name FROM users')[0];
		const calls: string[] = [];
		const res = await handleWorkspaceRoutes(
			new Request(`https://x.test/api/workspaces/${b}?confirm=B`, { method: 'DELETE' }),
			{ waitUntil() {} } as any,
			{ kind: 'session', user },
			{
				db: db as any,
				mode: 'selfhost',
				preflight: async () => null,
				tenantFor: (workspaceId) => loadTenant({ DB: db as any } as any, { workspaceId }),
				deleteDomain: async (_t, id) => {
					calls.push(id);
					if (id === '62') return new Response('x', { status: 502 });
					db.sqlite.prepare('DELETE FROM domains WHERE id = ?').run(Number(id));
					return new Response(null, { status: 204 });
				},
			},
		);
		expect(res!.status).toBe(502);
		const body = await json(res!);
		expect(body.code).toBe('domain_cleanup_failed');
		expect(body.error).toContain('two.example');
		expect(body.error).toContain('1 of 2 domains were already deleted');
		expect(body.error).toContain('cannot be restored');
		expect(calls).toEqual(['61', '62']);
		expect(rows(db, 'SELECT id FROM domains WHERE workspace_id = ?', b)).toEqual([{ id: 62 }]);
		expect(rows(db, 'SELECT id FROM workspaces WHERE id = ?', b)).toEqual([{ id: b }]);
		expect(owner).toBeTruthy();
	});
});

describe('an invite can be spent once, even by simultaneous accepts', () => {
	it('two simultaneous accepts of the same invite add the membership once and spend it once', async () => {
		const { db, env, owner, b } = await world();
		const sam = await inviteAndAccept(env, owner, 'sam@example.com', 'member');
		const inv = await json(await call(env, 'POST', '/api/team/invite', { key: owner, headers: ws(b), body: { email: 'sam@example.com', role: 'admin' } }));
		const results = await Promise.all([1, 2, 3].map(() => call(env, 'POST', `/api/invites/${inv.token}`, { key: sam, body: {} })));
		expect(results.map((r) => r.status).sort()).toEqual([200, 404, 404]);
		expect(rows(db, "SELECT COUNT(*) n FROM memberships WHERE workspace_id = ? AND user_id = (SELECT id FROM users WHERE email = 'sam@example.com')", b)).toEqual([{ n: 1 }]);
	});

	it('claimInvite is a single conditional update: first caller wins, expired and unknown tokens never claim', async () => {
		const { db, owner, env, b } = await world();
		const { forWorkspace } = await import('@inbox-angel/db');
		const team = forWorkspace(db as any, b).team;
		const inv = await json(await call(env, 'POST', '/api/team/invite', { key: owner, headers: ws(b), body: { email: 'x@y.test' } }));
		expect(await team.claimInvite(inv.token)).toBe(true);
		expect(await team.claimInvite(inv.token)).toBe(false);
		expect(await team.claimInvite('nope')).toBe(false);
		const inv2 = await json(await call(env, 'POST', '/api/team/invite', { key: owner, headers: ws(b), body: { email: 'z@y.test' } }));
		db.sqlite.prepare('UPDATE invites SET expires_at = 1 WHERE token = ?').run(inv2.token);
		expect(await team.claimInvite(inv2.token)).toBe(false);
	});
});
