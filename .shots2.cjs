// node ~/work/shots.cjs <label> [only-name-substring]
// Full-page captures at 1440 and 375, light and dark, as owner, member and the empty workspace. Heights to heights.json.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const BASE = 'https://localhost:8787';
const label = process.argv[2] || 'run';
const only = process.argv[3] || '';
const W = path.join(os.homedir(), 'work');
const creds = JSON.parse(fs.readFileSync(path.join(W, 'creds.json'), 'utf8'));
const ids = JSON.parse(fs.readFileSync(path.join(W, 'ids.json'), 'utf8'));
const OUT = path.join(os.homedir(), 'shots', label);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LADDER_CHECK = () => {
	// Every ladder label: is it cut (scrollWidth > clientWidth) or does it overlap a sibling label?
	const out = { labels: 0, clipped: 0, overlaps: 0 };
	for (const bar of document.querySelectorAll('[role=progressbar]')) {
		const ps = [...bar.querySelectorAll('p')].filter((p) => /Delivering|Authenticated|Protected/.test(p.textContent));
		const rects = ps.map((p) => p.getBoundingClientRect());
		ps.forEach((p, i) => {
			out.labels++;
			if (p.scrollWidth > p.clientWidth + 1) out.clipped++;
			for (let j = i + 1; j < rects.length; j++) {
				const a = rects[i], b = rects[j];
				if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.overlaps++;
			}
		});
	}
	return out;
};
const shots = [
	{ name: 'selfhost-overview', who: 'owner', url: '#/w/ws_default/', variants: ['1440-light', '1440-dark', '375-light', '375-dark'] },
	{ name: 'selfhost-domain-iana', who: 'owner', url: `#/w/ws_default/domains/${ids.domains['iana.org']}`, pace: true, variants: ['1440-light', '375-light'] },
	{ name: 'hosted-overview', who: 'owner', url: `#/w/${ids.hostedWs}/`, hosted: true, variants: ['1440-light', '1440-dark', '375-light', '375-dark'] },
	{ name: 'hosted-domain-github', who: 'owner', url: `#/w/${ids.hostedWs}/domains/${ids.hosted['github.com']}`, hosted: true, pace: true, variants: ['1440-light', '375-light'] },
];
const variants = [
	{ w: 1440, h: 900, scheme: 'light' },
	{ w: 1440, h: 900, scheme: 'dark' },
	{ w: 375, h: 812, scheme: 'light' },
	{ w: 375, h: 812, scheme: 'dark' },
];

(async () => {
	const browser = await chromium.launch();
	// One login per user (the auth limiter allows 10 a minute), reused through storage state.
	const states = {};
	for (const who of ['owner', 'member']) {
		const c = await browser.newContext({ ignoreHTTPSErrors: true });
		const r = await c.request.post(BASE + '/api/auth/login', { headers: { Origin: BASE }, data: creds[who] });
		console.log('login', who, r.status());
		states[who] = await c.storageState();
		await c.close();
	}
	const heights = {};
	const hpath = path.join(OUT, 'heights.json');
	if (fs.existsSync(hpath)) Object.assign(heights, JSON.parse(fs.readFileSync(hpath, 'utf8')));
	for (const s of shots.filter((x) => x.name.includes(only))) {
		const vs = (s.variants ?? ['1440-light']).map((k) => { const [w, scheme] = k.split('-'); return { w: Number(w), h: Number(w) < 500 ? 812 : 900, scheme }; });
		for (const v of vs) {
			const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: v.w, height: v.h }, colorScheme: v.scheme, storageState: states[s.who] });
			await ctx.addInitScript((wsIds) => {
				try { for (const w of wsIds) sessionStorage.setItem(`ia_setup_redirected:${w}`, '1'); } catch {}
			}, ['ws_default', ids.emptyWs, ids.hostedWs]);
			const page = await ctx.newPage();
			if (s.abort) await page.route(s.abort, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"simulated failure"}' }));
			// Hosted mode, client side only: the self-host server's status with mode "saas" and a booking link, so the
			// dashboard renders its hosted states (Talk to Max, reports not connected, 4-step setup). Labelled as simulated.
			if (s.hosted) await page.route('**/api/auth/status', async (r) => { const res = await r.fetch(); const j = await res.json(); r.fulfill({ response: res, json: { ...j, mode: 'saas', signup_open: true, signin_available: true, help_url: 'https://cal.com/example/rsm-review' } }); });
			let api = 0;
			page.on('request', (r) => { if (r.url().includes('/api/')) api++; });
			const errors = [];
			page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
			await page.goto(BASE + '/' + s.url);
			await page.waitForLoadState('networkidle').catch(() => {});
			await sleep(2500);
			if (s.click) { await page.getByRole('button', { name: s.click }).first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await sleep(3000); }
			const ladder = await page.evaluate(LADDER_CHECK);
			const rows = await page.evaluate(() => [...document.querySelectorAll('li[data-status]')].filter((li) => li.querySelector('h3')).map((li) => ({
				domain: li.querySelector('h3').textContent.trim(),
				status: li.querySelector('span[data-status]')?.textContent.trim(),
				level: li.querySelector('[role=progressbar]')?.getAttribute('aria-valuetext'),
				text: [...li.querySelectorAll('p')].map((p) => p.textContent.trim()).filter((t) => !/^(Delivering|Authenticated|Protected|Level not known yet)$/.test(t)),
			})));
			const actions = await page.evaluate(() => [...document.querySelectorAll('section ol > li[data-status]')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
			const answer = await page.evaluate(() => document.querySelector('[data-testid=am-i-done]')?.textContent ?? null);
			const m = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h1: [...document.querySelectorAll('h1,h2,h3,h4,h5')].map((e) => e.tagName + ':' + e.textContent.trim().slice(0, 40)) }));
			const file = `${s.name}--${v.w}-${v.scheme}.png`;
			await page.screenshot({ path: path.join(OUT, file), fullPage: true });
			heights[`${s.name}--${v.w}-${v.scheme}`] = { height: m.h, overflowX: m.sw - m.cw, errors: errors.length, ladder, api, answer, rows: v.w === 1440 ? rows : undefined, actions: v.w === 1440 ? actions : undefined };
			if (v.w === 1440 && v.scheme === 'light') heights[`${s.name}--headings`] = m.h1;
			console.log(file, m.h, 'overflowX', m.sw - m.cw, 'errors', errors.length, 'api', api, 'ladder', JSON.stringify(ladder), errors[0] ?? '');
			await ctx.close();
			await sleep(s.pace ? 12000 : 8000);
		}
	}
	fs.writeFileSync(hpath, JSON.stringify(heights, null, 1));
	await browser.close();
	console.log('SHOTS-DONE');
})();
