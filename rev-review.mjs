// PR 139 review measurements. Runs inside the devbox from /workspace/inbox-angel.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://localhost:8787';
const OUT = '/tmp/rev';
mkdirSync(OUT, { recursive: true });
const results = {};
const log = (k, v) => { results[k] = v; console.log(k, JSON.stringify(v)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (s) => { writeFileSync('/tmp/rev/q.sql', s); return execFileSync('npx', ['wrangler', 'd1', 'execute', 'inbox-angel', '--local', '--json', '--file', '/tmp/rev/q.sql'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); };

const browser = await chromium.launch();
const mk = async (theme, w, h, reduced = false) => {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: h }, colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
	await ctx.addInitScript((t) => { try { localStorage.setItem('ia_theme', t); } catch {} }, theme);
	return ctx;
};

// ---------- accounts ----------
const owner = { email: 'owner2@review.test', password: randomBytes(12).toString('hex') };
const member = { email: 'member2@review.test', password: randomBytes(12).toString('hex') };
const ownerCtx = await mk('light', 1440, 900);
const st0 = await (await ownerCtx.request.get(`${BASE}/api/auth/status`)).json();
const proof = process.env.BOOT;
let r = await ownerCtx.request.post(`${BASE}/api/auth/${st0.configured ? 'login' : 'setup'}`, { headers: { Origin: BASE, 'X-Inbox-Angel-Bootstrap': proof }, data: { ...owner, name: 'Owner' } });
log('owner.setup', r.status());
const me = await (await ownerCtx.request.get(`${BASE}/api/me`)).json();
const ws = me.workspace_id ?? 'ws_default';
log('ws', ws);

// domains: parent + subdomain so sp alert, plus reports
sql(`INSERT OR IGNORE INTO domains (workspace_id, domain, rua_address) VALUES ('${ws}', 'example.com', 'rua@reports.e2e.test');`);
const doms = (await (await ownerCtx.request.get(`${BASE}/api/domains`, { headers: { 'X-Workspace-Id': ws } })).json()).domains;
const d1 = doms.find((d) => d.domain === 'example.com');
log('domain', d1?.id);
const { analyticsSeedSql } = await import('/workspace/inbox-angel/e2e/support/analytics-seed.ts').catch(() => ({}));
if (analyticsSeedSql && !d1.__seeded) sql(analyticsSeedSql(d1.id, 'example.com').replaceAll('ws_default', ws));
else log('seed', 'could not import analytics-seed.ts');

// member via invite
r = await ownerCtx.request.post(`${BASE}/api/team/invite`, { headers: { Origin: BASE, 'X-Workspace-Id': ws }, data: { email: member.email, role: 'member' } });
const inv = await r.json();
log('invite', r.status());
const memberCtxL = await mk('light', 1440, 900);
r = await memberCtxL.request.post(`${BASE}/api/invites/${inv.token}`, { headers: { Origin: BASE }, data: { name: 'Member', password: member.password } });
log('accept', r.status());
await ownerCtx.storageState({ path: `${OUT}/owner.json` });
await memberCtxL.storageState({ path: `${OUT}/member.json` });
await ownerCtx.close(); await memberCtxL.close();

// ---------- helpers ----------
const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
const gradScan = (page) => page.evaluate(() => {
	const hits = [];
	for (const el of document.querySelectorAll('*')) for (const ps of [null, '::before', '::after']) {
		const cs = getComputedStyle(el, ps);
		for (const p of ['backgroundImage', 'borderImageSource', 'maskImage', 'listStyleImage', 'webkitMaskImage']) if (/gradient/i.test(cs[p] || '')) hits.push(`${el.tagName}.${el.className}${ps ?? ''} ${p}`);
	}
	let css = 0; for (const s of document.styleSheets) { try { for (const rule of s.cssRules) if (/gradient\(/i.test(rule.cssText)) css++; } catch {} }
	const svgGrad = document.querySelectorAll('linearGradient,radialGradient').length;
	return { computed: hits.slice(0, 10), computedCount: hits.length, cssRules: css, svgGrad };
});
const go = async (page, path) => { await page.goto(`${BASE}/#/w/${ws}${path}`); await page.evaluate((w) => sessionStorage.setItem(`ia_setup_redirected:${w}`, '1'), ws); await page.goto(`${BASE}/#/w/${ws}${path}`); await page.waitForLoadState('networkidle'); await sleep(800); };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
const ctxFor = async (who, theme, w, reduced) => { const c = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: 900 }, colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference', storageState: `${OUT}/${who}.json` }); await c.addInitScript((t) => { try { localStorage.setItem('ia_theme', t); } catch {} }, theme); return c; };

for (const theme of ['light', 'dark']) for (const w of [1440, 375]) {
	const tag = `${theme}-${w}`;
	const ctx = await ctxFor('owner', theme, w);
	const page = await ctx.newPage();

	// 1. Skeleton: hold /api/domains so the overview shows skeletons
	await page.route('**/api/domains**', async (route) => { await sleep(6000); await route.continue().catch(() => {}); });
	await page.goto(`${BASE}/#/w/${ws}/`); await page.evaluate((x) => sessionStorage.setItem(`ia_setup_redirected:${x}`, '1'), ws);
	await page.goto(`${BASE}/#/w/${ws}/`); await sleep(1200);
	const sk = await page.evaluate(() => [...document.querySelectorAll('.ia-pulse')].slice(0, 3).map((e) => { const c = getComputedStyle(e); return { anim: c.animationName, dur: c.animationDuration, bg: c.backgroundColor, bgImg: c.backgroundImage, op: c.opacity }; }));
	log(`${tag}.skeleton`, { count: sk.length, sample: sk[0] });
	await shot(page, `${tag}-skeleton`);
	log(`${tag}.skeleton.gradients`, await gradScan(page));
	await page.unroute('**/api/domains**');

	// 2. Overview + gradient scan
	await go(page, '/');
	log(`${tag}.overview.gradients`, await gradScan(page));
	log(`${tag}.overview.continueSetup`, await page.getByRole('link', { name: /Continue setup/ }).count());
	await shot(page, `${tag}-overview`);

	// 3. Domain page alert button
	await go(page, `/domains/${d1.id}`);
	const up = page.getByRole('link', { name: /Upgrade to/ });
	if (await up.count()) {
		const m = await up.first().evaluate((a) => { const c = getComputedStyle(a); let p = a.parentElement; while (p && getComputedStyle(p).backgroundColor === 'rgba(0, 0, 0, 0)') p = p.parentElement; return { fg: c.color, bg: c.backgroundColor, alertBg: p ? getComputedStyle(a.closest('[role=status],[role=alert]') ?? p).backgroundColor : null, deco: c.textDecorationLine, h: a.getBoundingClientRect().height, slot: a.dataset.slot }; });
		log(`${tag}.upgrade`, { ...m, labelOnFill: ratio(m.fg, m.bg), fillOnAlert: ratio(m.bg, m.alertBg) });
	} else log(`${tag}.upgrade`, 'not present');
	// other alert inline links keep brand-ink + underline
	const inl = await page.evaluate(() => [...document.querySelectorAll('[role=status] a:not([data-slot=button]),[role=alert] a:not([data-slot=button])')].map((a) => { const c = getComputedStyle(a); return { t: a.textContent.trim().slice(0, 30), color: c.color, deco: c.textDecorationLine }; }));
	log(`${tag}.alertInlineLinks`, inl);
	log(`${tag}.setupBanner`, await page.getByText(/Setup incomplete/).count());
	log(`${tag}.domain.gradients`, await gradScan(page));
	await shot(page, `${tag}-domain`);

	// 4. Trend chart (workspace analytics) + sender table
	for (const path of ['/analytics', `/domains/${d1.id}/analytics`]) {
		await go(page, path);
		const chart = await page.evaluate(() => {
			const svg = document.querySelector('figure svg[role=img]'); if (!svg) return null;
			const fig = svg.closest('figure');
			const texts = [...svg.querySelectorAll('text')].map((t) => { const b = t.getBoundingClientRect(); return { s: t.textContent, fs: getComputedStyle(t).fontSize, x: b.left, r: b.right, h: +b.height.toFixed(1) }; });
			const days = texts.slice(3).sort((a, b) => a.x - b.x); let overlaps = 0; for (let i = 1; i < days.length; i++) if (days[i].x < days[i - 1].r) overlaps++;
			const sb = svg.getBoundingClientRect(); const clippedLeft = texts.filter((t) => t.x < sb.left - 0.5).length; const clippedRight = texts.filter((t) => t.r > sb.right + 0.5).length;
			return { svgW: Math.round(sb.width), figW: Math.round(fig.getBoundingClientRect().width), viewBox: svg.getAttribute('viewBox'), fontSizes: [...new Set(texts.map((t) => t.fs))], glyphH: [...new Set(texts.map((t) => t.h))], labels: texts.length, dayLabels: days.map((d) => d.s), overlaps, clippedLeft, clippedRight };
		});
		log(`${tag}.chart${path}`, chart);
		const tbl = page.locator('div[role=region][aria-label="Sender inventory"]');
		if (await tbl.count()) {
			const before = await tbl.evaluate((e) => ({ cls: e.className.match(/border-[lr]-control/g), sw: e.scrollWidth, cw: e.clientWidth, bl: getComputedStyle(e).borderLeftColor, br: getComputedStyle(e).borderRightColor, bg: getComputedStyle(e).backgroundColor }));
			const cue = page.getByText('Scroll sideways to see every column.');
			const cueVis = await cue.isVisible();
			await tbl.evaluate((e) => { e.scrollLeft = e.scrollWidth; });
			await sleep(400);
			const after = await tbl.evaluate((e) => ({ cls: e.className.match(/border-[lr]-control/g), bl: getComputedStyle(e).borderLeftColor, br: getComputedStyle(e).borderRightColor }));
			const pageBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
			log(`${tag}.senders${path}`, { before, cueVisible: cueVis, after, hairlineVsTable: ratio(before.br, before.bg), hairlineVsPage: ratio(before.br, pageBg), noOverflowColour: ratio(before.bl, before.bg) });
			await shot(page, `${tag}-senders${path.replaceAll('/', '_')}`);
		}
		log(`${tag}.gradients${path}`, await gradScan(page));
	}
	// resize chart live (only at 1440 run): shrink to 375 and grow back
	if (w === 1440) {
		await go(page, '/analytics');
		await page.setViewportSize({ width: 375, height: 900 }); await sleep(600);
		const s1 = await page.evaluate(() => { const s = document.querySelector('figure svg[role=img]'); return s && { svgW: Math.round(s.getBoundingClientRect().width), fig: Math.round(s.closest('figure').getBoundingClientRect().width), docOverflow: document.documentElement.scrollWidth - innerWidth, fs: getComputedStyle(s.querySelector('text')).fontSize }; });
		await page.setViewportSize({ width: 1440, height: 900 }); await sleep(600);
		const s2 = await page.evaluate(() => { const s = document.querySelector('figure svg[role=img]'); return s && { svgW: Math.round(s.getBoundingClientRect().width), fig: Math.round(s.closest('figure').getBoundingClientRect().width) }; });
		log(`${tag}.chartResize`, { shrunk: s1, grown: s2 });
		// table toggle then back to chart (remount)
		const tb = page.getByRole('radio', { name: /Table/ }).or(page.getByRole('button', { name: /^Table$/ }));
		if (await tb.count()) { await tb.first().click(); await sleep(300); await page.getByRole('radio', { name: /Chart/ }).or(page.getByRole('button', { name: /^Chart$/ })).first().click(); await sleep(400);
			log(`${tag}.chartRemount`, await page.evaluate(() => { const s = document.querySelector('figure svg[role=img]'); return s && { svgW: Math.round(s.getBoundingClientRect().width), vb: s.getAttribute('viewBox') }; })); }
	}

	// 5. Settings checkboxes
	await go(page, '/settings');
	const pn = page.locator('#product-name');
	if (await pn.count()) {
		await pn.fill(`Prod ${tag}`); await page.getByRole('button', { name: 'Create product' }).click(); await sleep(1500);
		const firstDomainBox = page.getByRole('checkbox', { name: /example\.com/ }).first();
		if (await firstDomainBox.count()) { await firstDomainBox.click(); await sleep(1500); }
		const cbs = await page.evaluate(() => [...document.querySelectorAll('button[role=checkbox]')].map((b) => { const r = b.getBoundingClientRect(); const lab = b.closest('label'); const lr = lab?.getBoundingClientRect(); return { name: lab?.textContent.trim().slice(0, 30), w: r.width, h: r.height, rowH: lr && Math.round(lr.height), state: b.dataset.state, border: getComputedStyle(b).borderColor, bg: getComputedStyle(b).backgroundColor }; }));
		log(`${tag}.checkboxes`, { n: cbs.length, sizes: [...new Set(cbs.map((c) => `${c.w}x${c.h}`))], minRow: Math.min(...cbs.map((c) => c.rowH ?? 0)), sample: cbs.slice(0, 3), nativeInputs: await page.locator('input[type=checkbox]:not([aria-hidden=true])').count() });
		// keyboard: tab focus to an action checkbox and press Space
		const act = page.getByRole('checkbox', { name: 'resources:read' }).first();
		await act.focus(); const pre = await act.getAttribute('data-state'); await page.keyboard.press('Space'); await sleep(200); const post = await act.getAttribute('data-state');
		const focusRing = await act.evaluate((b) => { const c = getComputedStyle(b); return `${c.outlineStyle} ${c.outlineWidth} ${c.outlineColor} | ${c.boxShadow.slice(0, 60)}`; });
		await page.locator('label', { has: act }).locator('span').first().click(); await sleep(200); const post2 = await act.getAttribute('data-state');
		const tabStops = await page.evaluate(() => [...document.querySelectorAll('button[role=checkbox]')].every((b) => b.tabIndex === 0));
		const lbl = 'resources:read'; const name = null;
		log(`${tag}.checkboxKeyboard`, { pre, afterSpace: post, afterLabelClick: post2, focusVisible: focusRing, tabStops, accName: lbl });
		await shot(page, `${tag}-settings`);
	} else log(`${tag}.checkboxes`, 'section not rendered');
	log(`${tag}.settings.gradients`, await gradScan(page));
	await ctx.close();

	// 6. Member view
	const mctx = await ctxFor('member', theme, w);
	const mp = await mctx.newPage();
	await go(mp, '/');
	log(`${tag}.member.overview`, { continueSetup: await mp.getByRole('link', { name: /Continue setup/ }).count(), viewLinks: await mp.getByRole('link', { name: /View/ }).count(), readOnly: await mp.getByTestId('read-only-notice').count() });
	await shot(mp, `${tag}-member-overview`);
	await go(mp, `/domains/${d1.id}`);
	log(`${tag}.member.domain`, { setupBanner: await mp.getByText(/Setup incomplete/).count(), continueSetup: await mp.getByRole('link', { name: /Continue setup/ }).count(), upgrade: await mp.getByRole('link', { name: /Upgrade to/ }).count(), readOnly: await mp.getByTestId('read-only-notice').count() });
	await shot(mp, `${tag}-member-domain`);
	await mctx.close();
	await sleep(15000);
}

// Reduced motion skeleton
{
	const ctx = await ctxFor('owner', 'light', 1440, true); const page = await ctx.newPage();
	await page.route('**/api/domains**', async (route) => { await sleep(6000); await route.continue().catch(() => {}); });
	await page.goto(`${BASE}/#/w/${ws}/`); await page.evaluate((x) => sessionStorage.setItem(`ia_setup_redirected:${x}`, '1'), ws);
	await page.goto(`${BASE}/#/w/${ws}/`); await sleep(1000);
	const a = await page.evaluate(() => { const e = document.querySelector('.ia-pulse'); if (!e) return null; const c = getComputedStyle(e); const o1 = c.opacity; return { anim: c.animationName, op: o1, bg: c.backgroundColor, running: document.getAnimations().filter((x) => x.animationName === 'ia-pulse').length }; });
	await sleep(700);
	const b = await page.evaluate(() => { const e = document.querySelector('.ia-pulse'); return e && getComputedStyle(e).opacity; });
	log('reducedMotion.skeleton', { ...a, opacityLater: b });
	await ctx.close();
}
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
await browser.close();
console.log('REVIEWDONE');
