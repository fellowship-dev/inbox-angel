// Screenshots for hosted mode and analytics: the hosted enable flow, the sender inventory and "what to fix next",
// desktop + 375px, light + dark, as WebP under 150 KB each.
// Needs a Worker with an owner (see e2e/analytics.spec.ts for the local setup) and Chromium:
//   E2E_BASE_URL=http://127.0.0.1:8787 E2E_PERSIST_TO=/tmp/ia-e2e node web/scripts/screenshots-web2.mjs [outDir]
// The analytics views use seeded reports (e2e/support/analytics-seed.ts). A local Worker is self-host, so the hosted
// endpoints are stubbed the way e2e/hosted-ui.spec.ts stubs them; the dashboard code shown is the real build.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { analyticsSeedSql } from '../../e2e/support/analytics-seed.ts';
import { toWebp } from './webp.mjs';

const out = new URL(process.argv[2] ?? '../screenshots/', import.meta.url).pathname;
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';
const persist = process.env.E2E_PERSIST_TO ?? '/tmp/ia-e2e';
const email = process.env.E2E_OWNER_EMAIL ?? 'owner@e2e.test';
const password = process.env.E2E_OWNER_PASSWORD ?? 'e2e-password-123';
const DOMAIN = 'acme-mail.example';
await mkdir(out, { recursive: true });

const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const { token } = await login.json();
const list = async () => (await (await fetch(`${base}/api/domains`, { headers: { 'X-Api-Key': token } })).json()).domains;
const sql = async (text) => {
	const file = join(await mkdtemp(join(tmpdir(), 'ia-shot-')), 'q.sql');
	await writeFile(file, text);
	execFileSync('npx', ['wrangler', 'd1', 'execute', 'inbox-angel', '--local', '--persist-to', persist, '--file', file], { stdio: 'pipe' });
};
let domain = (await list()).find((d) => d.domain === DOMAIN);
if (!domain) {
	await sql(`INSERT OR IGNORE INTO domains (workspace_id, domain, rua_address) VALUES ('ws_default', '${DOMAIN}', 'rua@reports.example');`);
	domain = (await list()).find((d) => d.domain === DOMAIN);
	await sql(analyticsSeedSql(domain.id, DOMAIN));
}

const ID = 'k3j2h4g5f6d7s8a9';
const hosted = (over = {}) => ({
	enabled: true, hosted_id: ID, mta_sts: false,
	records: { dmarc: `${ID}._dmarc.h.inboxangel.io`, spf: `${ID}._spf.h.inboxangel.io`, tls_rpt: `${ID}._tlsrpt.h.inboxangel.io`, mta_sts: null },
	pointers: [
		{ purpose: 'dmarc', type: 'CNAME', name: `_dmarc.${DOMAIN}`, value: `${ID}._dmarc.h.inboxangel.io` },
		{ purpose: 'spf', type: 'TXT', name: DOMAIN, value: `include:${ID}._spf.h.inboxangel.io` },
		{ purpose: 'tls_rpt', type: 'CNAME', name: `_smtp._tls.${DOMAIN}`, value: `${ID}._tlsrpt.h.inboxangel.io` },
	],
	pointer_status: { dmarc: 'ok', spf: 'missing', mta_sts: null, tls_rpt: 'error', checked_at: Math.floor(Date.now() / 1000) },
	level_inputs: { dmarc_published: true, spf_published: false, mta_sts_published: false },
	...over,
});
const stubHosted = async (page) => {
	let on = false;
	await page.route('**/api/hosted/config', (r) => r.fulfill({ json: { enabled: true } }));
	await page.route(`**/api/domains/${domain.id}/hosted`, (r) => {
		if (r.request().method() === 'POST') {
			on = true;
			return r.fulfill({ status: 201, json: { hosted: hosted(), addresses: { rua: `rua+${'q7x2'.repeat(8)}@rua.inboxangel.io`, tls_rpt: `tls-rpt+${'q7x2'.repeat(8)}@rua.inboxangel.io` } } });
		}
		return r.fulfill({ json: on ? hosted() : { enabled: false } });
	});
};

const section = (page, name) => page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) }).first();

const views = [
	{ name: 'sender-inventory', route: `/domains/${domain.id}/analytics`, targets: (p) => [section(p, 'Sender inventory')] },
	{ name: 'what-to-fix-next', route: `/domains/${domain.id}/analytics`, targets: (p) => [section(p, 'What to fix next')] },
	{
		name: 'hosted-enable',
		route: `/domains/${domain.id}`,
		stub: stubHosted,
		before: async (p) => {
			await p.getByRole('button', { name: 'Enable hosted records' }).click();
			await p.getByRole('dialog').getByRole('button', { name: 'Enable hosted records' }).click();
			await p.getByTestId('hosted-addresses').waitFor();
		},
		targets: (p) => [p.getByTestId('hosted-addresses'), section(p, 'Hosted records')],
	},
];
const viewports = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 800 } };

/** Screenshot of the union of the targets' boxes, so related blocks come out as one picture. */
async function clipOf(page, targets) {
	const boxes = [];
	for (const t of targets) {
		await t.scrollIntoViewIfNeeded();
		boxes.push(await t.boundingBox());
	}
	const sc = await page.evaluate(() => [scrollX, scrollY]);
	const x0 = Math.min(...boxes.map((b) => b.x)) + sc[0];
	const y0 = Math.min(...boxes.map((b) => b.y)) + sc[1];
	const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + sc[0];
	const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + sc[1];
	const pad = 8;
	return { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad };
}

const browser = await chromium.launch();
try {
	for (const theme of ['light', 'dark']) {
		for (const [vp, viewport] of Object.entries(viewports)) {
			for (const v of views) {
				const ctx = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' });
				await ctx.addInitScript(([t, th]) => { localStorage.setItem('ia_api_key', t); localStorage.setItem('ia_theme', th); }, [token, theme]);
				const page = await ctx.newPage();
				await v.stub?.(page);
				await page.goto(`${base}/#${v.route}`);
				await page.waitForLoadState('networkidle');
				await v.before?.(page);
				await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 30000 }).catch(() => {});
				await page.evaluate(() => document.fonts.ready);
				await page.addStyleTag({ content: 'header, [role="banner"] { visibility: hidden !important; }' }); // the sticky top bar would overlap the crop
				await page.waitForTimeout(600);
				const clip = await clipOf(page, v.targets(page));
				const file = `${out}${v.name}-${theme}-${vp}.webp`;
				const buf = await toWebp(page, await page.screenshot({ fullPage: true, clip }));
				await writeFile(file, buf);
				console.log(file, Math.round(buf.length / 1024) + ' KB');
				await ctx.close();
			}
		}
	}
} finally {
	await browser.close();
}
