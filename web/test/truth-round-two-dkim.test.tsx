import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { isRevokedDkimKey } from '../src/lib/dkim';
import type { OnboardingStatus } from '../src/lib/types';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { dkimSeverity, splitDkimSelectors, unsignedProviders } from '../src/pages/wizards/setup/steps';
import { renderApp } from './render';

describe('item 2: isRevokedDkimKey reads TXT content the way DNS serves it', () => {
	it.each([
		['plain empty p=', 'v=DKIM1; p=', true],
		['quoted (Cloudflare API content)', '"v=DKIM1; k=rsa; p="', true],
		['split strings', '"v=DKIM1; k=rsa; " "p="', true],
		['split strings, empty p= alone', '"v=DKIM1; k=rsa;" "p=;"', true],
		['quoted with a key', '"v=DKIM1; k=rsa; p=MIGfMA0"', false],
		['key split over two strings', '"v=DKIM1; k=rsa; p=MIGf" "MA0GCSq"', false],
		['CNAME target', 's1.domainkey.u123.wl.sendgrid.net', false],
	])('%s', (_n, record, revoked) => {
		expect(isRevokedDkimKey(record)).toBe(revoked);
	});
});

describe('item 3: the setup wizard agrees with the domain page about revoked keys', () => {
	const google = { name: 'google._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=' };
	const live = { name: 'google._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=MIGfMA0' };

	it('splits usable from revoked, quoted content included', () => {
		const { usable, revoked } = splitDkimSelectors([live, { name: 'old._domainkey.example.com', record: '"v=DKIM1; " "p="' }]);
		expect(usable).toEqual([live]);
		expect(revoked.map((s) => s.name)).toEqual(['old._domainkey.example.com']);
	});

	it('revoked-only selectors are not "good" and do not satisfy a provider in SPF', () => {
		expect(dkimSeverity({ selectors: [google], source: 'cf' }, 'none', 0)).toBe('info');
		expect(dkimSeverity({ selectors: [google], source: 'cf' }, 'reject', 0)).toBe('warning');
		expect(dkimSeverity({ selectors: [live], source: 'cf' }, 'reject', 0)).toBe('good');
		expect(unsignedProviders({ selectors: [google], source: 'cf' }, 'v=spf1 include:_spf.google.com ~all').map((p) => p.name)).toContain('Google Workspace');
		expect(unsignedProviders({ selectors: [live], source: 'cf' }, 'v=spf1 include:_spf.google.com ~all')).toEqual([]);
	});

	const status = (selectors: { name: string; record: string }[]): OnboardingStatus => ({
		domain_id: 7,
		domain: 'example.com',
		rua_address: 'r@reports.example.com',
		cf_available: true,
		dmarc: { found: true, has_our_rua: true, current_record: 'v=DMARC1; p=reject; rua=mailto:r@reports.example.com' },
		spf: { record: 'v=spf1 include:_spf.google.com ~all', lookup_count: 2, flattening_active: false },
		dkim: { selectors, source: 'cf' },
		routing: { mx_found: true, destination_verified: true, reports_domain: 'reports.example.com', admin_email: 'o@example.com', null_sender_spf: true, null_sender_dmarc: true },
	});
	const step = (selectors: { name: string; record: string }[]) =>
		renderApp(
			<Routes>
				<Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} />
			</Routes>,
			{
				route: '/domains/7/setup/3',
				routes: {
					'GET /api/domains': { domains: [{ id: 7, domain: 'example.com', dmarc_policy: 'reject', rua_address: 'r@reports.example.com', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 1 }] },
					'GET /api/domains/7/onboarding-status': status(selectors),
					'GET /api/domains/7/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' },
					'PUT /api/domains/7/wizard-state': {},
					'GET /api/zones': { zones: [] },
				},
			},
		);

	it('DKIM step: a revoked-only selector is shown as revoked, never as a signing provider', async () => {
		step([google]);
		await screen.findByRole('heading', { name: 'DKIM signing' });
		const revoked = await screen.findByRole('region', { name: 'Revoked keys' });
		expect(within(revoked).getByText('Revoked')).toBeInTheDocument();
		expect(screen.queryByRole('region', { name: 'Signing providers' })).toBeNull();
		expect(screen.queryByText('All good')).toBeNull();
		expect(within(screen.getByRole('region', { name: 'Providers without DKIM' })).getByText('Google Workspace')).toBeInTheDocument();
	});

	it('DKIM step: a quoted revoked key (Cloudflare content) is treated the same', async () => {
		step([{ name: 'google._domainkey.example.com', record: '"v=DKIM1; k=rsa; " "p="' }]);
		await screen.findByRole('region', { name: 'Revoked keys' });
		expect(screen.queryByRole('region', { name: 'Signing providers' })).toBeNull();
	});

	it('DKIM step: a usable key still counts as signing', async () => {
		step([live]);
		expect(await screen.findByRole('region', { name: 'Signing providers' })).toBeInTheDocument();
		expect(screen.queryByRole('region', { name: 'Revoked keys' })).toBeNull();
	});
});

describe('review item 5: a quote inside a record is not TXT quoting', () => {
	it('v=DKIM1; n="note"; p=MIGfAB== keeps its key: not revoked', () => expect(isRevokedDkimKey('v=DKIM1; n="note"; p=MIGfAB==')).toBe(false));
	it('an escaped semicolon is decoded: "v=DKIM1\\059 p=" is revoked', () => expect(isRevokedDkimKey('"v=DKIM1\\059 p="')).toBe(true));
	it('Cloudflare-quoted "v=DKIM1; k=rsa; p=" is still revoked', () => expect(isRevokedDkimKey('"v=DKIM1; k=rsa; p="')).toBe(true));
});
