import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { fail, renderApp } from './render';

const domain = (id: number, name: string, extra = {}) => ({ id, domain: name, dmarc_policy: 'reject', rua_address: 'r@x.io', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, ...extra });
const summary = (id: number, name: string, extra = {}) => ({ domain_id: id, domain: name, dmarc_policy: 'reject', spf_record: 'v=spf1 -all', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, ...extra });
const stats = (id: number) => ({ domain: 'x', days: 7, stats: [{ day: '2026-10-20', total: 100, passed: 97, failed: 3 }] });
const wizard = (done: number) => ({ domain: done > 0 ? 'complete' : 'not_started', spf: done > 1 ? 'complete' : 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' });

describe('OverviewPage', () => {
	it('shows a level card per domain, nests children, and links to continue setup', async () => {
		renderApp(<OverviewPage />, {
			routes: {
				'GET /api/domains': { domains: [domain(1, 'example.com'), domain(2, 'mail.example.com', { parent_id: 1, dmarc_policy: 'none' }), domain(3, 'bare.org', { dmarc_policy: null })] },
				'GET /api/domains/1/check-summary': summary(1, 'example.com'),
				'GET /api/domains/2/check-summary': summary(2, 'mail.example.com', { dmarc_policy: 'none' }),
				'GET /api/domains/3/check-summary': summary(3, 'bare.org', { dmarc_policy: null, spf_record: null }),
				'GET /api/domains/1/stats': stats(1),
				'GET /api/domains/2/stats': stats(2),
				'GET /api/domains/3/stats': { domain: 'bare.org', days: 7, stats: [] },
				'GET /api/domains/1/wizard-state': wizard(2),
				'GET /api/domains/2/wizard-state': wizard(2),
				'GET /api/domains/3/wizard-state': wizard(0),
			},
		});
		const levels = await screen.findAllByRole('group', { name: /Level \d/ });
		expect(levels.map((l) => /Level (\d)/.exec(l.textContent ?? '')?.[1])).toEqual(['2', '1', '0']);
		expect(screen.getAllByText(/97% pass rate over 7 days/)).toHaveLength(2);
		expect(screen.getAllByText('No reports in the last 7 days.').length).toBe(1);
		const continueLinks = screen.getAllByRole('link', { name: /Continue setup \(2\/5\)/ });
		expect(continueLinks[0]).toHaveAttribute('href', '/domains/1/setup/3');
	});

	it('shows an error instead of a level when a summary fails, and does not downgrade the domain', async () => {
		const { calls } = renderApp(<OverviewPage />, {
			routes: {
				'GET /api/domains': { domains: [domain(1, 'ok.com'), domain(2, 'broken.com')] },
				'GET /api/domains/1/check-summary': summary(1, 'ok.com'),
				'GET /api/domains/2/check-summary': fail(404, 'summary unavailable'),
				'GET /api/domains/1/stats': stats(1),
				'GET /api/domains/2/stats': stats(2),
				'GET /api/domains/1/wizard-state': wizard(2),
				'GET /api/domains/2/wizard-state': wizard(2),
			},
		});
		const broken = await screen.findByRole('group', { name: 'broken.com' });
		expect(within(broken).getByText('Could not load')).toBeInTheDocument();
		expect(within(broken).getByText(/summary unavailable/)).toBeInTheDocument();
		expect(within(broken).getByRole('button', { name: /try again/i })).toBeInTheDocument();
		expect(within(broken).queryByText(/Level \d/)).toBeNull();
		// the healthy one still shows its level
		expect(await screen.findAllByText(/Level 2/)).toHaveLength(1);
		expect(calls.some((c) => c.path.includes('/domains/2/check-summary'))).toBe(true);
	});

	it('empty state points to setup; list failure offers a retry', async () => {
		renderApp(<OverviewPage />, { routes: { 'GET /api/domains': { domains: [] } } });
		expect(await screen.findByText('No domains yet')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/setup');
	});

	it('list failure offers a retry', async () => {
		renderApp(<OverviewPage />, { routes: { 'GET /api/domains': fail(404, 'nope') } });
		expect(await screen.findByText('Could not load your domains')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
	});

	it('members see the read-only notice and a disabled Add domain', async () => {
		renderApp(<OverviewPage />, { role: 'member', routes: { 'GET /api/domains': { domains: [] } } });
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: /Add domain/ })).toBeDisabled());
	});
});
