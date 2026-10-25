// Design evidence: screenshots + raw checks of the built gallery, against a running server.
// Usage: node scripts/evidence.mjs <label> <outRoot> [baseUrl]   (baseUrl default http://127.0.0.1:8787/)
// Needs Chromium (PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium) and a served
// gallery (`npm run build:gallery && npx vite preview --config gallery/vite.config.ts --port 8787`).
// Output: <outRoot>/<label>/<route>-<theme>-<width>[-long].png and checks.json. Fixtures are synthetic (.test).
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const [label = "after", outRoot = "/tmp/design-evidence", baseArg] = process.argv.slice(2);
const base = baseArg ?? "http://127.0.0.1:8787/";
const out = `${outRoot}/${label}`;
await mkdir(out, { recursive: true });
const axeSrc = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const routes = ["signin", "setup-owner", "overview-empty", "overview", "wizard", "loading", "error"];
const widths = { 375: 800, 768: 1024, 1440: 900 };
const results = { label, base, shots: [], overflow: [], axe: [], keyboard: {}, drawer: {}, copy: {}, labels: [] };
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
	for (const theme of ["light", "dark"]) {
		for (const [w, h] of Object.entries(widths)) {
			const ctx = await browser.newContext({ viewport: { width: +w, height: h }, reducedMotion: "reduce", colorScheme: theme, permissions: ["clipboard-read", "clipboard-write"] });
			const page = await ctx.newPage();
			for (const fixture of ["", "long"]) {
				for (const route of routes) {
					const url = `${base}?theme=${theme}${fixture ? `&fixture=${fixture}` : ""}#/${route}`;
					await page.goto(url);
					await page.reload();
					await page.evaluate(() => document.fonts.ready);
					await page.waitForTimeout(300);
					const name = `${route}-${theme}-${w}${fixture ? `-${fixture}` : ""}`;
					if (!fixture || theme === "light") {
						await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
						results.shots.push({ name, url });
					}
					const m = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
					results.overflow.push({ name, url, ...m, ok: m.scrollWidth <= m.clientWidth });
					if (!fixture) {
						await page.evaluate(axeSrc);
						const ax = await page.evaluate(async () => {
							const r = await window.axe.run(document, { rules: { region: { enabled: false } } });
							return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(" ")) }));
						});
						results.axe.push({ name, url, violations: ax });
						const unlabeled = await page.evaluate(() =>
							[...document.querySelectorAll("input,select,textarea,button,[role=combobox],[role=switch],[role=checkbox]")]
								.filter((el) => !(el.labels?.length || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.textContent?.trim()))
								.map((el) => el.outerHTML.slice(0, 100)),
						);
						results.labels.push({ name, unlabeled });
					}
				}
			}
			if (theme === "light") {
				// Keyboard: tab order on sign-in, focus ring screenshot.
				await page.goto(`${base}?theme=light#/signin`);
				await page.reload();
				await page.waitForTimeout(200);
				const seq = [];
				for (let i = 0; i < 9; i++) {
					await page.keyboard.press("Tab");
					seq.push(await page.evaluate(() => { const a = document.activeElement; return `${a?.tagName.toLowerCase()}${a?.id ? "#" + a.id : ""}${a?.getAttribute("aria-label") ? `[${a.getAttribute("aria-label")}]` : ""} "${(a?.textContent ?? "").trim().slice(0, 24)}" outline=${getComputedStyle(a).outlineStyle} ${getComputedStyle(a).outlineWidth}`; }));
					if (i === 5) await page.screenshot({ path: `${out}/focus-signin-light-${w}.png` });
				}
				results.keyboard[w] = seq;
				if (+w === 375) {
					// Mobile drawer: open, focus trapped inside, Escape restores focus to trigger.
					await page.goto(`${base}?theme=light#/overview`);
					await page.reload();
					const trigger = page.getByRole("button", { name: "Open navigation" });
					await trigger.click();
					await page.waitForTimeout(400);
					await page.screenshot({ path: `${out}/drawer-overview-light-375.png` });
					const inDialog = await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"));
					await page.keyboard.press("Tab");
					await page.keyboard.press("Tab");
					const stillIn = await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"));
					const current = await page.evaluate(() => document.querySelector("[role=dialog] [aria-current=page]")?.textContent);
					await page.keyboard.press("Escape");
					await page.waitForTimeout(300);
					const restored = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
					results.drawer = { focusMovedIntoDialog: inDialog, focusTrapped: stillIn, currentItem: current, closedByEscape: !(await page.locator("[role=dialog]").count()), focusRestoredTo: restored };
				}
				if (+w === 1440) {
					// Copy feedback on the DNS record step.
					await page.goto(`${base}?theme=light#/wizard`);
					await page.reload();
					await page.waitForTimeout(200);
					const btn = page.getByRole("button", { name: "Copy value" }).first();
					await btn.click();
					await page.waitForTimeout(250);
					const live = await page.locator("[role=status]", { hasText: "Copied" }).count();
					const clip = await page.evaluate(() => navigator.clipboard.readText());
					await page.screenshot({ path: `${out}/copy-feedback-wizard-light-1440.png` });
					results.copy = { liveRegionAnnounced: live > 0, clipboardMatchesRecord: clip.startsWith("v=DMARC1"), clipboardPrefix: clip.slice(0, 12) };
				}
			}
			await ctx.close();
		}
	}
} finally {
	await browser.close();
}
const bad = results.overflow.filter((o) => !o.ok);
results.summary = {
	screenshots: results.shots.length,
	overflowChecks: results.overflow.length,
	overflowFailures: bad.map((b) => b.name),
	axePages: results.axe.length,
	axeViolationPages: results.axe.filter((a) => a.violations.length).map((a) => ({ name: a.name, ids: a.violations.map((v) => v.id) })),
	unlabeled: results.labels.filter((l) => l.unlabeled.length).map((l) => l.name),
};
await writeFile(`${out}/checks.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.summary, null, 2));
