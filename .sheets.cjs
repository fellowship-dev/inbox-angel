// Build one review contact sheet per screen: 1440 light | 1440 dark | 375 light | 375 dark.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const OUT = `${process.env.HOME}/shots`;
const SHEETS = `${process.env.HOME}/sheets`;
fs.mkdirSync(SHEETS, { recursive: true });
const names = [...new Set(fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).map((f) => f.split('--')[0]))].sort();
(async () => {
	const b = await chromium.launch();
	const p = await b.newPage({ viewport: { width: 1760, height: 900 } });
	for (const n of names) {
		const cell = (v, w) => fs.existsSync(`${OUT}/${n}--${v}.png`) ? `<figure style="width:${w}px"><figcaption>${v}</figcaption><img src="file://${OUT}/${n}--${v}.png" style="width:${w}px"></figure>` : `<figure style="width:${w}px"><figcaption>${v} MISSING</figcaption></figure>`;
		const html = `<html><body style="margin:0;padding:12px;background:#888;font:14px sans-serif"><h3 style="margin:0 0 8px">${n}</h3><div style="display:flex;gap:12px;align-items:flex-start">${cell('1440-light', 600)}${cell('1440-dark', 600)}${cell('375-light', 240)}${cell('375-dark', 240)}</div></body></html>`;
		fs.writeFileSync(`${SHEETS}/_s.html`, html);
		await p.goto(`file://${SHEETS}/_s.html`);
		await p.waitForTimeout(300);
		await p.screenshot({ path: `${SHEETS}/${n}.jpg`, fullPage: true, type: 'jpeg', quality: 70 });
	}
	await b.close();
	console.log('sheets', names.length);
})();
