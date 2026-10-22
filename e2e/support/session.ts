// Sign in (or create the first owner) for the e2e specs and the screenshot script. The first-run owner can only be
// created once per database: set E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD when the instance already has one.
import { expect, type Page } from '@playwright/test';

export const EMAIL = process.env.E2E_OWNER_EMAIL ?? 'owner@e2e.test';
export const PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'e2e-password-123';

export async function signIn(page: Page) {
	await page.goto('/');
	const setup = page.getByRole('heading', { name: 'Create your account' });
	const signInHeading = page.getByRole('heading', { name: 'Sign in' });
	await expect(setup.or(signInHeading)).toBeVisible();
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
	await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "What's your main domain?" }))).toBeVisible();
}

/** The session token the dashboard keeps, for direct API calls. */
export const tokenOf = (page: Page) => page.evaluate(() => localStorage.getItem('ia_api_key') ?? '');
