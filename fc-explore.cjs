const { chromium } = require('@playwright/test');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await p.goto('https://localhost:8787/#/signup?domain=github.com', { waitUntil: 'domcontentloaded', timeout: 15000 }); await p.waitForTimeout(4000);
  console.log(await p.title()); console.log(await p.evaluate(() => document.body.innerText));
  console.log(await p.evaluate(() => [...document.querySelectorAll('input,button,a,iframe')].map(e => e.tagName + ':' + (e.type || '') + ':' + (e.name || e.id || '') + ':' + (e.innerText || e.placeholder || e.src || '').slice(0, 60) + ':' + (e.getAttribute('href') || '')).join('\n')));
  console.log('errs', errs);
  await p.screenshot({ path: process.env.HOME + '/fc/explore.jpg', type: 'jpeg', quality: 50 });
  await b.close();
})().catch(e => { console.log('FATAL', String(e).slice(0, 600)); process.exit(1); });
