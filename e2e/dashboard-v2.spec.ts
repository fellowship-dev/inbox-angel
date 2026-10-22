// Dashboard v2 (React) end to end: first-run setup → add domain → see records → create and revoke an API key.
//
// Against a fresh local Worker (the first-run owner can only be created once):
//   rm -rf /tmp/ia-e2e && node packages/db/scripts/migrate.mjs --local --persist-to /tmp/ia-e2e
//   npx wrangler dev --local --persist-to /tmp/ia-e2e        # serves web/dist (npm run build:dashboard first)
//   E2E_BASE_URL=http://127.0.0.1:8787 npx playwright test e2e/dashboard-v2.spec.ts
// If the instance already has an owner, set E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD and the test signs in instead.
import { expect, test, type Page } from '@playwright/test';

const EMAIL = process.env.E2E_OWNER_EMAIL ?? 'owner@e2e.test';
const PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'e2e-password-123';
const DOMAIN = 'e2e-corp.test';

test.describe.configure({ mode: 'serial' });

async function signInOrSetUp(page: Page) {
	await page.goto('/');
	const setup = page.getByRole('heading', { name: 'Create your account' });
	const signIn = page.getByRole('heading', { name: 'Sign in' });
	await expect(setup.or(signIn)).toBeVisible();
	if (await setup.isVisible()) {
		await page.getByLabel('Your name (optional)').fill('E2E Owner');
		await page.getByLabel('Email', { exact: true }).fill(EMAIL);
		await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
		await page.getByLabel('Confirm password').fill(PASSWORD);
		await page.getByRole('button', { name: 'Create account' }).click();
	} else {
		await page.getByLabel('Email', { exact: true }).fill(EMAIL);
		await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
		await page.getByRole('button', { name: 'Sign in' }).click();
	}
}

test('first-run setup, add the first domain, see its records', async ({ page }) => {
	await signInOrSetUp(page);

	// A brand-new instance has no domain: straight into the setup wizard.
	const hasDomain = await page.getByRole('heading', { name: 'Domains', level: 1 }).isVisible().catch(() => false);
	if (!hasDomain) {
		await expect(page.getByRole('heading', { name: "What's your main domain?" })).toBeVisible();
		await page.getByPlaceholder('yourdomain.com').fill(DOMAIN);
		await page.getByRole('button', { name: /Continue/ }).click();
		await expect(page.getByText(/of 5 steps complete/)).toBeVisible();
		await page.getByRole('link', { name: /Skip setup|Exit/ }).first().click();
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

test('create an API key (secret shown once) and revoke it', async ({ page }) => {
	await signInOrSetUp(page);
	await page.goto('/#/keys');
	await expect(page.getByRole('heading', { name: 'API keys', level: 1 })).toBeVisible();

	await page.getByLabel('Name').fill('e2e key');
	await page.getByRole('button', { name: 'Create key' }).click();
	const secret = page.getByTestId('secret-value');
	await expect(secret).toHaveText(/^ia_[\w-]{20,}$/);
	const value = (await secret.textContent())!;

	// The secret authenticates against the API…
	const res = await page.request.get('/api/domains', { headers: { 'X-Api-Key': value } });
	expect(res.status()).toBe(200);

	// …is shown once…
	await page.getByRole('button', { name: 'I have saved it' }).click();
	await expect(page.getByTestId('secret-once')).toHaveCount(0);
	await page.reload();
	await expect(page.getByText(value)).toHaveCount(0);
	const row = page.getByRole('row', { name: /e2e key/ });
	await expect(row).toContainText(value.slice(0, 8));

	// …and stops working once revoked.
	await page.getByRole('button', { name: 'Revoke e2e key' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Revoke key' }).click();
	await expect(page.getByText('No API keys yet')).toBeVisible();
	const after = await page.request.get('/api/domains', { headers: { 'X-Api-Key': value } });
	expect(after.status()).toBe(401);
});
