import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { DomainSettingsPage } from '../src/pages/domains/DomainSettingsPage';
import { fail, renderApp } from './render';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const domain = { id: 1, domain: 'example.com', dmarc_policy: 'none', rua_address: 'r@reports.test', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };
const noRua = { ...domain, rua_address: '' };

describe('item 1: no reports address is never rendered as an empty mailto', () => {
	const settings = (d: typeof domain, dns: unknown) =>
		renderApp(
			<Routes>
				<Route path="/domains/:id/settings" element={<DomainSettingsPage />} />
			</Routes>,
			{ route: '/domains/1/settings', routes: { 'GET /api/domains': { domains: [d] }, 'GET /api/domains/1/monitor-subs': { subs: [] }, 'GET /api/domains/1/dns-check': dns } },
		);

	it('settings page: says so, shows no empty rua=mailto: and no empty copy field', async () => {
		settings(noRua, { found: false, has_rua: false, current_record: null, cf_managed: false });
		expect(await screen.findByText('No reports address is configured for this domain.')).toBeInTheDocument();
		expect(await screen.findByText('v=DMARC1; p=none')).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/mailto:\s*(;|$|\s)/);
		expect(screen.queryByRole('button', { name: 'Copy rua address' })).toBeNull();
	});

	it('detail page: says so instead of a bare rua=mailto:', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id" element={<DomainDetailPage />} />
			</Routes>,
			{
				route: '/domains/1',
				routes: {
					'GET /api/domains': { domains: [noRua] },
					'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
					'GET /api/domains/1/sources': { sources: [] },
					'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
					'GET /api/domains/1/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
				},
			},
		);
		expect(await screen.findByText(/No reports address is configured for this domain, so there is no rua= value to add yet/)).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/rua=mailto:(\s|$)/);
	});

	it('add-domain page: the record to publish has no rua= when there is no address', async () => {
		renderApp(<AddDomainPage />, {
			routes: {
				'GET /api/zones': fail(400),
				'POST /api/domains': { domain: { ...noRua, id: 7, domain: 'new.example.org' }, rua_hint: '' },
				'GET /api/domains/7/dns-check': { found: true, has_rua: false, current_record: 'v=DMARC1; p=none', cf_managed: false },
			},
		});
		await userEvent.type(await screen.findByLabelText('Your domain'), 'new.example.org');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('v=DMARC1; p=none')).toBeInTheDocument();
		expect(await screen.findByText(/No reports address is configured for this domain, so there is no rua= to look for/)).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/rua=mailto:(\s|$)/);
	});
});

describe('item 4: settings offers a record built from the live one', () => {
	const settings = (dns: unknown) =>
		renderApp(
			<Routes>
				<Route path="/domains/:id/settings" element={<DomainSettingsPage />} />
			</Routes>,
			{ route: '/domains/1/settings', routes: { 'GET /api/domains': { domains: [{ ...domain, dmarc_policy: 'none' }] }, 'GET /api/domains/1/monitor-subs': { subs: [] }, 'GET /api/domains/1/dns-check': dns } },
		);

	it('a live p=reject is never offered as p=none (stored policy is stale) and other tags survive', async () => {
		settings({ found: true, has_rua: true, current_record: 'v=DMARC1; p=reject; sp=quarantine; pct=50; rua=mailto:r@reports.test', cf_managed: false });
		expect(await screen.findByText('v=DMARC1; p=reject; sp=quarantine; pct=50; rua=mailto:r@reports.test')).toBeInTheDocument();
		expect(document.body.textContent).not.toContain('p=none');
	});

	it('a failed lookup offers no invented record and says it could not be checked', async () => {
		settings({ found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' });
		expect(await screen.findByText(/live DMARC record could not be checked, so no record is offered/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Copy dmarc record' })).toBeNull();
		expect(document.body.textContent).not.toContain('v=DMARC1');
	});
});

describe('item 10: read-only members do not get the Upgrade button', () => {
	const detail = (role: 'owner' | 'member') =>
		renderApp(
			<Routes>
				<Route path="/domains/:id" element={<DomainDetailPage />} />
			</Routes>,
			{
				role,
				route: '/domains/1',
				routes: {
					'GET /api/domains': { domains: [domain] },
					'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [{ day: '2026-10-20', total: 100, passed: 99, failed: 1 }] },
					'GET /api/domains/1/sources': { sources: [] },
					'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
					'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: 'v=DMARC1; p=none', cf_managed: false },
				},
			},
		);

	it('owner sees it', async () => {
		detail('owner');
		expect(await screen.findByRole('link', { name: 'Upgrade to quarantine' })).toBeInTheDocument();
	});

	it('member sees the guidance but not the button', async () => {
		detail('member');
		expect(await screen.findByText('Monitoring only, not enforcing')).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole('link', { name: /Upgrade to/ })).toBeNull());
	});
});
