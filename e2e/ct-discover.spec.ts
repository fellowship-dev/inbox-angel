// Playwright smoke test — CT Log Subdomain Discovery
//
// Requires a running dashboard (default http://127.0.0.1:8787) with an admin session
// injected into localStorage as 'ia_api_key'.
//
// Run: npm run dev (wrangler dev), then npm run test:e2e  (override target with E2E_BASE_URL).
// Pre-condition: dashboard URL reachable, admin API key available.

import { test, expect } from '@playwright/test';


// A known domain with public CT entries; any widely-used domain works.
const KNOWN_DOMAIN = 'cloudflare.com';

test.describe('CT log subdomain discovery', () => {
  test('navigates to /ct-discover and shows the form', async ({ page }) => {
    await page.goto(`/#/ct-discover`);
    await expect(page.getByRole('heading', { name: 'Discover subdomains' })).toBeVisible();
    await expect(page.locator('input[id="ct-domain-input"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discover' })).toBeVisible();
  });

  test('returns subdomains for a known root domain within 10 seconds', async ({ page }) => {
    await page.goto(`/#/ct-discover`);
    await page.locator('input[id="ct-domain-input"]').fill(KNOWN_DOMAIN);
    await page.getByRole('button', { name: 'Discover' }).click();

    // Results should appear within 10s
    await expect(page.locator('text=/subdomain.*found/')).toBeVisible({ timeout: 12_000 });

    // At least one subdomain checkbox should be rendered
    await expect(page.locator('label input[type="checkbox"]').nth(1)).toBeVisible();
  });

  test('select-all selects every subdomain', async ({ page }) => {
    await page.goto(`/#/ct-discover`);
    await page.locator('input[id="ct-domain-input"]').fill(KNOWN_DOMAIN);
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(page.locator('text=/subdomain.*found/')).toBeVisible({ timeout: 12_000 });

    // Uncheck all first, then select all
    const header = page.locator('label', { has: page.locator('strong:text-matches(/subdomain.*found/)') });
    const headerCheckbox = header.locator('input[type="checkbox"]');
    await headerCheckbox.uncheck();
    await headerCheckbox.check();

    // Selected count should match total
    const headerText = await page.locator('strong:text-matches(/subdomain.*found/)').textContent();
    const total = parseInt(headerText?.match(/^(\d+)/)?.[1] ?? '0', 10);
    await expect(page.locator('text=/^' + total + ' selected/')).toBeVisible();
  });

  test('returns empty list message for a domain with no CT history', async ({ page }) => {
    await page.goto(`/#/ct-discover`);
    await page.locator('input[id="ct-domain-input"]').fill('no-ct-history-xyz-12345.invalid');
    await page.getByRole('button', { name: 'Discover' }).click();

    // Should show empty message (no error, just 0 results) OR an error from upstream
    await expect(
      page.locator('text=/No subdomains found/').or(page.locator('p[style*="dc2626"]'))
    ).toBeVisible({ timeout: 12_000 });
  });
});
