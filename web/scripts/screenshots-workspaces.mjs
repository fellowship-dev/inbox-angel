// Screenshots for workspaces: the switcher open, a new workspace's empty state, the invite-accept page.
// Desktop, light + dark, WebP under 150 KB each. Needs a local Worker with an owner (see e2e/workspaces.spec.ts) and Chromium:
//   E2E_BASE_URL=http://127.0.0.1:8787 node web/scripts/screenshots-workspaces.mjs [outDir]
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { toWebp } from './webp.mjs';

const out = new URL(process.argv[2] ?? '../screenshots/', import.meta.url).pathname;
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';
const email = process.env.E2E_OWNER_EMAIL ?? 'owner@e2e.test';
const password = process.env.E2E_OWNER_PASSWORD ?? 'e2e-password-123';
await mkdir(out, { recursive: true });

const post = async (path, body, headers = {}) => {
	const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
	return res.json();
};
const { token } = await post('/api/auth/login', { email, password });
const auth = { 'X-Api-Key': token };
const get = async (path, headers = {}) => (await fetch(base + path, { headers: { ...auth, ...headers } })).json();

// The story: Max's own workspace, the Lexgo one he made, and a brand-new empty one.
await fetch(`${base}/api/workspaces/ws_default`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json', origin: base }, body: JSON.stringify({ name: 'Fellowship' }) });
let workspaces = (await get('/api/workspaces')).workspaces;
const ensure = async (name) => workspaces.find((w) => w.name === name) ?? (await post('/api/workspaces', { name }, auth), (workspaces = (await get('/api/workspaces')).workspaces).find((w) => w.name === name));
const lexgo = await ensure('Lexgo');
const fresh = await ensure('Acme Studio');
const invite = await post('/api/team/invite', { email: "priya@lexgo.example", role: 'member' }, { ...auth, 'X-Workspace-Id': lexgo.id });

const views = [
	{
		name: 'workspace-switcher',
		route: `/#/w/${lexgo.id}/`,
		signedIn: true,
		before: async (p) => {
			await p.getByRole('button', { name: /^Workspace: Lexgo/ }).click();
			await p.getByRole('menu').waitFor();
		},
	},
	{ name: 'workspace-empty-state', route: `/#/w/${fresh.id}/`, signedIn: true, before: (p) => p.getByText('No domains yet').waitFor() },
	{ name: 'invite-accept', route: `/#/invite/${invite.token}`, signedIn: false, before: (p) => p.getByRole('button', { name: 'Accept invite' }).waitFor() },
];

const browser = await chromium.launch();
try {
	for (const theme of ['light', 'dark']) {
		for (const v of views) {
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme, reducedMotion: 'reduce' });
			await ctx.addInitScript(([t, th, signedIn, seen]) => {
				if (signedIn) localStorage.setItem('ia_api_key', t);
				sessionStorage.setItem(seen, '1'); // a workspace made from the switcher starts at its empty state, not the wizard
				localStorage.setItem('ia_theme', th);
			}, [token, theme, v.signedIn, `ia_setup_redirected:${fresh.id}`]);
			const page = await ctx.newPage();
			await page.goto(base + v.route);
			await v.before(page);
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(500);
			const buf = await toWebp(page, await page.screenshot());
			const file = `${out}${v.name}-${theme}-desktop.webp`;
			await writeFile(file, buf);
			console.log(file, Math.round(buf.length / 1024) + ' KB');
			await ctx.close();
		}
	}
} finally {
	await browser.close();
}
