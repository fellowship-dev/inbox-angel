// The hosted-mode UI in a real browser. A local `wrangler dev` is self-host (hosted needs MODE=saas plus a Cloudflare
// records zone), so the hosted endpoints are answered by page.route here and everything else is the real Worker:
// this proves the dashboard flow and its one-time-address handling, not the hosted backend (test/hosted covers that).
//   npx wrangler dev --local --persist-to /tmp/ia-e2e   (build:dashboard first)
//   npx playwright test e2e/hosted-ui.spec.ts
import { expect, test } from '@playwright/test';
import { ensureDomain } from './support/db';
import { signIn, tokenOf } from './support/session';

const DOMAIN = 'hosted-e2e.test';
const ID = 'k3j2h4g5f6d7s8a9';
const status = (over: Record<string, unknown> = {}) => ({
	enabled: true, hosted_id: ID, mta_sts: false,
	records: { dmarc: `${ID}._dmarc.h.inboxangel.io`, spf: `${ID}._spf.h.inboxangel.io`, tls_rpt: `${ID}._tlsrpt.h.inboxangel.io`, mta_sts: null },
	pointers: [
		{ purpose: 'dmarc', type: 'CNAME', name: `_dmarc.${DOMAIN}`, value: `${ID}._dmarc.h.inboxangel.io` },
		{ purpose: 'spf', type: 'TXT', name: DOMAIN, value: `include:${ID}._spf.h.inboxangel.io` },
		{ purpose: 'tls_rpt', type: 'CNAME', name: `_smtp._tls.${DOMAIN}`, value: `${ID}._tlsrpt.h.inboxangel.io` },
	],
	pointer_status: { dmarc: 'missing', spf: 'missing', mta_sts: null, tls_rpt: 'missing', checked_at: null },
	level_inputs: { dmarc_published: false, spf_published: false, mta_sts_published: false },
	...over,
});

test('enable hosted records, copy the pointers, verify, and the addresses are not shown again', async ({ page }) => {
	await signIn(page);
	const domain = { id: await ensureDomain(page, await tokenOf(page), DOMAIN) };

	let enabled = false;
	let verified = false;
	await page.route('**/api/hosted/config', (r) => r.fulfill({ json: { enabled: true } }));
	await page.route(`**/api/domains/${domain.id}/hosted`, async (r) => {
		if (r.request().method() === 'POST') {
			enabled = true;
			return r.fulfill({ status: 201, json: { hosted: status(), addresses: { rua: `rua+${'a'.repeat(32)}@rua.inboxangel.io`, tls_rpt: `tls-rpt+${'a'.repeat(32)}@rua.inboxangel.io` } } });
		}
		return r.fulfill({ json: enabled ? status(verified ? { pointer_status: { dmarc: 'ok', spf: 'wrong', mta_sts: null, tls_rpt: 'error', checked_at: Math.floor(Date.now() / 1000) } } : {}) : { enabled: false } });
	});
	await page.route(`**/api/domains/${domain.id}/hosted/verify`, (r) => {
		verified = true;
		return r.fulfill({ json: status({ pointer_status: { dmarc: 'ok', spf: 'wrong', mta_sts: null, tls_rpt: 'error', checked_at: Math.floor(Date.now() / 1000) } }) });
	});

	// The SPA cached the domain list before the row existed.
	await page.goto(`/#/domains/${domain.id}`);
	await page.reload();
	await page.getByRole('button', { name: 'Enable hosted records' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('heading', { name: 'Enable hosted records' })).toBeVisible();
	await dialog.getByRole('button', { name: 'Enable hosted records' }).click();

	// Addresses once, with copy; the pointers to add as copyable record blocks.
	const addresses = page.getByTestId('hosted-addresses');
	await expect(addresses).toContainText('shown once');
	await expect(addresses).toContainText('@rua.inboxangel.io');
	const pointers = page.getByRole('list', { name: 'Pointer records' });
	await expect(pointers).toContainText(`_dmarc.${DOMAIN}`);
	await expect(pointers.getByRole('button', { name: 'Copy value' }).first()).toBeVisible();

	// Live verification: ok, wrong and "Lookup failed" (an unreadable pointer is never reported as missing).
	await page.getByRole('button', { name: 'Verify now' }).click();
	await expect(pointers.getByText('Lookup failed')).toBeVisible();
	await expect(pointers.getByText(/Wrong/i).first()).toBeVisible();

	// Once dismissed (or after a reload) the addresses are gone.
	await page.getByRole('button', { name: 'I have copied them' }).click();
	await expect(addresses).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole('list', { name: 'Pointer records' })).toBeVisible();
	await expect(page.getByText('@rua.inboxangel.io')).toHaveCount(0);
});
