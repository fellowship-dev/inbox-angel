// Screenshots of the agent surfaces at 1440 and 375, light and dark (devbox only, synthetic data).
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const O = 'https://localhost:8787';
const OUT = '/tmp/shots';
mkdirSync(OUT, { recursive: true });
const PASSWORD = 'local-e2e-password-1';
const browser = await chromium.launch();
const results = [];

for (const scheme of ['light', 'dark']) {
 for (const width of [1440, 375]) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: scheme, viewport: { width, height: 900 } });
  // The dashboard's own theme toggle: follow the scheme for this run.
  await context.addInitScript((s) => { try { localStorage.setItem('ia_theme', s); } catch {} }, scheme);
  const page = await context.newPage();
  const shot = async (name) => {
   const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
   const file = `${OUT}/${name}-${width}-${scheme}.png`;
   await page.screenshot({ path: file, fullPage: true });
   results.push({ file, overflow });
  };
  // Signed out consent link
  const reg = await context.request.post(O + '/oauth/register', { data: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
  const { client_id } = await reg.json();
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', scope: 'inbox-angel', resource: O + '/mcp', state: 'x', code_challenge: challenge, code_challenge_method: 'S256' });
  await page.goto(O + '/oauth/authorize?' + q);
  await shot('oauth-signed-out');
  // Sign in through the API (cookie lands in this context), then the consent page
  const login = await context.request.post(O + '/api/auth/login', { data: { email: 'owner@example.com', password: PASSWORD }, headers: { origin: O } });
  if (login.status() !== 200) throw new Error('login ' + login.status());
  await page.goto(O + '/oauth/authorize?' + q);
  await page.getByRole('heading', { name: /Allow Claude/ }).waitFor();
  await shot('oauth-consent');
  // Keyboard: focus ring on the first permission
  await page.getByRole('checkbox', { name: /Read email statistics/ }).focus();
  await page.screenshot({ path: `${OUT}/oauth-consent-focus-${width}-${scheme}.png` });
  // Agents page
  await page.goto(O + '/#/agents');
  await page.getByRole('heading', { name: 'Connect your assistant' }).waitFor();
  await page.waitForTimeout(400);
  await shot('agents-page');
  await page.goto(O + '/#/settings');
  await page.getByRole('heading', { name: 'Instance' }).waitFor();
  await page.waitForTimeout(400);
  await shot('settings');
  await context.close();
  await new Promise(r => setTimeout(r, 4000));
 }
}
await browser.close();
console.log(JSON.stringify(results, null, 1));
