// Stage 2: open the emailed link -> choose password -> first screen after verification -> add domain -> claim card
const { open, OUT } = require('./fc-h-lib.cjs');
const fs = require('fs'); const path = require('path'); const cp = require('child_process');
(async () => {
  const vw = +process.env.VW; const acct = process.env.ACCT; const email = process.env.EMAIL;
  const files = cp.execSync('find /tmp -path "*email-text*" -name "*.txt" 2>/dev/null').toString().trim().split('\n').filter(Boolean).map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  const mail = fs.readFileSync(files[0].f, 'utf8');
  const link = (mail.match(/https?:\/\/\S+/) || [])[0];
  console.log('EMAIL TEXT (link redacted):\n' + mail.replace(/https?:\/\/\S+/, m => m.replace(/token=[^&\s]+/, 'token=***')));
  const { page, snap, done, sleep, H } = await open(vw, acct);
  await page.goto(link, { waitUntil: 'domcontentloaded' }); await sleep(2500);
  const s = await snap('e3-after-email-link'); 
  // choose password page
  const pw = page.locator('input[type=password]');
  const n = await pw.count(); console.log('password fields on this page:', n);
  for (let i = 0; i < n; i++) await pw.nth(i).fill('Walk-test-pass-1');
  if (n) { await page.locator('button[type=submit]').first().click(); await sleep(3000); await snap('e4-after-set-password'); }
  // if we are sent to sign-in, sign in
  if (await page.getByRole('heading', { name: 'Sign in' }).count()) {
    await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill('Walk-test-pass-1');
    for (let i = 0; i < 20; i++) { const v = await page.locator('input[name=cf-turnstile-response]').inputValue().catch(() => 'x'); if (v) break; await sleep(500); }
    await snap('e4b-signin-filled');
    await page.getByRole('button', { name: 'Sign in' }).click(); await sleep(3500);
    await snap('e5-first-screen-after-signin');
  }
  await done();
})().catch(e => { console.log('FATAL', String(e).slice(0, 800)); process.exit(1); });
