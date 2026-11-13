// Inbox Angel dashboard capture: local wrangler dev (HTTPS, local D1), synthetic data only.
// Run from /workspace/inbox-angel with LD_LIBRARY_PATH for rootless chromium. Never prints secrets.
const { chromium, request } = require('@playwright/test');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BASE = 'https://localhost:8787';
const OUT = process.env.OUT || `${process.env.HOME}/shots`;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
fs.mkdirSync(OUT, { recursive: true });
const op = JSON.parse(fs.readFileSync(`${process.env.HOME}/op.json`, 'utf8'));
const VARIANTS = [
	{ w: 1440, h: 900, t: 'light' }, { w: 1440, h: 900, t: 'dark' },
	{ w: 375, h: 812, t: 'light' }, { w: 375, h: 812, t: 'dark' },
];
const log = [];
const note = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function sql(s) {
	fs.writeFileSync('/tmp/q.sql', s);
	return execFileSync('npx', ['wrangler', 'd1', 'execute', 'inbox-angel', '--local', '--file', '/tmp/q.sql'], { cwd: '/workspace/inbox-angel', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

const DAY = 86400;
function seedSql(domainId, domain, entries, policy, now = Math.floor(Date.now() / 1000)) {
	const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
	const out = [`UPDATE domains SET spf_record = 'v=spf1 include:_spf.google.com include:sendgrid.net ~all', dmarc_policy = '${policy}' WHERE id = ${domainId};`];
	for (let ago = 1; ago <= 30; ago++) {
		const today = entries.filter((e) => !e.recent || ago <= 2);
		const jitter = (n) => Math.max(1, Math.round(n * (0.8 + ((ago * 7) % 5) / 10)));
		const rows = today.map((e) => ({ ...e, c: jitter(e.count) }));
		const total = rows.reduce((n, e) => n + e.c, 0);
		const pass = rows.filter((e) => e.pass).reduce((n, e) => n + e.c, 0);
		const begin = Math.floor((now - ago * DAY) / DAY) * DAY;
		for (const org of ['google.com', 'Outlook.com']) {
			const rid = `seed-${domainId}-${org}-${ago}`;
			const share = org === 'google.com' ? 0.7 : 0.3;
			const t = Math.max(1, Math.round(total * share)), p = Math.round(pass * share);
			out.push(`INSERT OR IGNORE INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id) VALUES (${domainId}, '${org}', '${rid}', ${begin}, ${begin + DAY - 1}, ${t}, ${p}, ${t - p}, 'ws_default');`);
			for (const e of rows) {
				const c = Math.max(1, Math.round(e.c * share));
				out.push(`INSERT INTO report_records (report_id, source_ip, count, disposition, spf_result, spf_domain, dkim_result, dkim_domain, header_from, reverse_dns, base_domain, org, workspace_id) SELECT id, '${e.ip}', ${c}, '${e.pass ? 'none' : (policy === 'none' ? 'none' : policy)}', ${q(e.spf[0])}, ${q(e.spf[1])}, ${q(e.dkim[0])}, ${q(e.dkim[1])}, ${q(domain)}, ${q(e.ptr)}, ${q(e.base)}, ${q(e.org)}, 'ws_default' FROM aggregate_reports WHERE domain_id = ${domainId} AND report_id = '${rid}';`);
			}
		}
	}
	return out.join('\n');
}

async function settle(page, ms = 900) {
	try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
	await page.waitForTimeout(ms);
}

/** Capture one screen in all four variants. */
async function shoot(browser, name, rest, o = {}) {
	if (ONLY && !ONLY.test(name)) return;
	for (const v of (o.variants || VARIANTS)) {
		if (process.env.PACE) await new Promise((r) => setTimeout(r, +process.env.PACE));
		const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, colorScheme: v.t, ignoreHTTPSErrors: true, storageState: o.storage, reducedMotion: 'reduce' });
		if (o.seen) await ctx.addInitScript((k) => { try { sessionStorage.setItem(k, '1'); } catch {} }, `ia_setup_redirected:${o.seen}`);
		if (o.route) await o.route(ctx);
		const page = await ctx.newPage();
		const errors = [];
		page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
		const url = rest.startsWith('http') ? rest : `${BASE}/#${o.ws ? `/w/${o.ws}` : ''}${rest}`;
		let status = 'ok';
		try {
			await page.goto(url, { waitUntil: 'domcontentloaded' });
			if (o.early) await page.waitForTimeout(o.early); else await settle(page);
			if (o.before) await o.before(page, v);
			const file = `${OUT}/${name}--${v.w}-${v.t}.png`;
			await page.screenshot({ path: file, fullPage: true });
			const m = await page.evaluate(() => ({
				h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()).join(' | ').slice(0, 120),
				overflowX: document.documentElement.scrollWidth - window.innerWidth,
				height: document.documentElement.scrollHeight,
				hash: location.hash.slice(0, 120), path: location.pathname,
			}));
			log.push({ name, variant: `${v.w}-${v.t}`, ...m, errors: errors.slice(0, 3) });
		} catch (e) { status = `fail: ${String(e).slice(0, 200)}`; log.push({ name, variant: `${v.w}-${v.t}`, status }); }
		note(name, `${v.w}-${v.t}`, status);
		await ctx.close();
	}
}

async function api(ctxReq, method, path, data, extra = {}) {
	const r = await ctxReq.fetch(`${BASE}${path}`, { method, data, headers: { Origin: BASE, ...extra } });
	let body = null; try { body = await r.json(); } catch {}
	return { status: r.status(), body };
}

(async () => {
	const browser = await chromium.launch();
	const anon = await request.newContext({ ignoreHTTPSErrors: true });
	const status = (await api(anon, 'GET', '/api/auth/status')).body;
	note('configured', status.configured);

	// ── A. Anonymous, unconfigured instance (first-owner setup) ──
	if (!status.configured) {
		await shoot(browser, '01-auth-first-owner-setup', '/');
		await shoot(browser, '01b-auth-first-owner-setup-error', '/', { before: async (p) => {
			await p.fill('#bootstrap-proof', 'x'.repeat(40)); await p.fill('#email', 'owner@example.test');
			await p.fill('#password', 'wrong-password-1'); if (await p.$('#confirm')) await p.fill('#confirm', 'wrong-password-1');
			await p.click('button[type=submit]'); await settle(p, 1200);
		} });
		const owner = await request.newContext({ ignoreHTTPSErrors: true });
		const r = await api(owner, 'POST', '/api/auth/setup', { email: op.email, password: op.password, name: 'Dana Ortiz' }, { 'X-Inbox-Angel-Bootstrap': op.proof });
		note('setup status', r.status);
		await owner.storageState({ path: `${process.env.HOME}/owner.json` });
	}
	if (!fs.existsSync(`${process.env.HOME}/owner.json`)) {
		const owner = await request.newContext({ ignoreHTTPSErrors: true });
		note('login status', (await api(owner, 'POST', '/api/auth/login', { email: op.email, password: op.password })).status);
		await owner.storageState({ path: `${process.env.HOME}/owner.json` });
	}
	const storage = `${process.env.HOME}/owner.json`;
	const ownerReq = await request.newContext({ ignoreHTTPSErrors: true, storageState: storage });
	const me = (await api(ownerReq, 'GET', '/api/me')).body || {};
	const WS = me.workspace_id || 'ws_default';
	note('workspace', WS);

	// Anonymous screens on a configured instance
	await shoot(browser, '02-auth-sign-in', '/');
	await shoot(browser, '02b-auth-sign-in-error', '/', { before: async (p) => {
		await p.fill('#email', op.email); await p.fill('#password', 'not-the-password'); await p.click('button[type=submit]'); await settle(p, 1500);
	} });
	await shoot(browser, '03-auth-forgot', '/forgot');
	await shoot(browser, '04-auth-reset-invalid', '/reset/not-a-real-token');
	await shoot(browser, '05-auth-invite-invalid', '/invite/not-a-real-token');
	await shoot(browser, '06-gate-server-unreachable', '/', { route: (c) => c.route('**/api/**', (rt) => rt.abort()), early: 4000 });
	await shoot(browser, '07-gate-loading-skeleton', '/', { storage, route: (c) => c.route('**/api/me', async (rt) => { await new Promise((r) => setTimeout(r, 15000)); rt.continue().catch(() => {}); }), early: 1500 });

	// ── B. Owner, fresh instance, no domains (the step right after registering) ──
	const domains0 = (await api(ownerReq, 'GET', '/api/domains')).body?.domains || [];
	if (!domains0.length) {
		await shoot(browser, '10-first-run-setup-wizard', '/', { storage, ws: WS });
		await shoot(browser, '10b-first-run-setup-invalid-domain', '/setup', { storage, ws: WS, before: async (p) => {
			await p.fill('input[placeholder="yourdomain.com"]', 'not a domain'); await p.keyboard.press('Enter'); await settle(p, 1200);
		} });
		await shoot(browser, '11-overview-empty', '/', { storage, ws: WS, seen: WS });
		await shoot(browser, '12-add-domain-empty', '/add', { storage, ws: WS, seen: WS });
		await shoot(browser, '13-analytics-empty', '/analytics', { storage, ws: WS, seen: WS });
		// Register the first domain through the real wizard UI (one context only)
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, storageState: storage });
		const p = await ctx.newPage();
		await p.goto(`${BASE}/#/w/${WS}/setup`); await settle(p);
		await p.fill('input[placeholder="yourdomain.com"]', 'example.org'); await p.keyboard.press('Enter'); await settle(p, 2500);
		note('after domain step', p.url().replace(BASE, ''));
		await ctx.close();
	}

	// ── C. Seed: two more domains with 30 days of reports ──
	let domains = (await api(ownerReq, 'GET', '/api/domains')).body?.domains || [];
	if (!domains.find((d) => d.domain === 'example.com')) {
		sql(`INSERT OR IGNORE INTO domains (workspace_id, domain, rua_address) VALUES ('${WS}', 'example.com', 'rua@reports.example.com'), ('${WS}', 'example.net', 'rua@reports.example.net');`);
		domains = (await api(ownerReq, 'GET', '/api/domains')).body?.domains || [];
		const com = domains.find((d) => d.domain === 'example.com'), net = domains.find((d) => d.domain === 'example.net');
		const G = { ip: '209.85.220.41', count: 80, pass: true, ptr: 'mail-sor-f41.google.com', base: 'google.com', org: 'Google LLC' };
		sql(seedSql(com.id, 'example.com', [
			{ ...G, spf: ['pass', 'example.com'], dkim: ['pass', 'example.com'] },
			{ ip: '198.2.180.1', count: 12, pass: false, spf: ['pass', 'mcsv.net'], dkim: ['pass', 'mcsv.net'], ptr: 'mail180.mcsv.net', base: 'mcsv.net', org: 'The Rocket Science Group' },
			{ ip: '203.0.113.9', count: 3, pass: false, spf: ['fail', 'example.com'], dkim: ['none', 'example.com'], org: 'Unknown hosting' },
			{ ip: '167.89.1.1', count: 5, pass: true, spf: ['pass', 'em.example.com'], dkim: ['pass', 'example.com'], ptr: 'o1.em.sendgrid.net', base: 'sendgrid.net', org: 'SendGrid', recent: true },
		], 'none'));
		sql(seedSql(net.id, 'example.net', [
			{ ...G, count: 140, spf: ['pass', 'example.net'], dkim: ['pass', 'example.net'] },
			{ ip: '40.107.22.50', count: 30, pass: true, spf: ['pass', 'example.net'], dkim: ['pass', 'example.net'], ptr: 'mail-db8eur05.outbound.protection.outlook.com', base: 'outlook.com', org: 'Microsoft Corporation' },
			{ ip: '54.240.8.21', count: 2, pass: false, spf: ['softfail', 'amazonses.com'], dkim: ['pass', 'amazonses.com'], ptr: 'a8-21.smtp-out.amazonses.com', base: 'amazonses.com', org: 'Amazon SES' },
		], 'quarantine'));
		domains = (await api(ownerReq, 'GET', '/api/domains')).body?.domains || [];
	}
	fs.writeFileSync(`${OUT}/_domains.json`, JSON.stringify(domains.map((d) => ({ id: d.id, domain: d.domain })), null, 1));
	const id = (n) => domains.find((d) => d.domain === n)?.id;
	const COM = id('example.com'), NET = id('example.net'), ORG = id('example.org');
	note('ids', COM, NET, ORG);
	const own = { storage, ws: WS, seen: WS };

	// Setup wizard for the domain registered through the UI
	if (ORG) for (let s = 1; s <= 5; s++) await shoot(browser, `14-setup-step-${s}`, `/domains/${ORG}/setup/${s}`, own);

	// ── D. Populated workspace ──
	await shoot(browser, '20-overview-populated', '/', own);
	await shoot(browser, '21-domain-detail-reports', `/domains/${COM}`, own);
	await shoot(browser, '21b-domain-detail-quarantine', `/domains/${NET}`, own);
	await shoot(browser, '21c-domain-detail-waiting-for-reports', `/domains/${ORG}`, own);
	await shoot(browser, '22-domain-settings', `/domains/${COM}/settings`, own);
	await shoot(browser, '23-domain-analytics', `/domains/${COM}/analytics`, own);
	await shoot(browser, '24-domain-explore-senders', `/domains/${COM}/explore`, own);
	await shoot(browser, '25-domain-anomalies', `/domains/${COM}/anomalies`, own);
	await shoot(browser, '26-domain-reports-list', `/domains/${COM}/reports`, own);
	const day = new Date(Date.now() - DAY * 1000).toISOString().slice(0, 10);
	await shoot(browser, '27-domain-report-detail', `/domains/${COM}/reports/${day}`, own);
	await shoot(browser, '28-wizard-dmarc', `/domains/${COM}/dmarc-wizard`, own);
	await shoot(browser, '29-wizard-spf-flatten', `/domains/${COM}/spf-flatten`, own);
	await shoot(browser, '30-wizard-mta-sts', `/domains/${COM}/mta-sts`, own);
	await shoot(browser, '31-analytics-all', '/analytics', own);
	await shoot(browser, '32-email-check', '/check', own);
	await shoot(browser, '33-members', '/members', own);
	await shoot(browser, '34-api-keys', '/keys', own);
	await shoot(browser, '35-audit-log', '/audit', own);
	await shoot(browser, '36-leads', '/leads', own);
	await shoot(browser, '37-settings', '/settings', own);
	await shoot(browser, '38-add-domain', '/add', own);
	await shoot(browser, '38b-bulk-import', '/bulk-import', own);
	await shoot(browser, '38c-ct-discover', '/ct-discover', own);
	await shoot(browser, '39-not-found', '/no-such-page', own);
	await shoot(browser, '40-domain-load-error', `/domains/${COM}`, { ...own, route: (c) => c.route(/\/api\/domains\/\d+/, (rt) => rt.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' })) });

	// ── E. Fresh empty second workspace ──
	let wsList = (await api(ownerReq, 'GET', '/api/workspaces')).body;
	wsList = Array.isArray(wsList) ? wsList : (wsList?.workspaces || []);
	let empty = wsList.find((w) => w.name === 'Second brand');
	if (!empty) empty = (await api(ownerReq, 'POST', '/api/workspaces', { name: 'Second brand' })).body;
	if (empty?.id) {
		await shoot(browser, '41-new-workspace-first-visit', '/', { storage, ws: empty.id });
		await shoot(browser, '41b-new-workspace-overview-empty', '/', { storage, ws: empty.id, seen: empty.id });
	}

	// ── F. OAuth / MCP consent ──
	const reg = await api(anon, 'POST', '/oauth/register', { client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:33418/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
	note('dcr', reg.status);
	if (reg.body?.client_id) {
		const verifier = crypto.randomBytes(32).toString('base64url');
		const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
		const qs = new URLSearchParams({ response_type: 'code', client_id: reg.body.client_id, redirect_uri: 'http://127.0.0.1:33418/callback', scope: 'inbox-angel', state: 'st123', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` });
		const authz = `${BASE}/oauth/authorize?${qs}`;
		await shoot(browser, '50-oauth-authorize-signed-out', authz);
		await shoot(browser, '51-oauth-consent', authz, { storage });
	}

	// ── G. Invite, member (read-only) and no-workspace ──
	const inv = await api(ownerReq, 'POST', '/api/team/invite', { email: 'sam@example.test', role: 'member' });
	note('invite', inv.status);
	if (inv.body?.token) {
		await shoot(browser, '60-invite-accept', `/invite/${inv.body.token}`);
		const mem = await request.newContext({ ignoreHTTPSErrors: true });
		const pw = crypto.randomBytes(12).toString('base64url');
		note('accept', (await api(mem, 'POST', `/api/invites/${inv.body.token}`, { name: 'Sam Lee', password: pw })).status);
		await mem.storageState({ path: `${process.env.HOME}/member.json` });
		const ms = `${process.env.HOME}/member.json`;
		await shoot(browser, '61-member-overview', '/', { storage: ms, ws: WS, seen: WS });
		await shoot(browser, '62-member-domain-detail', `/domains/${COM}`, { storage: ms, ws: WS, seen: WS });
		sql(`DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email = 'sam@example.test');`);
		await shoot(browser, '63-no-workspace', '/', { storage: ms });
	}

	fs.writeFileSync(`${OUT}/_log.json`, JSON.stringify(log, null, 1));
	await browser.close();
	note('done', log.length, 'captures');
})().catch((e) => { console.error('FATAL', String(e).slice(0, 500)); fs.writeFileSync(`${OUT}/_log.json`, JSON.stringify(log, null, 1)); process.exit(1); });
