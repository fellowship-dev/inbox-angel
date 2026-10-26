// Workspaces end to end — Max's scenario:
//   1. Max has one login (owner of the default workspace, "Fellowship").
//   2. He creates "Lexgo" and gives it two domains.
//   3. He invites a Lexgo coworker as a read-only member; they log in and see only Lexgo.
//   4. Max switches between Fellowship and Lexgo (and the URL keeps the context across a reload).
//
// Against a fresh local Worker (the first-run owner can only be created once):
//   rm -rf /tmp/ia-e2e && node packages/db/scripts/migrate.mjs --local --persist-to /tmp/ia-e2e
//   npm run build:dashboard && npx wrangler dev --local --persist-to /tmp/ia-e2e --port 8787
//   npx playwright test e2e/workspaces.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { runSql } from './support/db';
import { signIn } from './support/session';

test.describe.configure({ mode: 'serial' });

const FELLOWSHIP_DOMAIN = 'fellowship-e2e.test';
const LEXGO_DOMAINS = ['lexgo-one-e2e.test', 'lexgo-two-e2e.test'];
const COWORKER = 'coworker@lexgo.test';
const COWORKER_PASSWORD = 'coworker-password-1';

let lexgoId = '';
let inviteLink = '';

const workspaceButton = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^Workspace: ${name}\\.`) });

async function openSwitcher(page: Page) {
	await page.getByRole('button', { name: /^Workspace: .*Switch workspace$/ }).click();
	return page.getByRole('menu');
}

test('Max creates the Lexgo workspace from the switcher and lands on its empty state', async ({ page }) => {
	await signIn(page);
	// the default workspace has a domain of its own
	runSql(`INSERT OR IGNORE INTO domains (workspace_id, domain, rua_address) VALUES ('ws_default', '${FELLOWSHIP_DOMAIN}', 'rua@reports.e2e.test');`);
	await page.goto('/');
	await expect(workspaceButton(page, 'Default')).toBeVisible();
	await expect(page).toHaveURL(/#\/w\/ws_default\//);

	const menu = await openSwitcher(page);
	await menu.getByRole('menuitem', { name: 'Create workspace' }).click();
	await page.getByLabel('Workspace name').fill('Lexgo');
	await page.getByRole('button', { name: 'Create workspace' }).click();

	await expect(workspaceButton(page, 'Lexgo')).toBeVisible();
	await expect(page).toHaveURL(/#\/w\/ws_[0-9a-f]{32}\//);
	await expect(page.getByText('No domains yet')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Add your first domain' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Connect Cloudflare' })).toBeVisible();

	const list = (await (await page.request.get('/api/workspaces')).json()).workspaces as Array<{ id: string; name: string }>;
	lexgoId = list.find((w) => w.name === 'Lexgo')!.id;
	expect(lexgoId).toMatch(/^ws_/);
});

test('Lexgo gets two domains; Max sees them there and not in Fellowship', async ({ page }) => {
	await signIn(page);
	for (const d of LEXGO_DOMAINS) runSql(`INSERT OR IGNORE INTO domains (workspace_id, domain, rua_address) VALUES ('${lexgoId}', '${d}', 'rua@reports.lexgo.test');`);
	await page.goto(`/#/w/${lexgoId}/`);
	for (const d of LEXGO_DOMAINS) await expect(page.getByText(d).first()).toBeVisible();
	await expect(page.getByText(FELLOWSHIP_DOMAIN)).toHaveCount(0);
});

test('Max invites a Lexgo coworker as a read-only member', async ({ page }) => {
	await signIn(page);
	await page.goto(`/#/w/${lexgoId}/members`);
	await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
	await expect(page.getByText(/Lexgo: everyone here can see all of its domains/)).toBeVisible();
	await page.getByLabel('Email').fill(COWORKER);
	await page.getByRole('button', { name: 'Create invite link' }).click();
	inviteLink = (await page.getByTestId('invite-link').textContent())!.trim();
	expect(inviteLink).toContain('#/invite/');
});

test('the coworker accepts, logs in, and sees only Lexgo — read-only', async ({ browser }) => {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto(inviteLink);
	await expect(page.getByText('Lexgo').first()).toBeVisible();
	await page.getByLabel('Your name').fill('Coworker');
	await page.getByLabel('Password', { exact: true }).fill(COWORKER_PASSWORD);
	await page.getByLabel('Confirm password').fill(COWORKER_PASSWORD);
	await page.getByRole('button', { name: 'Accept invite' }).click();

	await expect(workspaceButton(page, 'Lexgo')).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`#/w/${lexgoId}/`));
	for (const d of LEXGO_DOMAINS) await expect(page.getByText(d).first()).toBeVisible();
	await expect(page.getByText(FELLOWSHIP_DOMAIN)).toHaveCount(0);
	// read-only: the notice shows, and the add button is locked
	await expect(page.getByText(/read-only/i).first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Add domain' })).toBeDisabled();

	// the switcher has exactly one workspace in it
	const menu = await openSwitcher(page);
	await expect(menu.getByRole('menuitem', { name: /Lexgo/ })).toBeVisible();
	await expect(menu.getByRole('menuitem', { name: /Default|Fellowship/ })).toHaveCount(0);
	// self-host: only the instance owner can create workspaces, so the coworker is not offered it
	await expect(menu.getByRole('menuitem', { name: 'Create workspace' })).toHaveCount(0);
	await page.keyboard.press('Escape');

	// pointing the dashboard at Fellowship gets the coworker nowhere: a notice, and back to Lexgo
	const direct = await page.request.get('/api/domains', { headers: { 'X-Workspace-Id': 'ws_default' } });
	expect(direct.status()).toBe(403);
	await page.goto('/#/w/ws_default/');
	await expect(page).toHaveURL(new RegExp(`#/w/${lexgoId}/`));
	await expect(page.getByText(FELLOWSHIP_DOMAIN)).toHaveCount(0);

	// signing in again lands on Lexgo too
	await page.evaluate(() => localStorage.clear());
	await ctx.clearCookies();
	await page.goto('/');
	await page.getByLabel('Email', { exact: true }).fill(COWORKER);
	await page.getByLabel('Password', { exact: true }).fill(COWORKER_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(workspaceButton(page, 'Lexgo')).toBeVisible();
	await ctx.close();
});

test('Max switches between Fellowship and Lexgo, and a reload keeps his place', async ({ page }) => {
	await signIn(page);
	await page.goto(`/#/w/${lexgoId}/`);
	await expect(page.getByText(LEXGO_DOMAINS[0]).first()).toBeVisible();

	let menu = await openSwitcher(page);
	await expect(menu.getByRole('menuitem', { name: /Lexgo.*owner/ })).toHaveAttribute('aria-current', 'true');
	await menu.getByRole('menuitem', { name: /Default.*owner/ }).click();
	await expect(page).toHaveURL(/#\/w\/ws_default\//);
	await expect(page.getByText(FELLOWSHIP_DOMAIN).first()).toBeVisible();
	await expect(page.getByText(LEXGO_DOMAINS[0])).toHaveCount(0);

	await page.reload();
	await expect(page.getByText(FELLOWSHIP_DOMAIN).first()).toBeVisible();
	await expect(page).toHaveURL(/#\/w\/ws_default\//);

	menu = await openSwitcher(page);
	await menu.getByRole('menuitem', { name: /Lexgo/ }).click();
	await expect(page.getByText(LEXGO_DOMAINS[1]).first()).toBeVisible();
	await expect(page.getByText(FELLOWSHIP_DOMAIN)).toHaveCount(0);

	// Lexgo's members page lists the coworker; Fellowship's does not
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Members' }).click();
	await expect(page.getByText(COWORKER)).toBeVisible();
	await page.goto('/#/w/ws_default/members');
	await expect(page.getByText(COWORKER)).toHaveCount(0);
});
