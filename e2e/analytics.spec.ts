// Analytics end to end, against a local `wrangler dev` with seeded reports:
//   rm -rf /tmp/ia-e2e && node packages/db/scripts/migrate.mjs --local --persist-to /tmp/ia-e2e
//   npx wrangler dev --local --persist-to /tmp/ia-e2e        # serves web/dist (npm run build:dashboard first)
//   E2E_PERSIST_TO=/tmp/ia-e2e npx playwright test e2e/analytics.spec.ts
// The test adds a domain row, then writes 30 days of reports into the same local D1.
import { expect, test } from '@playwright/test';
import { analyticsSeedSql } from './support/analytics-seed';
import { ensureDomain, runSql } from './support/db';
import { signIn, tokenOf } from './support/session';

const DOMAIN = 'analytics-e2e.test';

test('sender inventory, what to fix next and readiness from seeded reports', async ({ page }) => {
	await signIn(page);
	const domain = { id: await ensureDomain(page, await tokenOf(page), DOMAIN) };
	runSql(analyticsSeedSql(domain.id, DOMAIN));

	await page.goto(`/#/domains/${domain.id}/analytics`);
	await expect(page.getByRole('heading', { name: `Analytics: ${DOMAIN}`, level: 1 })).toBeVisible();

	// Sender inventory: provider names, volume, alignment as text, the new-sender flag.
	const inventory = page.getByRole('table', { name: 'Sender inventory' });
	await expect(inventory.getByRole('row')).toHaveCount(1 + 4);
	const mailchimp = inventory.getByRole('row', { name: /Mailchimp/ });
	await expect(mailchimp).toContainText('198.2.180.1');
	await expect(mailchimp).toContainText('Likely failing');
	await expect(mailchimp.getByText(/SPF aligned, failing/)).toBeAttached();
	await expect(inventory.getByRole('row', { name: /SendGrid/ })).toContainText('New sender');
	await expect(inventory.getByRole('row', { name: /Google Workspace/ })).not.toContainText('Likely failing');

	// What to fix next: ranked, with the concrete change and a copyable record.
	const fixes = page.getByRole('list', { name: 'What to fix next' });
	await expect(fixes.getByRole('heading').first()).toContainText(/Mailchimp sends \d+(\.\d)?% of your mail and fails DMARC/);
	// Mailchimp authenticates as mcsv.net, so SPF cannot align: DKIM only, and no SPF record to paste.
	await expect(fixes).toContainText('SPF cannot align for Mailchimp');
	await expect(fixes).toContainText('custom-domain DKIM');
	await expect(fixes.getByRole('link', { name: /Mailchimp setup guide/ })).toBeVisible();
	await expect(page.getByText('These alignment figures are estimates.')).toBeVisible();

	// Readiness gives a verdict and its reasons in words. The live DMARC lookup decides which verdict (a .test domain has
	// no record, so "Publish a DMARC record first"), so assert the shape, not the outcome.
	const readiness = page.getByRole('region', { name: 'Enforcement readiness' });
	await expect(readiness.getByRole('status')).toContainText(/Now:/);
	await expect(readiness.getByRole('listitem').first()).toContainText(/OK:|Careful:|Blocker:/);

	// The trend has a chart and a table alternative with the same days.
	await expect(page.getByRole('img', { name: /Stacked columns of messages per day/ })).toBeVisible();
	await page.getByRole('button', { name: 'Table' }).click();
	await expect(page.getByRole('table', { name: /Messages per day/ }).getByRole('row').nth(1)).toBeVisible();

	// Window: 90 days folds into weeks.
	await page.getByRole('button', { name: 'Last 90 days' }).click();
	await expect(page.getByRole('columnheader', { name: 'Week of' })).toBeVisible();

	// Account-wide page lists the domain and links to it.
	await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Analytics' }).click();
	await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
	await page.getByRole('link', { name: DOMAIN }).first().click();
	await expect(page).toHaveURL(new RegExp(`#/domains/${domain.id}/analytics$`));
});
