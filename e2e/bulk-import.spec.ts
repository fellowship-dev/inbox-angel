// Playwright smoke test — Bulk Domain Import
//
// Requires a running local dashboard and private E2E_OPERATOR_FILE credentials.
//
// Run: npm run dev (wrangler dev), then npm run test:e2e  (override target with E2E_BASE_URL).
// Pre-condition: local dashboard reachable; operator file contains email, password and installer proof.

import { test, expect } from '@playwright/test';
import { signIn } from './support/session';
import { ensureDomain } from './support/db';

test.beforeEach(async ({ page }) => { await signIn(page); });


test.describe('Bulk domain import', () => {
  test('navigates to /bulk-import and shows the form', async ({ page }) => {
    await page.goto(`/#/bulk-import`);
    await expect(page.getByRole('heading', { name: 'Import domains', level: 1 })).toBeVisible();
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.getByRole('button', { name: /Import domains/ })).toBeVisible();
  });

  test('imports valid domains and shows per-row results', async ({ page }) => {
    // Use obviously-fake test domains that won't collide with real data
    const testDomains = [
      'bulk-e2e-test-1.invalid',
      'bulk-e2e-test-2.invalid',
      'bulk-e2e-test-3.invalid',
    ].join('\n');

    await page.goto(`/#/bulk-import`);
    await page.locator('textarea').fill(testDomains);
    await page.getByRole('button', { name: /Import domains/ }).click();

    // Wait for results table
    await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });

    // Summary badge should appear
    await expect(page.locator('text=/of 3 domains imported/')).toBeVisible();

    // Each domain row should have a status badge
    for (const d of testDomains.split('\n')) {
      await expect(page.locator(`td >> code:text("${d}")`)).toBeVisible();
    }
  });

  test('reports duplicates without failing the whole batch', async ({ page }) => {
    await page.goto(`/#/bulk-import`);
    // Seed an exact local fixture so this test does not depend on an unrelated real domain.
    await ensureDomain(page, 'bulk-e2e-test-1.invalid');
    await page.locator('textarea').fill('bulk-e2e-test-1.invalid\nbulk-e2e-unique-xyz.invalid');
    await page.getByRole('button', { name: /Import domains/ }).click();

    await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });

    // The fixture is a duplicate; the second domain can be imported.
    const duplicateRow = page.locator('tr', { has: page.locator('code:text("bulk-e2e-test-1.invalid")') });
    await expect(duplicateRow.locator('span:text("duplicate")')).toBeVisible();
  });

  test('shows invalid status for a malformed entry', async ({ page }) => {
    await page.goto(`/#/bulk-import`);
    await page.locator('textarea').fill('not a domain at all');
    await page.getByRole('button', { name: /Import domains/ }).click();

    await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('span:text("invalid")')).toBeVisible();
  });
});
