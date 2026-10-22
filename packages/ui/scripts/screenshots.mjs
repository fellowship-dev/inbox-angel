// Screenshots the built gallery: light/dark × desktop/375px × views. Usage: node scripts/screenshots.mjs [outDir]
// Needs Chromium: PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const out = new URL(process.argv[2] ?? "../gallery/screenshots/", import.meta.url).pathname;
const port = 5199;
await mkdir(out, { recursive: true });

const server = spawn("npx", ["vite", "preview", "--config", "gallery/vite.config.ts", "--port", String(port), "--strictPort"], { stdio: "ignore" });
const base = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 50; i++) {
	try { if ((await fetch(base)).ok) break; } catch {}
	await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const views = ["components", "overview", "wizard"];
const viewports = { desktop: { width: 1280, height: 900 }, mobile: { width: 375, height: 800 } };
try {
	for (const theme of ["light", "dark"]) {
		for (const [vpName, viewport] of Object.entries(viewports)) {
			const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: theme });
			const page = await ctx.newPage();
			for (const view of views) {
				await page.goto(`${base}?theme=${theme}#/${view}`);
				await page.reload();
				await page.evaluate(() => document.fonts.ready);
				await page.waitForTimeout(250);
				const file = `${out}${view}-${theme}-${vpName}.png`;
				await page.screenshot({ path: file, fullPage: true });
				console.log(file);
			}
			// Mobile drawer open
			if (vpName === "mobile") {
				await page.goto(`${base}?theme=${theme}#/overview`);
				await page.reload();
				await page.getByRole("button", { name: "Open navigation" }).click();
				await page.waitForTimeout(400);
				await page.screenshot({ path: `${out}overview-drawer-${theme}-mobile.png` });
			}
			await ctx.close();
		}
	}
} finally {
	await browser.close();
	server.kill();
}
