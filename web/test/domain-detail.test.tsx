import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { READ_ONLY_REASON } from '../src/lib/session';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { renderApp } from './render';

const domain = { id: 1, domain: 'example.com', dmarc_policy: 'quarantine', rua_address: 'r@reports.test', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };
const current = 'v=DMARC1; p=quarantine; rua=mailto:someone@else.test';
const rollout = {
	current_policy: 'quarantine', current_pct: 100, current_testing: false, current_record: current, current_step_index: 1, total_steps: 5,
	next_step: { policy: 'reject', testing: true }, next_step_note: 'Dropping pct=50 applies the policy to all mail.', dns_preview: 'v=DMARC1; p=reject; t=y; rua=mailto:r@reports.test',
	pass_rate: 97, blocked: false, block_reason: null, has_unknown_senders: false, behind_schedule: false, recommended_policy: null, recommended_pct: null,
};
const onboarding = {
	domain_id: 1, domain: 'example.com', rua_address: 'r@reports.test', cf_available: true,
	dmarc: { found: true, has_our_rua: false, current_record: current, rua_address: 'r@reports.test' },
	spf: { record: 'v=spf1 include:_spf.google.com -all', lookup_count: 4, flattening_active: false },
	dkim: { selectors: [{ name: 'google._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
};

const routes = (over: Record<string, unknown> = {}) => ({
	'GET /api/domains': { domains: [domain] },
	'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [{ day: '2026-10-20', total: 100, passed: 97, failed: 3 }] },
	'GET /api/domains/1/sources': { sources: [] },
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
	'GET /api/domains/1/dns-check': { found: true, has_rua: false, current_record: current, cf_managed: true },
	'GET /api/domains/1/onboarding-status': onboarding,
	'GET /api/domains/1/rollout-next': rollout,
	'GET /api/domains/1/spf-flatten': { available: false, config: null, lookup_count: null },
	'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null },
	...over,
});

const page = (opts: Parameters<typeof renderApp>[1]) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id" element={<DomainDetailPage />} />
		</Routes>,
		{ route: '/domains/1', ...opts },
	);

describe('DomainDetailPage policy badge', () => {
	it('never contradicts the DMARC record card: no live record means "last known", not p=quarantine', async () => {
		page({ routes: routes({ 'GET /api/domains/1/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false } }) });
		expect(await screen.findByText('No DMARC record found (last known policy: p=quarantine)')).toBeInTheDocument();
		expect(screen.queryByText('p=quarantine')).not.toBeInTheDocument();
	});

	it('shows the live policy when DNS has the record, even if the stored one differs', async () => {
		page({ routes: routes({ 'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: 'v=DMARC1; p=reject; rua=mailto:r@reports.test', cf_managed: true } }) });
		expect(await screen.findByText('p=reject')).toBeInTheDocument();
		expect(screen.queryByText('p=quarantine')).not.toBeInTheDocument();
	});

	it('says the lookup failed rather than guessing a policy', async () => {
		page({ routes: routes({ 'GET /api/domains/1/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' } }) });
		expect(await screen.findByText(/DMARC lookup failed/)).toBeInTheDocument();
	});
});

describe('DomainDetailPage', () => {
	it('is read-only for members: data visible, apply and advance disabled, with the explanation', async () => {
		page({ role: 'member', routes: routes() });
		expect(await screen.findByRole('heading', { level: 1, name: 'example.com' })).toBeInTheDocument();
		const notice = await screen.findByTestId('read-only-notice');
		expect(notice).toHaveTextContent(READ_ONLY_REASON);
		const apply = await screen.findByRole('button', { name: /Apply to Cloudflare/ });
		const advance = await screen.findByRole('button', { name: /Advance policy/ });
		await waitFor(() => {
			expect(apply).toBeDisabled();
			expect(advance).toBeDisabled();
		});
		expect(apply).toHaveAccessibleDescription(READ_ONLY_REASON);
		// the data is still there
		expect(screen.getByText('Step 2 of 5')).toBeInTheDocument();
		expect(screen.getAllByText(current).length).toBeGreaterThan(0);
	});

	it('shows "Lookup failed", never "Not found", when DNS lookups fail', async () => {
		page({
			routes: routes({
				'GET /api/domains/1/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' },
				'GET /api/domains/1/onboarding-status': { ...onboarding, spf: { record: null, lookup_count: null, flattening_active: false }, dns_errors: ['spf: timeout'] },
			}),
		});
		const list = await screen.findByRole('list', { name: 'DNS records' });
		await waitFor(() => expect(within(list).getAllByText('Lookup failed')).toHaveLength(2));
		expect(within(list).queryByText('Not found')).toBeNull();
		expect(within(list).getAllByRole('button', { name: /try again/i }).length).toBe(2);
	});

	it('shows "Not found" only when the lookup worked and found nothing', async () => {
		page({
			routes: routes({
				'GET /api/domains/1/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
				'GET /api/domains/1/onboarding-status': { ...onboarding, spf: { record: null, lookup_count: null, flattening_active: false } },
			}),
		});
		const list = await screen.findByRole('list', { name: 'DNS records' });
		await waitFor(() => expect(within(list).getAllByText('Not found')).toHaveLength(2));
		expect(within(list).queryByText('Lookup failed')).toBeNull();
	});

	it('renders the rollout step, policy and the next-step note; blocked rollouts cannot advance', async () => {
		page({ routes: routes({ 'GET /api/domains/1/rollout-next': { ...rollout, blocked: true, block_reason: 'Pass rate is 60%, must be at least 95% to advance', current_testing: true } }) });
		expect(await screen.findByText('Step 2 of 5')).toBeInTheDocument();
		expect(screen.getByText('Quarantine (testing, t=y)')).toBeInTheDocument();
		expect(screen.getByText('Next: Reject (testing, t=y)')).toBeInTheDocument();
		expect(screen.getByText(rollout.next_step_note)).toBeInTheDocument();
		expect(screen.getByText(/must be at least 95%/)).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: /Advance policy/ })).toBeDisabled());
	});

	it('advances only after the confirm dialog, posting the next step', async () => {
		const { calls } = page({ routes: routes({ 'POST /api/domains/1/rollout-advance': { ok: true } }) });
		const advance = await screen.findByRole('button', { name: /Advance policy/ });
		await waitFor(() => expect(advance).toBeEnabled());
		await userEvent.click(advance);
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByText(rollout.dns_preview)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
		await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as applied' }));
		await waitFor(() => expect(calls.find((c) => c.path === '/api/domains/1/rollout-advance')?.body).toEqual({ policy: 'reject', testing: true }));
	});

	it('applies the recommended DMARC record for Cloudflare-managed domains after confirming', async () => {
		const { calls } = page({ routes: routes({ 'POST /api/domains/1/apply-dmarc': { ok: true } }) });
		const apply = await screen.findByRole('button', { name: /Apply to Cloudflare/ });
		await waitFor(() => expect(apply).toBeEnabled());
		await userEvent.click(apply);
		await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Apply record' }));
		await waitFor(() => expect(calls.find((c) => c.path === '/api/domains/1/apply-dmarc')?.body).toEqual({ record: `${current},mailto:r@reports.test` }));
	});

	it('disabling an SPF flattening tool asks first', async () => {
		const { calls } = page({
			routes: routes({
				'GET /api/domains/1/spf-flatten': { available: true, config: { enabled: 1, ip_count: 12, lookup_count: 3 }, lookup_count: 3 },
				'DELETE /api/domains/1/spf-flatten': { ok: true },
			}),
		});
		const disable = await screen.findByRole('button', { name: 'Disable' });
		await waitFor(() => expect(disable).toBeEnabled());
		await userEvent.click(disable);
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/domains/1/spf-flatten')).toBe(true));
	});
});
