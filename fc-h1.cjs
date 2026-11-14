// Stage 1: website link -> sign-up with the domain carried over -> check your email
const { open } = require('./fc-h-lib.cjs');
(async () => {
  const vw = +process.env.VW; const acct = process.env.ACCT; const email = process.env.EMAIL; const dom = process.env.DOM;
  const { page, snap, done, sleep, H } = await open(vw, acct);
  const t0 = Date.now();
  await page.goto(`${H}/#/signup?domain=${dom}`, { waitUntil: 'domcontentloaded' }); await sleep(3500);
  await snap('e1-signup', `landing ${Date.now() - t0}ms`);
  // empty submit to see validation
  await page.getByRole('button', { name: 'Create account' }).click(); await sleep(500);
  await snap('e1b-signup-empty-submit');
  await page.getByLabel('Your name (optional)').fill('Walk Tester');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Walk-test-pass-1');
  await page.getByLabel('Confirm password').fill('Walk-test-pass-1');
  // wait for the bot check token
  for (let i = 0; i < 20; i++) { const v = await page.locator('input[name=cf-turnstile-response]').inputValue().catch(() => ''); if (v) break; await sleep(500); }
  console.log('turnstile token present:', !!(await page.locator('input[name=cf-turnstile-response]').inputValue().catch(() => '')));
  await snap('e1c-signup-filled');
  const t1 = Date.now();
  await page.getByRole('button', { name: 'Create account' }).click(); await sleep(3500);
  await snap('e2-check-email', `after submit ${Date.now() - t1}ms`);
  await done();
})().catch(e => { console.log('FATAL', String(e).slice(0, 800)); process.exit(1); });
