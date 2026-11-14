import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { MembersPage } from '../src/pages/members/MembersPage';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import { BulkImportPage } from '../src/pages/domains/BulkImportPage';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { ReportBrowserPage } from '../src/pages/reports/ReportBrowserPage';
import { fail, renderApp } from './render';

const claim = (over = {}) => ({ id: 5, domain: 'acme.com', status: 'pending', txt_name: '_readysetmail-challenge.acme.com', txt_value: 'ia-verify=abc123', created_at: 1700000000, last_checked_at: null, last_error: null, ...over });
const domain = { id: 9, domain: 'acme.com', dmarc_policy: 'none', rua_address: 'r@x.io', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };

describe('pending domain claims', () => {
	it('lists them in their own section with TXT instructions and no stats calls', async () => {
		const { calls } = renderApp(<OverviewPage />, { routes: { 'GET /api/domains': { domains: [], pending_claims: [claim(), claim({ id: 6, domain: 'lost.com', status: 'lost' })] } } });
		const section = await screen.findByRole('region', { name: 'Waiting for verification' });
		expect(within(section).getByText('_readysetmail-challenge.acme.com')).toBeInTheDocument();
		expect(within(section).getByText('ia-verify=abc123')).toBeInTheDocument();
		expect(within(section).getByText('TXT')).toBeInTheDocument();
		expect(within(section).getByText('Another workspace verified this domain first, so it cannot be added to this one.')).toBeInTheDocument();
		expect(within(section).queryByText(/contact support/)).not.toBeInTheDocument();
		expect(within(section).getAllByRole('button', { name: 'Verify' })).toHaveLength(1);
		expect(screen.queryByText('No domains yet')).not.toBeInTheDocument();
		expect(calls.some((c) => /\/domains\/\d+\//.test(c.path))).toBe(false);
	});

	it('shows no section when there are none (self-host)', async () => {
		renderApp(<OverviewPage />, { routes: { 'GET /api/domains': { domains: [] } } });
		await screen.findByText('Nothing to check yet: this workspace has no domains.');
		expect(screen.queryByText('Waiting for verification')).not.toBeInTheDocument();
		// Self-host adds a domain straight away: no ownership step in the first-answer list.
		expect(screen.queryByText('Prove it is yours')).not.toBeInTheDocument();
	});

	it('shows the 422 reason inline when the TXT is not found, and removes a claim', async () => {
		const { calls } = renderApp(<OverviewPage />, {
			routes: {
				'GET /api/domains': { domains: [], pending_claims: [claim()] },
				'POST /api/domains/claims/5/verify': { __status: 422, body: { verified: false, error: 'TXT record not found yet', claim: claim() } },
				'DELETE /api/domains/claims/5': { ok: true },
			},
		});
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Verify' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('TXT record not found yet');
		await user.click(screen.getByRole('button', { name: 'Remove acme.com' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/domains/claims/5')).toBe(true));
	});

	it('Add domain answering 202 shows the instructions, and verifying moves on to the domain', async () => {
		renderApp(<AddDomainPage />, {
			routes: {
				'GET /api/zones': fail(400),
				'POST /api/domains': { __status: 202, body: { pending: true, claim: claim(), domain: null } },
				'POST /api/domains/claims/5/verify': { domain },
				'GET /api/domains/9/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
				'GET /api/domains/9/onboarding-status': { domain_id: 9, dmarc: { found: false, has_our_rua: false, current_record: null, effective: { policy: null, inherited_from: null, issue: null, record: null } } },
			},
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Your domain'), 'acme.com');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('ia-verify=abc123')).toBeInTheDocument();
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Verify' }));
		expect(await screen.findByText('Add this DNS record')).toBeInTheDocument();
	});

	it('bulk import shows pending results with their instructions', async () => {
		renderApp(<BulkImportPage />, {
			routes: { 'POST /api/domains/bulk-import': { imported: 0, total: 1, results: [{ domain: 'acme.com', status: 'pending', claim: claim() }] } },
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Domains'), 'acme.com');
		await user.click(screen.getByRole('button', { name: 'Import domains' }));
		expect((await screen.findAllByText('Waiting for verification')).length).toBeGreaterThan(0);
		expect(screen.getByText('ia-verify=abc123')).toBeInTheDocument();
	});
});

describe('reporter tier badge', () => {
	const report = (id: number, extra = {}) => ({ id, domain: 'example.com', org_name: `Org${id}`, report_id: `r${id}`, date_begin: 1760000000, date_end: 1760086400, total_count: 10, pass_count: 10, fail_count: 0, ...extra });
	it('flags unknown and unauthenticated senders, and says which reports are not counted', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/reports" element={<ReportBrowserPage />} />
			</Routes>,
			{
				route: '/domains/1/reports',
				routes: {
					'GET /api/domains': { domains: [{ id: 1, domain: 'example.com' }] },
					'GET /api/reports?limit=200': { reports: [report(1, { reporter_tier: 'counted', counted: true }), report(2, { reporter_tier: 'unknown', counted: false }), report(3, { reporter_tier: 'unauthenticated', counted: false }), report(4, { reporter_tier: null, counted: false })] },
				},
			},
		);
		await screen.findByText(/Org1/);
		expect(screen.getAllByText(/sender not recognised/)).toHaveLength(1);
		expect(screen.getAllByText(/unauthenticated sender/)).toHaveLength(1);
		expect(screen.getAllByTitle(/not on the list of known reporters/)).toHaveLength(1);
		expect(screen.getAllByTitle(/could not be authenticated/)).toHaveLength(1);
		expect(screen.getAllByText(/not counted in your numbers/)).toHaveLength(3);
	});
});

describe('team invites', () => {
	const team = { users: [{ id: 'o1', email: 'owner@example.com', name: 'Owner', role: 'owner', last_login_at: null, created_at: 1 }], current_user_id: 'o1' };
	const invites = { invites: [{ id: 'i1', email: 'pending@example.com', role: 'member', invited_by: 'owner@example.com', created_at: 1760000000, expires_at: 1760600000 }] };

	it('lists pending invites and revokes one', async () => {
		let list = invites.invites;
		const { calls } = renderApp(<MembersPage />, {
			role: 'owner',
			routes: { 'GET /api/team': team, 'GET /api/team/invites': () => ({ invites: list }), 'DELETE /api/team/invites/i1': () => ((list = []), { ok: true }) },
		});
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Revoke invite for pending@example.com' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/team/invites/i1')).toBe(true));
		await waitFor(() => expect(screen.queryByText('pending@example.com')).not.toBeInTheDocument());
	});

	it('offers the admin role to owners only', async () => {
		const routes = { 'GET /api/team': team, 'GET /api/team/invites': { invites: [] } };
		const { unmount } = renderApp(<MembersPage />, { role: 'owner', routes });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('combobox', { name: 'Role' }));
		expect(await screen.findByRole('option', { name: 'Admin' })).toBeInTheDocument();
		unmount();
		renderApp(<MembersPage />, { role: 'admin', routes });
		await user.click(await screen.findByRole('combobox', { name: 'Role' }));
		await screen.findByRole('option', { name: /Member/ });
		expect(screen.queryByRole('option', { name: 'Admin' })).not.toBeInTheDocument();
	});
});
