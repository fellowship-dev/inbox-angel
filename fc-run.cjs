// Generic action runner: node fc-run.cjs <actions.json>; env VW, ACCT
const { open } = require('./fc-h-lib.cjs');
const fs = require('fs');
(async () => {
  const acts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { page, ctx, snap, done, sleep, H } = await open(+process.env.VW, process.env.ACCT);
  const loc = a => a.role ? page.getByRole(a.role, { name: a.re ? new RegExp(a.name, 'i') : a.name, exact: !!a.exact }) : a.label ? page.getByLabel(a.label, { exact: !!a.exact }) : a.text ? page.getByText(a.text, { exact: !!a.exact }) : page.locator(a.sel);
  for (const a of acts) {
    try {
      if (a.do === 'goto') { await page.goto('about:blank'); await page.goto(a.url.startsWith('http') ? a.url : H + a.url, { waitUntil: 'domcontentloaded' }); await sleep(a.wait || 2500); }
      else if (a.do === 'click') { const l = loc(a).nth(a.nth || 0); if (a.optional && !(await l.count())) { console.log('  (skip, not found) ' + JSON.stringify(a)); continue; } await l.click({ timeout: 8000 }); await sleep(a.wait || 1500); }
      else if (a.do === 'fill') { await loc(a).nth(a.nth || 0).fill(a.value, { timeout: 8000 }); }
      else if (a.do === 'fillFile') { await loc(a).nth(a.nth || 0).fill(JSON.parse(fs.readFileSync(a.file.replace('~', process.env.HOME), 'utf8'))[a.key], { timeout: 8000 }); }
      else if (a.do === 'newtab') { await page.evaluate(() => sessionStorage.clear()).catch(() => {}); }
      else if (a.do === 'press') { await page.keyboard.press(a.key); await sleep(a.wait || 800); }
      else if (a.do === 'snap') { await snap(a.name, a.note); }
      else if (a.do === 'wait') { await sleep(a.ms); }
      else if (a.do === 'turnstile') { for (let i = 0; i < 24; i++) { const v = await page.locator('input[name=cf-turnstile-response]').inputValue().catch(() => 'x'); if (v) break; await sleep(500); } }
      else if (a.do === 'api') { const r = await page.evaluate(async ({ m, u, b }) => { const r = await fetch(u, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return r.status + ' ' + (await r.text()).slice(0, 400); }, { m: a.method || 'GET', u: a.url, b: a.body }); console.log(`  API ${a.method || 'GET'} ${a.url} -> ${r}`); }
      else if (a.do === 'eval') { console.log('  EVAL ' + JSON.stringify(await page.evaluate(a.js)).slice(0, 1500)); }
    } catch (e) { console.log('  ACTION FAILED ' + JSON.stringify(a).slice(0, 120) + ' :: ' + String(e).split('\n')[0].slice(0, 200)); if (!a.optional) await snap('fail-' + (a.name || a.do), 'state at failure'); }
  }
  await done();
})().catch(e => { console.log('FATAL', String(e).slice(0, 800)); process.exit(1); });
