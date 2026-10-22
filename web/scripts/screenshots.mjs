// Screenshots of the running dashboard: overview, domain detail, a wizard step and API keys,
// desktop + 375px, light + dark, as WebP under 150 KB each.
// Needs a Worker with an owner and demo data (npm run seed:local) and Chromium:
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium
//   E2E_BASE_URL=http://127.0.0.1:8787 E2E_OWNER_EMAIL=… E2E_OWNER_PASSWORD=… node web/scripts/screenshots.mjs [outDir]
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { toWebp } from './webp.mjs';

const out = new URL(process.argv[2] ?? '../screenshots/', import.meta.url).pathname;
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';
const email = process.env.E2E_OWNER_EMAIL ?? 'owner@e2e.test';
const password = process.env.E2E_OWNER_PASSWORD ?? 'e2e-password-123';
await mkdir(out, { recursive: true });

const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const { token } = await login.json();
const { domains } = await (await fetch(`${base}/api/domains`, { headers: { 'X-Api-Key': token } })).json();
const demo = domains.find((d) => d.domain === 'getacme.com') ?? domains[0];

const views = [
	{ name: 'overview', route: '/' },
	{ name: 'domain-detail', route: `/domains/${demo.id}` },
	{ name: 'wizard-spf', route: `/domains/${demo.id}/setup/2` },
	{ name: 'api-keys', route: '/keys', before: async (page) => { await page.getByLabel('Name').fill('CI deploy'); await page.getByRole('button', { name: 'Create key' }).click(); await page.getByTestId('secret-once').waitFor(); } },
];
const viewports = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 800 } };

const browser = await chromium.launch();
try {
	for (const theme of ['light', 'dark']) {
		for (const [vp, viewport] of Object.entries(viewports)) {
			const ctx = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' });
			await ctx.addInitScript(([t, th]) => { localStorage.setItem('ia_api_key', t); localStorage.setItem('ia_theme', th); }, [token, theme]);
			const page = await ctx.newPage();
			for (const v of views) {
				await page.goto(`${base}/#${v.route}`);
				await page.waitForLoadState('networkidle');
				await v.before?.(page);
				await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 30000 }).catch(() => {});
				await page.evaluate(() => document.fonts.ready);
				await page.waitForTimeout(600);
				const file = `${out}${v.name}-${theme}-${vp}.webp`;
				const buf = await toWebp(page, await page.screenshot({ fullPage: true }));
				await writeFile(file, buf);
				console.log(file, Math.round(buf.length / 1024) + ' KB');
			}
			await ctx.close();
		}
	}
} finally {
	await browser.close();
}
