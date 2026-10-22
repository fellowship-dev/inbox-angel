// Screenshots the built gallery (run `npm run build:gallery` first; `npm run screenshots` does both):
// light/dark × desktop/375px × views, written as WebP. Usage: node scripts/screenshots.mjs [outDir]
// Only overview-* and wizard-* desktop shots are committed (see .gitignore); the rest are for local review.
// Needs Chromium: PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
// Chromium has no WebP screenshot type, so re-encode the PNG through a canvas.
async function toWebp(page, png, quality = 0.8) {
	const b64 = await page.evaluate(
		async ([data, q]) => {
			const img = new Image();
			img.src = "data:image/png;base64," + data;
			await img.decode();
			const c = document.createElement("canvas");
			c.width = img.width;
			c.height = img.height;
			c.getContext("2d").drawImage(img, 0, 0);
			const blob = await new Promise((r) => c.toBlob(r, "image/webp", q));
			const buf = new Uint8Array(await blob.arrayBuffer());
			let bin = "";
			for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
			return btoa(bin);
		},
		[png.toString("base64"), quality],
	);
	return Buffer.from(b64, "base64");
}
async function shot(page, file, opts) {
	await writeFile(file, await toWebp(page, await page.screenshot(opts)));
	console.log(file);
}

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
				await shot(page, `${out}${view}-${theme}-${vpName}.webp`, { fullPage: true });
			}
			// Mobile drawer open
			if (vpName === "mobile") {
				await page.goto(`${base}?theme=${theme}#/overview`);
				await page.reload();
				await page.getByRole("button", { name: "Open navigation" }).click();
				await page.waitForTimeout(400);
				await shot(page, `${out}overview-drawer-${theme}-mobile.webp`, {});
			}
			await ctx.close();
		}
	}
} finally {
	await browser.close();
	server.kill();
}
