import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DmarcWizardPage } from '../src/pages/wizards/DmarcWizardPage';
import { MtaStsPage } from '../src/pages/wizards/MtaStsPage';
import { SpfFlattenPage } from '../src/pages/wizards/SpfFlattenPage';
import { fail, renderApp, type Handler } from './render';

const domain = { id: 3, domain: 'example.com', dmarc_policy: 'none', rua_address: 'r@reports.example.com', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 1 };

const mount = (path: string, element: React.ReactElement) => (
	<Routes>
		<Route path={path} element={element} />
	</Routes>
);

describe('SPF flatten wizard', () => {
	const flatStatus = { available: true, config: null, lookup_count: 9 };
	const onboarding = (spf: { record: string | null }, dns_errors?: string[]) => ({
		domain_id: 3,
		spf: { ...spf, lookup_count: 9, flattening_active: false },
		...(dns_errors ? { dns_errors } : {}),
	});
	const base = (extra: Record<string, unknown | Handler> = {}) => ({
		'GET /api/domains/3/spf-flatten': flatStatus,
		'GET /api/domains/3/onboarding-status': onboarding({ record: 'v=spf1 include:a.example include:b.example ~all' }),
		'GET /api/domains/3/spf-flatten/preview': { flattened_record: 'v=spf1 ip4:192.0.2.1 ip4:192.0.2.2 ~all', ip_count: 2 },
		...extra,
	});
	const ui = mount('/domains/:id/spf-flatten', <SpfFlattenPage />);

	it('walks analyze, compare, enable and done', async () => {
		const { calls } = renderApp(ui, {
			route: '/domains/3/spf-flatten',
			routes: base({
				'POST /api/domains/3/spf-flatten': { ok: true, config: { enabled: 1, canonical_record: 'x', flattened_record: 'v=spf1 ip4:192.0.2.1 ip4:192.0.2.2 ~all', ip_count: 2, lookup_count: 1 } },
			}),
		});
		expect(await screen.findByText('v=spf1 include:a.example include:b.example ~all')).toBeInTheDocument();
		expect(screen.getByText(/Step 1 of 4/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

		expect(await screen.findByText('Original record')).toBeInTheDocument();
		expect(screen.getByText('Flattened record')).toBeInTheDocument();
		expect(screen.getByText('1 lookup')).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

		expect(await screen.findByText('This changes your live DNS')).toBeInTheDocument();
		const enable = screen.getByRole('button', { name: 'Enable SPF flattening' });
		await waitFor(() => expect(enable).toBeEnabled());
		await userEvent.click(enable);
		expect(await screen.findByRole('heading', { name: 'SPF flattening enabled' })).toBeInTheDocument();
		expect(screen.getByText(/2 IPs in the flattened record/)).toBeInTheDocument();
		expect(screen.getAllByRole('link', { name: 'Back to domain' }).every((l) => l.getAttribute('href') === '/domains/3')).toBe(true);
		expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/spf-flatten'))).toHaveLength(1);
	});

	it('treats a failed preview as degraded, not blocking', async () => {
		renderApp(ui, { route: '/domains/3/spf-flatten', routes: base({ 'GET /api/domains/3/spf-flatten/preview': () => fail(502) }) });
		await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('Preview unavailable')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
	});

	it('a failed SPF lookup is "Lookup failed", not "No SPF record found"', async () => {
		renderApp(ui, {
			route: '/domains/3/spf-flatten',
			routes: base({ 'GET /api/domains/3/onboarding-status': onboarding({ record: null }, ['spf: timeout']), 'GET /api/domains/3/spf-flatten': { available: true, config: null, lookup_count: null } }),
		});
		expect(await screen.findByText('Lookup failed')).toBeInTheDocument();
		expect(screen.getByText(/timeout/)).toBeInTheDocument();
		expect(screen.queryByText('No SPF record found')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});

	it('really no record: says so and offers a way back', async () => {
		renderApp(ui, {
			route: '/domains/3/spf-flatten',
			routes: base({ 'GET /api/domains/3/onboarding-status': onboarding({ record: null }), 'GET /api/domains/3/spf-flatten': { available: true, config: null, lookup_count: null } }),
		});
		expect(await screen.findByText('No SPF record found')).toBeInTheDocument();
		expect(screen.getAllByRole('link', { name: 'Back to domain' })).toHaveLength(2);
	});

	it('members can read the steps but not enable', async () => {
		renderApp(ui, { role: 'member', route: '/domains/3/spf-flatten', routes: base() });
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		expect(await screen.findByRole('button', { name: 'Enable SPF flattening' })).toBeDisabled();
	});

	it('shows a retryable error when the status cannot be loaded', async () => {
		renderApp(ui, { route: '/domains/3/spf-flatten', routes: base({ 'GET /api/domains/3/spf-flatten': () => fail(404, 'domain not found') }) });
		expect(await screen.findByText('domain not found')).toBeInTheDocument();
	});
});

describe('MTA-STS wizard', () => {
	const ui = mount('/domains/:id/mta-sts', <MtaStsPage />);
	const off = { available: true, config: null, summary: null };
	const on = (mode: string) => ({ available: true, summary: null, config: { enabled: 1, mode, mx_hosts: 'mx1.example.net,mx2.example.net' } });

	async function toProvision(role: 'owner' | 'member' = 'owner', pick?: string) {
		await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		if (pick) await userEvent.click(await screen.findByRole('radio', { name: new RegExp(pick) }));
		await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		const enable = await screen.findByRole('button', { name: 'Enable MTA-STS' });
		if (role === 'owner') await waitFor(() => expect(enable).toBeEnabled());
		return enable;
	}

	it('testing mode: one POST, then done', async () => {
		let enabled = false;
		const { calls } = renderApp(ui, {
			route: '/domains/3/mta-sts',
			routes: {
				'GET /api/domains/3/mta-sts': () => (enabled ? on('testing') : off),
				'POST /api/domains/3/mta-sts': () => {
					enabled = true;
					return { ok: true, mode: 'testing', mx_hosts: ['mx1.example.net'] };
				},
			},
		});
		await userEvent.click(await toProvision());
		expect(await screen.findByRole('heading', { name: 'MTA-STS enabled' })).toBeInTheDocument();
		expect(screen.getByText('mx1.example.net')).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
	});

	it('enforce: POST then PATCH', async () => {
		let mode = 'none';
		const { calls } = renderApp(ui, {
			route: '/domains/3/mta-sts',
			routes: {
				'GET /api/domains/3/mta-sts': () => (mode === 'none' ? off : on(mode)),
				'POST /api/domains/3/mta-sts': () => {
					mode = 'testing';
					return { ok: true, mode: 'testing', mx_hosts: ['mx1.example.net'] };
				},
				'PATCH /api/domains/3/mta-sts': () => {
					mode = 'enforce';
					return { ok: true, mode: 'enforce', policy_id: 'p' };
				},
			},
		});
		await userEvent.click(await toProvision('owner', 'Enforce'));
		expect(await screen.findByRole('heading', { name: 'MTA-STS enabled' })).toBeInTheDocument();
		expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${JSON.stringify(c.body ?? null)}`)).toEqual(['POST null', 'PATCH {"mode":"enforce"}']);
		expect(screen.getByText('enforce')).toBeInTheDocument();
	});

	it('partial failure: says enabled in testing mode, and the retry only repeats the PATCH', async () => {
		let patches = 0;
		const { calls } = renderApp(ui, {
			route: '/domains/3/mta-sts',
			routes: {
				'GET /api/domains/3/mta-sts': off,
				'POST /api/domains/3/mta-sts': { ok: true, mode: 'testing', mx_hosts: ['mx1.example.net'] },
				'PATCH /api/domains/3/mta-sts': () => (++patches === 1 ? fail(502, 'policy worker unavailable') : { ok: true, mode: 'enforce', policy_id: 'p' }),
			},
		});
		await userEvent.click(await toProvision('owner', 'Enforce'));
		const alert = await screen.findByText('Enabled in testing mode; switching to enforce failed');
		expect(alert).toBeInTheDocument();
		expect(screen.getByText(/policy worker unavailable/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Enable MTA-STS' })).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole('button', { name: 'Retry switching to enforce' }));
		expect(await screen.findByRole('heading', { name: 'MTA-STS enabled' })).toBeInTheDocument();
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
		expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
	});

	it('an enabling failure is shown inline and can be retried', async () => {
		renderApp(ui, { route: '/domains/3/mta-sts', routes: { 'GET /api/domains/3/mta-sts': off, 'POST /api/domains/3/mta-sts': () => fail(400, 'Cloudflare credentials not configured') } });
		await userEvent.click(await toProvision());
		expect(await screen.findByText('Cloudflare credentials not configured')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Enable MTA-STS' })).toBeEnabled();
	});

	it('members cannot enable', async () => {
		renderApp(ui, { role: 'member', route: '/domains/3/mta-sts', routes: { 'GET /api/domains/3/mta-sts': off } });
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		expect(await toProvision('member')).toBeDisabled();
	});

	it('already active: lists MX hosts and only offers Continue', async () => {
		renderApp(ui, { route: '/domains/3/mta-sts', routes: { 'GET /api/domains/3/mta-sts': on('testing') } });
		expect(await screen.findByText('MTA-STS is already active (testing mode)')).toBeInTheDocument();
		expect(screen.getByText('mx2.example.net')).toBeInTheDocument();
	});
});

describe('DMARC graduation wizard', () => {
	const ui = mount('/domains/:id/dmarc-wizard', <DmarcWizardPage />);
	const current = 'v=DMARC1; p=none; sp=none; rua=mailto:r@reports.example.com';
	const routesFor = (extra: Record<string, unknown | Handler> = {}, dns: unknown = { found: true, has_rua: true, current_record: current, cf_managed: false }) => ({
		'GET /api/domains': { domains: [domain] },
		'GET /api/domains/3/dns-check': dns,
		...extra,
	});

	it('manual path advances with NO API call and says Inbox Angel will detect the change', async () => {
		const { calls } = renderApp(ui, { route: '/domains/3/dmarc-wizard', routes: routesFor() });
		expect(await screen.findByText('Step 1: switch to quarantine')).toBeInTheDocument();
		expect(screen.getByText(/Confirming makes no change on our side/)).toBeInTheDocument();
		expect(screen.getAllByText('v=DMARC1; p=quarantine; sp=none; rua=mailto:r@reports.example.com').length).toBeGreaterThan(0);
		const before = calls.length;
		await userEvent.click(screen.getByRole('button', { name: "I've updated it manually" }));
		expect(await screen.findByText('Step 2: switch to reject')).toBeInTheDocument();
		expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument();
		expect(calls.slice(before)).toEqual([]);
		await userEvent.click(screen.getByRole('button', { name: 'Back' }));
		expect(await screen.findByText('Step 1: switch to quarantine')).toBeInTheDocument();
	});

	it('Cloudflare-managed: PATCHes the policy, refetches domains and advances', async () => {
		let policy = 'none';
		const { calls } = renderApp(ui, {
			route: '/domains/3/dmarc-wizard',
			routes: {
				'GET /api/domains': () => ({ domains: [{ ...domain, dmarc_policy: policy }] }),
				'GET /api/domains/3/dns-check': { found: true, has_rua: true, current_record: current, cf_managed: true },
				'PATCH /api/domains/3/dmarc': () => {
					policy = 'quarantine';
					return { ok: true, policy: 'quarantine', record: 'v=DMARC1; p=quarantine; sp=none; rua=mailto:r@reports.example.com' };
				},
			},
		});
		const apply = await screen.findByRole('button', { name: 'Apply via Cloudflare' });
		await waitFor(() => expect(apply).toBeEnabled());
		await userEvent.click(apply);
		expect(await screen.findByText('Step 2: switch to reject')).toBeInTheDocument();
		expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ policy: 'quarantine' });
		expect(screen.getByText('v=DMARC1; p=reject; sp=none; rua=mailto:r@reports.example.com')).toBeInTheDocument();
	});

	it('starts from the current policy and shows the finished state for reject', async () => {
		renderApp(ui, { route: '/domains/3/dmarc-wizard', routes: { ...routesFor(), 'GET /api/domains': { domains: [{ ...domain, dmarc_policy: 'reject' }] } } });
		expect(await screen.findByRole('heading', { name: 'Fully enforced' })).toBeInTheDocument();
		expect(screen.getAllByRole('link', { name: 'Back to domain' }).every((l) => l.getAttribute('href') === '/domains/3')).toBe(true);
	});

	it('quarantine starts at step 2 of 2', async () => {
		renderApp(ui, { route: '/domains/3/dmarc-wizard', routes: { ...routesFor(), 'GET /api/domains': { domains: [{ ...domain, dmarc_policy: 'quarantine' }] } } });
		expect(await screen.findByText('Step 2: switch to reject')).toBeInTheDocument();
	});

	it('a failed DNS lookup offers nothing to apply, instead of building a record from nothing', async () => {
		renderApp(ui, {
			route: '/domains/3/dmarc-wizard',
			routes: routesFor({}, { found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' }),
		});
		const row = (await screen.findByText('Lookup failed')).closest('li') as HTMLElement;
		expect(row).toHaveAttribute('data-status', 'error');
		expect(within(row).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: "I've updated it manually" })).not.toBeInTheDocument();
		expect(screen.queryByText('New record')).not.toBeInTheDocument();
	});

	it('members see the notice and cannot apply', async () => {
		renderApp(ui, {
			role: 'member',
			route: '/domains/3/dmarc-wizard',
			routes: routesFor({}, { found: true, has_rua: true, current_record: current, cf_managed: true }),
		});
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		expect(await screen.findByRole('button', { name: 'Apply via Cloudflare' })).toBeDisabled();
	});

	it('shows an apply error inline', async () => {
		renderApp(ui, {
			route: '/domains/3/dmarc-wizard',
			routes: routesFor({ 'PATCH /api/domains/3/dmarc': () => fail(502, 'Cloudflare refused') }, { found: true, has_rua: true, current_record: current, cf_managed: true }),
		});
		const apply = await screen.findByRole('button', { name: 'Apply via Cloudflare' });
		await waitFor(() => expect(apply).toBeEnabled());
		await userEvent.click(apply);
		expect(await screen.findByText('Cloudflare refused')).toBeInTheDocument();
	});
});
