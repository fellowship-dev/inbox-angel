import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DomainLevelCard } from '../src/components/domain/DomainLevelCard';
import { READ_ONLY_REASON } from '../src/lib/session';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { DomainSettingsPage } from '../src/pages/domains/DomainSettingsPage';
import { MtaStsPage } from '../src/pages/wizards/MtaStsPage';
import { fail, renderApp } from './render';

const domain = { id: 1, domain: 'example.com', dmarc_policy: 'reject', rua_address: 'r@reports.test', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };
const addresses = { rua: 'rua+SECRETTOKEN@intake.test', tls_rpt: 'tls+SECRETTOKEN@intake.test' };
const pointers = [
	{ purpose: 'dmarc', type: 'CNAME', name: '_dmarc.example.com', value: 'abc._dmarc.h.inboxangel.io' },
	{ purpose: 'spf', type: 'TXT', name: 'example.com', value: 'include:abc._spf.h.inboxangel.io' },
	{ purpose: 'tls_rpt', type: 'CNAME', name: '_smtp._tls.example.com', value: 'abc._tlsrpt.h.inboxangel.io' },
];
const status = (ps: Record<string, string | null> = {}, extra: Record<string, unknown> = {}) => ({
	enabled: true,
	hosted_id: 'abc',
	mta_sts: false,
	records: {},
	pointers,
	pointer_status: { dmarc: 'ok', spf: 'missing', tls_rpt: 'wrong', mta_sts: null, checked_at: Math.floor(Date.now() / 1000) - 120, ...ps },
	level_inputs: { dmarc_published: true, spf_published: false, mta_sts_published: false },
	...extra,
});

const detailRoutes = (over: Record<string, unknown> = {}) => ({
	'GET /api/domains': { domains: [domain] },
	'GET /api/hosted/config': { enabled: true },
	'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
	'GET /api/domains/1/sources': { sources: [] },
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
	'GET /api/domains/1/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
	...over,
});
const detail = (opts: Parameters<typeof renderApp>[1]) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id" element={<DomainDetailPage />} />
		</Routes>,
		{ route: '/domains/1', ...opts },
	);

async function openEnable() {
	const btn = await screen.findByRole('button', { name: 'Enable hosted records' });
	await waitFor(() => expect(btn).toBeEnabled());
	await userEvent.click(btn);
	return within(await screen.findByRole('dialog'));
}

describe('HostedPanel visibility', () => {
	it('is absent and makes no hosted request when config says disabled', async () => {
		const { calls } = detail({ routes: detailRoutes({ 'GET /api/hosted/config': { enabled: false } }) });
		await screen.findByText('example.com');
		await waitFor(() => expect(calls.some((c) => c.path === '/api/hosted/config')).toBe(true));
		expect(screen.queryByText('Hosted records')).not.toBeInTheDocument();
		expect(calls.filter((c) => c.path.includes('/hosted') && c.path !== '/api/hosted/config')).toEqual([]);
	});
	it('is absent when the config request fails', async () => {
		const { calls } = detail({ routes: detailRoutes({ 'GET /api/hosted/config': fail(500) }) });
		await screen.findByText('example.com');
		await waitFor(() => expect(calls.some((c) => c.path === '/api/hosted/config')).toBe(true));
		expect(screen.queryByText('Hosted records')).not.toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/domains/1/hosted')).toBe(false);
	});
});

describe('HostedPanel enable', () => {
	it('enables, shows the addresses once with pointers as record blocks, and drops them on dismiss', async () => {
		let enabled = false;
		const { calls } = detail({
			routes: detailRoutes({
				'GET /api/domains/1/hosted': () => (enabled ? status() : { enabled: false }),
				'POST /api/domains/1/hosted': () => {
					enabled = true;
					return { __status: 201, body: { hosted: status(), addresses } };
				},
			}),
		});
		const dlg = await openEnable();
		await userEvent.type(dlg.getByLabelText(/SPF record/), 'v=spf1 include:x.test -all');
		await userEvent.click(dlg.getByRole('checkbox', { name: /Also host MTA-STS/ }));
		await userEvent.click(dlg.getByRole('button', { name: 'Enable hosted records' }));

		const alert = await screen.findByTestId('hosted-addresses');
		expect(within(alert).getByText(/shown once, copy them now/)).toBeInTheDocument();
		expect(within(alert).getByText(addresses.rua)).toBeInTheDocument();
		expect(within(alert).getByText(addresses.tls_rpt)).toBeInTheDocument();
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ spf_record: 'v=spf1 include:x.test -all', mta_sts: true });

		const list = await screen.findByRole('list', { name: 'Pointer records' });
		expect(within(list).getByText('_dmarc.example.com')).toBeInTheDocument();
		expect(within(list).getByText('abc._dmarc.h.inboxangel.io')).toBeInTheDocument();
		expect(within(list).getAllByRole('button', { name: /^Copy/ }).length).toBeGreaterThanOrEqual(6);
		expect(localStorage.getItem('ia_hosted')).toBeNull();
		expect(JSON.stringify(Object.entries(localStorage))).not.toContain('SECRETTOKEN');

		await userEvent.click(within(alert).getByRole('button', { name: 'I have copied them' }));
		expect(screen.queryByTestId('hosted-addresses')).not.toBeInTheDocument();
		expect(screen.queryByText(addresses.rua)).not.toBeInTheDocument();
	});

	it('does not show addresses on a fresh load of an enabled domain', async () => {
		detail({ routes: detailRoutes({ 'GET /api/domains/1/hosted': status() }) });
		expect(await screen.findByRole('list', { name: 'Pointer records' })).toBeInTheDocument();
		expect(screen.queryByTestId('hosted-addresses')).not.toBeInTheDocument();
	});

	it('422: keeps the dialog open with the server message and the typed SPF', async () => {
		detail({ routes: detailRoutes({ 'GET /api/domains/1/hosted': { enabled: false }, 'POST /api/domains/1/hosted': fail(422, 'SPF record cannot be resolved') }) });
		const dlg = await openEnable();
		await userEvent.type(dlg.getByLabelText(/SPF record/), 'v=spf1 include:bad.test');
		await userEvent.click(dlg.getByRole('button', { name: 'Enable hosted records' }));
		expect(await dlg.findByText('SPF record cannot be resolved')).toBeInTheDocument();
		expect(dlg.getByLabelText(/SPF record/)).toHaveValue('v=spf1 include:bad.test');
		expect(dlg.getByLabelText(/SPF record/)).toBeInvalid();
		expect(dlg.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
	});

	it('502: shows the message and a Retry that tries again', async () => {
		let n = 0;
		detail({ routes: detailRoutes({ 'GET /api/domains/1/hosted': { enabled: false }, 'POST /api/domains/1/hosted': () => (++n === 1 ? fail(502, 'Cloudflare is down') : fail(502, 'Cloudflare is still down')) }) });
		const dlg = await openEnable();
		await userEvent.click(dlg.getByRole('button', { name: 'Enable hosted records' }));
		expect(await dlg.findByText('Cloudflare is down')).toBeInTheDocument();
		await userEvent.click(dlg.getByRole('button', { name: 'Retry' }));
		expect(await dlg.findByText('Cloudflare is still down')).toBeInTheDocument();
		expect(n).toBe(2);
	});

	it('507: shows the message and offers no retry', async () => {
		detail({ routes: detailRoutes({ 'GET /api/domains/1/hosted': { enabled: false }, 'POST /api/domains/1/hosted': fail(507, 'Records zone is full') }) });
		const dlg = await openEnable();
		await userEvent.click(dlg.getByRole('button', { name: 'Enable hosted records' }));
		expect(await dlg.findByText('Records zone is full')).toBeInTheDocument();
		expect(dlg.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
		expect(dlg.getByRole('button', { name: 'Enable hosted records' })).toBeDisabled();
	});

	it('409: refetches and shows the current status', async () => {
		let enabled = false;
		detail({
			routes: detailRoutes({
				'GET /api/domains/1/hosted': () => (enabled ? status() : { enabled: false }),
				'POST /api/domains/1/hosted': () => {
					enabled = true;
					return fail(409, 'Hosted records are already enabled for this domain');
				},
			}),
		});
		const dlg = await openEnable();
		await userEvent.click(dlg.getByRole('button', { name: 'Enable hosted records' }));
		expect(await screen.findByRole('list', { name: 'Pointer records' })).toBeInTheDocument();
		expect(screen.getByText(/already enabled for this domain/)).toBeInTheDocument();
		expect(screen.queryByTestId('hosted-addresses')).not.toBeInTheDocument();
	});
});

describe('HostedPanel status', () => {
	it('shows each pointer state in words, with checked_at, and "Lookup failed" for error', async () => {
		detail({ routes: detailRoutes({ 'GET /api/domains/1/hosted': status({ dmarc: 'ok', spf: 'missing', tls_rpt: 'error' }) }) });
		const list = await screen.findByRole('list', { name: 'Pointer records' });
		expect(within(list).getByText('Verified')).toBeInTheDocument();
		expect(within(list).getByText('Not found')).toBeInTheDocument();
		expect(within(list).getByText('Lookup failed')).toBeInTheDocument();
		expect(screen.getByText('Last checked 2 minutes ago')).toBeInTheDocument();
		expect(screen.getByText(/cannot sit next to other records/)).toBeInTheDocument();
	});

	it('verify now posts, then shows the new states', async () => {
		let verified = false;
		const { calls } = detail({
			routes: detailRoutes({
				'GET /api/domains/1/hosted': () => (verified ? status({ dmarc: 'ok', spf: 'ok', tls_rpt: 'wrong' }) : status({ dmarc: null, spf: null, tls_rpt: null }, { pointer_status: { dmarc: null, spf: null, tls_rpt: null, mta_sts: null, checked_at: null } })),
				'POST /api/domains/1/hosted/verify': () => {
					verified = true;
					return status({ dmarc: 'ok', spf: 'ok', tls_rpt: 'wrong' });
				},
			}),
		});
		expect(await screen.findAllByText('Not checked yet')).not.toHaveLength(0);
		const btn = screen.getByRole('button', { name: /Verify now/ });
		await waitFor(() => expect(btn).toBeEnabled());
		await userEvent.click(btn);
		expect(await screen.findByText('Wrong value')).toBeInTheDocument();
		expect(screen.getAllByText('Verified')).toHaveLength(2);
		expect(calls.some((c) => c.method === 'POST' && c.path === '/api/domains/1/hosted/verify')).toBe(true);
	});

	it('verify failure shows the message with Retry', async () => {
		detail({ routes: detailRoutes({ 'GET /api/domains/1/hosted': status(), 'POST /api/domains/1/hosted/verify': fail(502, 'DNS provider failed') }) });
		const btn = await screen.findByRole('button', { name: /Verify now/ });
		await waitFor(() => expect(btn).toBeEnabled());
		await userEvent.click(btn);
		expect(await screen.findByText('DNS provider failed')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
	});

	it('rotate confirms, explains the 72 h grace, and shows the new addresses once', async () => {
		const { calls } = detail({ routes: detailRoutes({ 'GET /api/domains/1/hosted': status(), 'POST /api/domains/1/hosted/rotate-token': { addresses } }) });
		const btn = await screen.findByRole('button', { name: 'Rotate token' });
		await waitFor(() => expect(btn).toBeEnabled());
		await userEvent.click(btn);
		const dlg = within(await screen.findByRole('dialog'));
		expect(dlg.getByText(/72 hours/)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
		await userEvent.click(dlg.getByRole('button', { name: 'Rotate token' }));
		const alert = await screen.findByTestId('hosted-addresses');
		expect(within(alert).getByText(addresses.rua)).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
	});

	it('disable confirms, explains pointer removal, then DELETEs', async () => {
		let on = true;
		const { calls } = detail({
			routes: detailRoutes({
				'GET /api/domains/1/hosted': () => (on ? status() : { enabled: false }),
				'DELETE /api/domains/1/hosted': () => {
					on = false;
					return { ok: true };
				},
			}),
		});
		const btn = await screen.findByRole('button', { name: 'Disable hosted records' });
		await waitFor(() => expect(btn).toBeEnabled());
		await userEvent.click(btn);
		const dlg = within(await screen.findByRole('dialog'));
		expect(dlg.getByText(/Remove the pointer records from your DNS/)).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await userEvent.click(dlg.getByRole('button', { name: 'Disable hosted records' }));
		expect(await screen.findByRole('button', { name: 'Enable hosted records' })).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/domains/1/hosted')).toBe(true);
	});

	it('members see the status but every write is disabled', async () => {
		detail({ role: 'member', routes: detailRoutes({ 'GET /api/domains/1/hosted': status() }) });
		expect(await screen.findByRole('list', { name: 'Pointer records' })).toBeInTheDocument();
		for (const name of [/Verify now/, 'Rotate token', 'Disable hosted records']) {
			const b = screen.getByRole('button', { name });
			expect(b).toBeDisabled();
			expect(b).toHaveAccessibleDescription(READ_ONLY_REASON);
		}
	});

	it('members cannot enable either', async () => {
		detail({ role: 'member', routes: detailRoutes({ 'GET /api/domains/1/hosted': { enabled: false } }) });
		expect(await screen.findByRole('button', { name: 'Enable hosted records' })).toBeDisabled();
	});
});

describe('DomainLevelCard with hosted records', () => {
	const summary = { domain_id: 1, domain: 'example.com', dmarc_policy: null, spf_record: null, total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null };
	const card = (hosted: unknown, config = true) =>
		renderApp(<DomainLevelCard domain={domain as never} />, {
			routes: {
				'GET /api/hosted/config': { enabled: config },
				'GET /api/domains/1/hosted': hosted,
				'GET /api/domains/1/check-summary': summary,
				'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
				'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
			},
		});

	it('reads level_inputs for a hosted domain whose pointers are verified', async () => {
		const ok = status({ dmarc: 'ok', spf: 'ok' }, { level_inputs: { dmarc_published: true, spf_published: true, mta_sts_published: false } });
		card(ok);
		expect(await screen.findByRole('group', { name: /Level 1/ })).toBeInTheDocument();
	});

	it('does not count a record whose pointer is not verified, and says so', async () => {
		card(status({ dmarc: 'missing', spf: 'ok' }, { level_inputs: { dmarc_published: true, spf_published: true, mta_sts_published: false } }));
		expect(await screen.findByText('DMARC pointer not verified yet')).toBeInTheDocument();
		expect(screen.getByRole('group', { name: /Level 0/ })).toBeInTheDocument();
	});

	it('keeps the stored summary and makes no hosted status request when hosted is off', async () => {
		const { calls } = card({ enabled: false }, false);
		expect(await screen.findByRole('group', { name: /Level 0/ })).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/domains/1/hosted')).toBe(false);
	});

	it('keeps the stored summary for a domain that is not hosted', async () => {
		card({ enabled: false });
		expect(await screen.findByRole('group', { name: /Level 0/ })).toBeInTheDocument();
		expect(screen.queryByText(/pointer not verified/)).not.toBeInTheDocument();
	});
});

describe('MTA-STS wizard on a hosted domain', () => {
	it('shows a dedicated state on 409 instead of the generic error', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/mta-sts" element={<MtaStsPage />} />
			</Routes>,
			{
				route: '/domains/3/mta-sts',
				routes: {
					'GET /api/domains/3/mta-sts': { available: true, config: null, summary: null },
					'POST /api/domains/3/mta-sts': fail(409, 'MTA-STS is hosted for this domain'),
				},
			},
		);
		await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		const enable = await screen.findByRole('button', { name: 'Enable MTA-STS' });
		await waitFor(() => expect(enable).toBeEnabled());
		await userEvent.click(enable);
		expect(await screen.findByText("This domain's MTA-STS is hosted by Inbox Angel")).toBeInTheDocument();
		expect(screen.queryByText('Could not enable MTA-STS')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Enable MTA-STS' })).not.toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Hosted records on the domain page/ })).toHaveAttribute('href', '/domains/3');
	});
});

describe('Domain delete with hosted cleanup failure', () => {
	it('502 says the domain was NOT deleted and offers Retry', async () => {
		let n = 0;
		const { calls } = renderApp(
			<Routes>
				<Route path="/domains/:id/settings" element={<DomainSettingsPage />} />
			</Routes>,
			{
				route: '/domains/1/settings',
				routes: {
					'GET /api/domains': { domains: [domain] },
					'GET /api/domains/1/monitor-subs': { subs: [] },
					'DELETE /api/domains/1': () => (++n === 1 ? fail(502, 'Could not remove the hosted DNS records') : { ok: true }),
				},
			},
		);
		const remove = await screen.findByRole('button', { name: /Remove domain/ });
		await waitFor(() => expect(remove).toBeEnabled());
		await userEvent.click(remove);
		const dlg = within(await screen.findByRole('dialog'));
		await userEvent.click(dlg.getByRole('button', { name: 'Yes, remove' }));
		expect(await dlg.findByText(/Could not remove the hosted DNS records/)).toBeInTheDocument();
		expect(dlg.getByText(/example\.com was NOT deleted/)).toBeInTheDocument();
		await userEvent.click(dlg.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2));
	});
});
