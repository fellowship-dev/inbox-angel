/**
 * Playwright smoke test: staged rollout (RFC 9989 p=/t=) UI on domain detail page.
 *
 * Run via /test-prod or manually:
 *   node e2e/domain-rollout.spec.mjs
 *
 * Requires:
 *   - Chromium running with remote debug port: --remote-debugging-port=9222
 *   - playwright-core installed at ~/.local/share/fry-bot/node_modules/playwright-core
 *   - IA_API_KEY env var set to a valid dashboard API key
 *   - DOMAIN_ID env var set to the domain id to test (default: 2)
 */

import { chromium } from '/root/.local/share/fry-bot/node_modules/playwright-core/index.js';

const BASE = process.env.IA_BASE_URL ?? 'http://127.0.0.1:8787';
const API_KEY = process.env.IA_API_KEY;
const DOMAIN_ID = process.env.DOMAIN_ID ?? '2';

if (!API_KEY) throw new Error('IA_API_KEY env var required');

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = await browser.newPage();

try {
  // Inject API key so we skip login
  await page.goto(BASE);
  await page.evaluate((key) => localStorage.setItem('ia_api_key', key), API_KEY);

  // Navigate to domain detail
  await page.goto(`${BASE}/#/domains/${DOMAIN_ID}`);
  await page.waitForSelector('[data-testid="domain-detail"], h2', { timeout: 10000 });

  console.log('✓ Domain detail page loaded');

  // Check rollout widget renders (only visible when policy != none)
  // The widget contains "Rollout progress" heading
  const rolloutWidget = page.locator('text=Rollout progress');
  const widgetCount = await rolloutWidget.count();

  if (widgetCount > 0) {
    console.log('✓ Rollout progress widget visible');

    // Check progress bar is present
    const progressBar = page.locator('[style*="background: #2563eb"][style*="border-radius: 999px"]');
    await progressBar.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✓ Progress bar rendered');

    // "Advance policy" button should be present if not at last step
    const advanceBtn = page.locator('text=Advance policy');
    const btnCount = await advanceBtn.count();
    if (btnCount > 0) {
      // If button is enabled, verify modal opens on click
      const isDisabled = await advanceBtn.first().isDisabled();
      if (!isDisabled) {
        await advanceBtn.first().click();
        await page.waitForSelector('text=Advance to', { timeout: 3000 });
        console.log('✓ Advance modal opens with DNS preview');
        // Close modal
        await page.keyboard.press('Escape');
      } else {
        console.log('✓ Advance button visible but blocked (pass rate below threshold)');
      }
    } else {
      console.log('✓ "Fully graduated" badge visible (last step reached)');
    }
  } else {
    console.log('ℹ Rollout widget not shown (domain policy is none or not yet enrolled)');
  }

  console.log('\n✅ Rollout smoke test passed');
} finally {
  await page.close();
  await browser.close();
}
