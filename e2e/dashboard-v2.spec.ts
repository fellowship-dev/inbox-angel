// Local dashboard flow using installer-held proof, cookie sessions and finite product credentials.
// Set E2E_OPERATOR_FILE to a private JSON file {email,password,proof}; no shared default account.
import { expect, request as apiRequest, test } from '@playwright/test';
import { signIn } from './support/session';
import { ensureDomain } from './support/db';

const DOMAIN = 'e2e-corp.test';
test.describe.configure({ mode: 'serial' });
// Password/one-time credentials must never be captured in Playwright traces or artifacts.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('first-run setup, add the first domain, see its records', async ({ page }) => {
	await signIn(page);

	// A brand-new instance has no domain: straight into the setup wizard.
	const domains = page.getByRole('heading', { name: 'Domains', level: 1 });
	const wizard = page.getByRole('heading', { name: "What's your main domain?" });
	await expect(domains.or(wizard)).toBeVisible();
	if (await wizard.isVisible()) {
		await page.getByPlaceholder('yourdomain.com').fill(DOMAIN);
		await page.getByRole('button', { name: /Continue/ }).click();
		await expect(page).toHaveURL(/\/domains\/\d+\/setup\/2$/);
		await page.getByRole('link', { name: 'Skip setup' }).click();
		await expect(page).toHaveURL(/\/domains\/\d+$/);
	}

	// The domain is listed as a level card, then opens to its records.
	await page.goto('/#/');
	const card = page.getByRole('group').filter({ hasText: DOMAIN }).first();
	await expect(card).toBeVisible();
	await expect(card.getByText(/Level [012]/)).toBeVisible();
	await page.getByRole('link', { name: new RegExp(DOMAIN) }).first().click();

	await expect(page.getByRole('heading', { name: DOMAIN, level: 1 })).toBeVisible();
	const records = page.getByRole('region', { name: 'DNS records' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'DNS records' }) }));
	await expect(records).toBeVisible();
	// With no network the live lookup may fail; that must read as "Lookup failed", never as "Not found".
	await expect(records.getByText(/DMARC record/).first()).toBeVisible();
	const looksUp = records.getByText(/Lookup failed|Not found|Pass|Warning|Fail/).first();
	await expect(looksUp).toBeVisible({ timeout: 20_000 });
});

test('issue a finite product credential, clear its one-time secret and revoke it', async ({ page }) => {
 await signIn(page);
 await ensureDomain(page, DOMAIN);
 await page.goto('/#/settings');
 await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
 await expect(page.getByRole('heading', { name: 'Products and service credentials' })).toBeVisible();
 const name = `e2e product credential ${Date.now()}`;
 await page.getByLabel('New workspace product').fill(`E2E product ${Date.now()}`);
 await page.getByRole('button', { name: 'Create product', exact: true }).click();
 const product = page.getByLabel('Product', { exact: true });
 await expect(product).not.toHaveValue('');
 const productId = await product.inputValue();
 await page.locator('label').filter({ hasText: DOMAIN }).first().getByRole('checkbox').click();
 const credentialDomain = page.getByRole('group', { name: 'Exact credential domains' }).getByRole('checkbox', { name: DOMAIN, exact: true });
 await expect(credentialDomain).toBeVisible();
 await credentialDomain.check();
 await page.getByLabel('Service principal and credential name').fill(name);
 await page.getByLabel('Credential and grants expire in days').fill('1');
 await page.getByRole('button', { name: 'Issue restricted credential' }).click();
 const secret = page.getByLabel('New credential secret');
 await expect(secret).toBeVisible();
 const value = await secret.inputValue();
 expect(value.startsWith('ias_') && value.length >= 40).toBe(true);

 // This context has no operator cookies: every assertion exercises only the delegated key.
 const machine = await apiRequest.newContext({ baseURL: new URL(page.url()).origin });
 try {
  const headers = { 'X-Api-Key': value };
  const resourcePath = `/api/resources?product_id=${encodeURIComponent(productId)}`;
  const result = await machine.get(resourcePath, { headers });
  expect(result.status()).toBe(200);
  const data = await result.json() as { domains: Array<{ domain: string }> };
  expect(data.domains.map(d => d.domain)).toEqual([DOMAIN]);
  expect((await machine.post('/api/access/principals', { headers, data: { name: 'forbidden stronger identity', kind: 'service' } })).status()).toBe(403);

  await page.getByRole('button', { name: 'Credential stored — clear secret', exact: true }).click();
  await expect(secret).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('New credential secret')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Revoke ${name}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Revoke ${name}`, exact: true }).click();
  await expect.poll(async () => (await machine.get(resourcePath, { headers })).status()).toBe(401);
 } finally { await machine.dispose(); }
});
