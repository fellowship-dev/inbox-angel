const { chromium } = require('@playwright/test');
const fs = require('fs');
const OUT = process.env.HOME + '/fc/out'; fs.mkdirSync(OUT + '/shots', { recursive: true }); fs.mkdirSync(OUT + '/text', { recursive: true });
const H = process.env.H || 'https://localhost:8787';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function open(vw, stateName) {
  const browser = await chromium.launch();
  const sf = `${OUT}/state-${stateName}.json`;
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: vw, height: vw === 375 ? 812 : 900 }, deviceScaleFactor: 1, ...(fs.existsSync(sf) ? { storageState: sf } : {}) });
  const page = await ctx.newPage(); const net = []; const errs = [];
  page.on('response', r => { const u = r.url(); if (u.startsWith(H) && (u.includes('/api/') || u.includes('/oauth') || u.includes('/mcp')) ) net.push(r.request().method() + ' ' + u.replace(H, '').slice(0, 90) + ' ' + r.status()); });
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
  const steps = [];
  const snap = async (name, note) => {
    const f = `h-${name}-${vw}`;
    await page.screenshot({ path: `${OUT}/shots/${f}.jpg`, type: 'jpeg', quality: 62 }).catch(() => {});
    await page.screenshot({ path: `${OUT}/shots/${f}-full.jpg`, type: 'jpeg', quality: 45, fullPage: true }).catch(() => {});
    const info = await page.evaluate(() => {
      const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const t = e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 70);
      return { url: location.href, title: document.title,
        links: [...document.querySelectorAll('a[href]')].filter(vis).map(a => t(a) + ' => ' + a.getAttribute('href')).slice(0, 50),
        buttons: [...document.querySelectorAll('button')].filter(vis).map(b => t(b) + (b.disabled ? ' [disabled]' : '')).slice(0, 50),
        inputs: [...document.querySelectorAll('input,textarea,select')].filter(vis).map(i => (i.type || i.tagName) + ':' + (i.name || i.id) + ':' + (i.placeholder || '') + ':' + ((i.labels && i.labels[0] && i.labels[0].innerText) || i.getAttribute('aria-label') || '') + '=' + (i.type === 'password' ? '***' : i.value)),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, text: document.body.innerText };
    }).catch(e => ({ evalError: String(e).slice(0, 200) }));
    fs.writeFileSync(`${OUT}/text/${f}.txt`, info.text || '');
    const s = { vw, name, note, shot: f, ...info, ia: ((info.text || '').match(/inbox ?angel/gi) || []).length, net: net.splice(0), errs: errs.splice(0) };
    steps.push(s);
    console.log(`\n===== [${vw}] ${name} ${note || ''}\nURL ${s.url} | title ${s.title} | overflow ${s.overflow} | "Inbox Angel" x${s.ia}\nTEXT:\n${(info.text || '').slice(0, +(process.env.TXT || 1500))}\nBUTTONS: ${(s.buttons || []).join(' | ')}\nINPUTS: ${(s.inputs || []).join(' | ')}\nLINKS: ${(s.links || []).join(' | ')}\nNET: ${s.net.join(' ; ')}\nERRS: ${s.errs.join(' ; ')}`);
    return s;
  };
  const done = async () => { await ctx.storageState({ path: sf }); const jf = `${OUT}/h-steps.jsonl`; for (const s of steps) { delete s.text; fs.appendFileSync(jf, JSON.stringify(s) + '\n'); } await browser.close(); };
  return { browser, ctx, page, snap, done, sleep, H, OUT };
}
module.exports = { open, sleep, H, OUT };
