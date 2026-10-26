import { test, expect } from '@playwright/test';
import { operatorCredentials } from './support/session';

// Run only on an isolated local installation. Secrets come from a private file,
// never arguments, reporter output, screenshots, storageState, or traces.
test.use({ ignoreHTTPSErrors: true, trace: 'off', video: 'off' });
test('operator enrollment, finite product access, revocation and responsive reports', async ({ page, playwright }) => {
  test.skip(!process.env.E2E_OPERATOR_FILE, 'Requires a private operator file and isolated Worker');
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const operator = operatorCredentials();
  const serviceName = `Acceptance service ${Date.now()}`;
  const origin = new URL(process.env.E2E_BASE_URL!).origin;
  expect(['127.0.0.1', 'localhost']).toContain(new URL(origin).hostname);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Create your account|Sign in/ })).toBeVisible();
  const setup = await page.getByLabel('Installer proof').count() > 0;
  // Browser evaluation keeps sensitive field values out of locator error reports.
  await page.evaluate(({ email, password, proof, setup }) => {
    const values: Record<string, string> = { email, password, ...(setup ? { confirm: password, 'bootstrap-proof': proof } : {}) };
    for (const [id, value] of Object.entries(values)) {
      const field = document.getElementById(id) as HTMLInputElement;
      if (!field) throw new Error('Authentication field missing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, { ...operator, setup });
  await page.getByRole('button', { name: setup ? 'Create account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "What's your main domain?" }))).toBeVisible();
  const enrolled = await page.request.post('/api/domains', { headers: { Origin: origin }, data: { domain: 'agent-platform.test' } });
  expect(enrolled.ok()).toBe(true);
  const result = await enrolled.json();
  const id = result.domain.id;
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Agents and product access' })).toBeVisible();
  await page.getByLabel('New workspace product').fill('Acceptance product');
  await page.getByRole('button', { name: 'Create product', exact: true }).click();
  await expect(page.getByLabel('Product', { exact: true })).not.toHaveValue('');
  const productId = await page.getByLabel('Product', { exact: true }).inputValue();
  // Mapping is persisted before the controlled checkbox re-renders.
  await page.getByRole('checkbox', { name: /^agent-platform\.test/ }).first().click();
  await expect(page.getByRole('group', { name: 'Exact credential domains' }).getByLabel('agent-platform.test')).toBeVisible();
  await page.getByRole('group', { name: 'Exact credential domains' }).getByLabel('agent-platform.test').check();
  await page.getByLabel('Service principal and credential name').fill(serviceName);
  await page.getByRole('button', { name: 'Issue restricted credential' }).click();
  const secret = page.getByLabel('New credential secret');
  await expect(secret).toBeVisible();
  await expect(secret).toHaveAttribute('type', 'password');
  const credential = await secret.inputValue();
  const machine = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true, extraHTTPHeaders: { Authorization: `Bearer ${credential}` } });
  const allowed = await machine.get(`/api/resources?product_id=${productId}`);
  expect(allowed.status()).toBe(200);
  expect((await allowed.json()).domains.map((d: { domain: string }) => d.domain)).toEqual(['agent-platform.test']);
  await page.getByRole('button', { name: 'Credential stored — clear secret' }).click();
  await expect(secret).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/inbox-agent-settings-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: `Revoke ${serviceName}`, exact: true }).click();
  await expect.poll(async () => (await machine.get('/api/resources')).status()).toBe(401);
  await machine.dispose();
  await page.goto(`/#/domains/${id}`);
  await expect(page.getByRole('heading', { name: 'Email health report', exact: true })).toBeVisible();
  await expect(page.getByText('Inbox placement', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/inbox-agent-report-mobile.png', fullPage: true });
  const registered = await page.request.post('/oauth/register', { data: {
    client_name: 'Local acceptance client', redirect_uris: ['https://client.example/callback'],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  } });
  expect(registered.status()).toBe(201);
  const { client_id } = await registered.json();
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://client.example/callback', scope: 'inbox-angel', resource: origin + '/mcp', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256' });
  await page.goto('/oauth/authorize?' + query);
  await expect(page.getByRole('heading', { name: 'Authorize Inbox Angel agent' })).toBeVisible();
  const permission = page.getByRole('checkbox', { name: 'reports:read', exact: true });
  await permission.focus();
  await page.keyboard.press('Space');
  await expect(permission).toBeChecked();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/inbox-agent-consent-${width}.png`, fullPage: true });
  }
});
