import type { ReactElement } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AnomaliesPage } from '../src/pages/reports/AnomaliesPage';
import { ExplorePage } from '../src/pages/reports/ExplorePage';
import { ReportBrowserPage } from '../src/pages/reports/ReportBrowserPage';
import { ReportDetailPage } from '../src/pages/reports/ReportDetailPage';
import { fail, renderApp } from './render';

const domains = { domains: [{ id: 1, domain: 'example.com' }, { id: 2, domain: 'other.org' }] };
const today = new Date().toISOString().slice(0, 10);

const source = (over: Record<string, unknown> = {}) => ({
	source_ip: '1.1.1.1',
	header_from: 'example.com',
	spf_domain: null,
	dkim_domain: null,
	total: 10,
	spf_pass: 0,
	dkim_pass: 0,
	first_seen: '2026-01-01',
	last_seen: today,
	base_domain: null,
	org: null,
	...over,
});

const page = (el: ReactElement, path: string, route: string, routes: Record<string, unknown>) =>
	renderApp(
		<Routes>
			<Route path={path} element={el} />
		</Routes>,
		{ route, routes: { 'GET /api/domains': domains, ...routes } },
	);

describe('ExplorePage', () => {
	it('shows an empty state for no sources', async () => {
		page(<ExplorePage />, '/domains/:id/explore', '/domains/1/explore', { 'GET /api/domains/1/explore': { days: 30, domain: 'example.com', sources: [] } });
		expect(await screen.findByText('No sources in the last 30 days')).toBeInTheDocument();
		expect(screen.getByText(/No DMARC reports received yet/)).toBeInTheDocument();
	});

	it('filters to anomalies and refetches when the window changes', async () => {
		const user = userEvent.setup();
		const { calls } = page(<ExplorePage />, '/domains/:id/explore', '/domains/1/explore', {
			'GET /api/domains/1/explore': { days: 30, domain: 'example.com', sources: [source({ org: 'Bad Co' }), source({ source_ip: '2.2.2.2', org: 'Good Co', spf_pass: 1, dkim_pass: 1 })] },
		});
		expect(await screen.findByText('Good Co')).toBeInTheDocument();
		expect(screen.getByText('SPF + DKIM fail')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: /Anomalies, 1 source/ }));
		expect(screen.queryByText('Good Co')).not.toBeInTheDocument();
		expect(screen.getByText('Bad Co')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Last 90 days' }));
		await waitFor(() => expect(calls.some((c) => c.path === '/api/domains/1/explore?days=90')).toBe(true));
	});

	it('offers a retry on error', async () => {
		page(<ExplorePage />, '/domains/:id/explore', '/domains/1/explore', { 'GET /api/domains/1/explore': fail(404, 'Domain not found') });
		expect(await screen.findByText('Domain not found')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});
});

describe('AnomaliesPage', () => {
	it('shows the all-clear empty state', async () => {
		page(<AnomaliesPage />, '/domains/:id/anomalies', '/domains/1/anomalies', { 'GET /api/domains/1/anomalies': { days: 30, domain: 'example.com', anomalies: [] } });
		expect(await screen.findByText('No anomalies in the last 30 days')).toBeInTheDocument();
	});

	it('splits active from older sources', async () => {
		page(<AnomaliesPage />, '/domains/:id/anomalies', '/domains/1/anomalies', {
			'GET /api/domains/1/anomalies': { days: 90, domain: 'example.com', anomalies: [source({ org: 'Fresh Inc' }), source({ source_ip: '9.9.9.9', org: 'Stale Inc', last_seen: '2020-01-01' })] },
		});
		const active = await screen.findByRole('region', { name: 'Active anomalies' });
		const older = screen.getByRole('region', { name: 'Older anomalies' });
		expect(within(active).getByText('Fresh Inc')).toBeInTheDocument();
		expect(within(older).getByText('Stale Inc')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Active: 1 source' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Older: 1 source' })).toBeInTheDocument();
	});
});

describe('ReportBrowserPage', () => {
	const report = (id: number, domain: string, org: string) => ({ id, domain, org_name: org, report_id: `r${id}`, date_begin: 1_760_000_000, date_end: 1_760_086_400, total_count: 20, pass_count: 19, fail_count: 1 });
	const routes = { 'GET /api/reports': { reports: [report(1, 'example.com', 'google.com'), report(2, 'other.org', 'yahoo.com')] } };

	it('filters to the route domain by default, with an All domains toggle', async () => {
		const user = userEvent.setup();
		page(<ReportBrowserPage />, '/domains/:id/reports', '/domains/1/reports', routes);
		expect(await screen.findByText('google.com')).toBeInTheDocument();
		expect(screen.queryByText('yahoo.com')).not.toBeInTheDocument();
		expect(screen.getByText('1 report')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'All domains' }));
		expect(screen.getByText('yahoo.com')).toBeInTheDocument();
		expect(screen.getByText('2 reports')).toBeInTheDocument();
		// Rows of another domain link to that domain, not the route's.
		const links = screen.getAllByRole('link', { name: /2025/ });
		expect(links.map((l) => l.getAttribute('href'))).toEqual(['/domains/1/reports/2025-10-09', '/domains/2/reports/2025-10-09']);
	});

	it('explains an empty list', async () => {
		page(<ReportBrowserPage />, '/domains/:id/reports', '/domains/1/reports', { 'GET /api/reports': { reports: [] } });
		expect(await screen.findByText('No reports for example.com yet')).toBeInTheDocument();
		expect(screen.getByText(/DMARC reports arrive daily from mail providers/)).toBeInTheDocument();
	});
});

describe('ReportDetailPage', () => {
	it('splits failing from passing sources and expands passing rows', async () => {
		const user = userEvent.setup();
		page(<ReportDetailPage />, '/domains/:id/reports/:date', '/domains/1/reports/2026-10-01', {
			'GET /api/domains/1/reports': {
				date: '2026-10-01',
				domain: 'example.com',
				summary: { total: 30, passed: 20, failed: 10 },
				sources: [
					{ source_ip: '1.1.1.1', header_from: 'example.com', spf_domain: 'mailchimp.com', dkim_domain: null, count: 10, spf_pass: 0, dkim_pass: 1, disposition: 'none', reporters: 'google.com', base_domain: null, org: 'Mailchimp' },
					{ source_ip: '2.2.2.2', header_from: 'example.com', spf_domain: 'example.com', dkim_domain: 'example.com', count: 20, spf_pass: 1, dkim_pass: 1, disposition: 'none', reporters: 'yahoo.com', base_domain: null, org: 'Fastmail' },
				],
			},
		});
		expect(await screen.findByText('30 messages analyzed — 10 need attention.')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
		expect(screen.getByText(/Add include:mailchimp.com to your SPF record/)).toBeInTheDocument();
		const row = screen.getByRole('button', { name: /Fastmail/ });
		expect(row).toHaveAttribute('aria-expanded', 'false');
		await user.click(row);
		expect(row).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByText('yahoo.com')).toBeInTheDocument();
	});

	it('says when nothing was received', async () => {
		page(<ReportDetailPage />, '/domains/:id/reports/:date', '/domains/1/reports/2026-10-01', {
			'GET /api/domains/1/reports': { date: '2026-10-01', domain: 'example.com', summary: { total: 0, passed: 0, failed: 0 }, sources: [] },
		});
		expect(await screen.findByText('No reports received for this date')).toBeInTheDocument();
	});
});
