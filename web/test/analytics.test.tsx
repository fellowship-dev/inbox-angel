import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router';
import { FixList } from '../src/components/analytics/FixList';
import { ReadinessCard } from '../src/components/analytics/ReadinessCard';
import { SenderInventory } from '../src/components/analytics/SenderInventory';
import { TrendChart } from '../src/components/analytics/TrendChart';
import { bucketTrend, fmtPct, senderName, type Fix, type Readiness, type Sender } from '../src/lib/analytics';
import { AnalyticsPage, DomainAnalyticsPage } from '../src/pages/analytics/AnalyticsPage';
import { fail, renderApp } from './render';

async function renderReady(ui: Parameters<typeof renderApp>[0]) {
	const r = renderApp(ui);
	await waitFor(() => expect(r.container).not.toBeEmptyDOMElement());
	return r;
}

const sender = (o: Partial<Sender> = {}): Sender => ({
	source_ip: '198.2.180.1', reverse_dns: 'mail1.mcsv.net', base_domain: 'mcsv.net', org: 'The Rocket Science Group', country_code: 'US',
	provider: { id: 'mailchimp', name: 'Mailchimp', evidence: 'authenticated as mcsv.net' }, domains: ['acme.com'], messages: 240, share_pct: 12, spf_aligned_pct: 0, dkim_aligned_pct: 0, dmarc_pass_pct: 0,
	spf_domain: 'mcsv.net', dkim_domain: 'mcsv.net', first_seen: 1_760_000_000, last_seen: 1_760_900_000, is_new: false, ...o,
});

const fix = (o: Partial<Fix> = {}): Fix => ({
	id: 'authorize:1:p:mailchimp', kind: 'authorize-sender', severity: 'high', domain: 'acme.com', domain_id: 1, sender: { name: 'Mailchimp', provider_id: 'mailchimp', ips: ['198.2.180.1'] },
	title: 'Mailchimp sends 12% of your mail and fails DMARC', detail: '100% of what Mailchimp sent failed.', share_pct: 12, affected_pct: 12, affected_messages: 240,
	steps: ['Add include:servers.mcsv.net to the SPF record of acme.com.', 'Turn on custom-domain DKIM signing.'],
	records: [{ type: 'TXT', name: 'acme.com', value: 'v=spf1 include:_spf.google.com include:servers.mcsv.net ~all' }], guide_url: 'https://mailchimp.com/help/', ...o,
});

const readiness = (o: Partial<Readiness> = {}): Readiness => ({
	status: 'caution', headline: 'You can move to p=quarantine; t=y, with care', current: { policy: 'none', testing: false, step: 0, label: 'p=none' }, next: { policy: 'quarantine', testing: true, label: 'p=quarantine; t=y' },
	total_steps: 5, reasons: [{ level: 'ok', text: '1,910 messages over 20 days with reports.' }, { level: 'warn', text: 'Mailchimp fails DMARC on 12% of your mail.' }, { level: 'block', text: 'A blocker.' }],
	metrics: { messages: 1910, pass_rate: 86.4, days_with_reports: 20, window_days: 30 }, policy_source: 'dns', ...o,
});

const trend = (n: number) => Array.from({ length: n }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, total: 100, passed: 90, failed: 10 }));

describe('lib/analytics', () => {
	it('names a sender by provider, else host and owner, else IP', async () => {
		expect(senderName(sender())).toBe('Mailchimp');
		expect(senderName(sender({ provider: null }))).toBe('mail1.mcsv.net (The Rocket Science Group)');
		expect(senderName(sender({ provider: null, reverse_dns: null, base_domain: null, org: null }))).toBe('198.2.180.1');
	});
	it('formats percentages', async () => {
		expect(fmtPct(12)).toBe('12%');
		expect(fmtPct(12.6)).toBe('13%');
		expect(fmtPct(4.25)).toBe('4.3%');
		expect(fmtPct(null)).toBe('n/a');
	});
	it('folds days into Monday-start weeks, keeping totals', async () => {
		const days = [{ day: '2026-10-19', total: 10, passed: 9, failed: 1 }, { day: '2026-10-25', total: 10, passed: 8, failed: 2 }, { day: '2026-10-26', total: 5, passed: 5, failed: 0 }];
		expect(bucketTrend(days, 'week')).toEqual([{ day: '2026-10-19', total: 20, passed: 17, failed: 3 }, { day: '2026-10-26', total: 5, passed: 5, failed: 0 }]);
		expect(bucketTrend(days, 'day')).toBe(days);
	});
});

describe('TrendChart', () => {
	it('draws a described chart and offers the same numbers as a table', async () => {
		await render30();
		expect(screen.getByRole('img', { name: /Stacked columns of messages per day/ })).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Table' }));
		const table = screen.getByRole('table');
		expect(within(table).getAllByRole('row')).toHaveLength(1 + 20);
		expect(within(table).getAllByText('90%')).toHaveLength(20);
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});
	it('names failed mail without colour (hatched legend entry) and says so for empty windows', async () => {
		await render30();
		expect(screen.getByText(/Failed DMARC \(hatched\)/)).toBeInTheDocument();
	});
	it('shows an empty state with no reports', async () => {
		await renderReady(<TrendChart trend={trend(5).map((d) => ({ ...d, total: 0, passed: 0, failed: 0 }))} days={7} />);
		expect(screen.getByText('No reports in this window')).toBeInTheDocument();
	});
	it('goes weekly at 90 days', async () => {
		await renderReady(<TrendChart trend={trend(28)} days={90} />);
		await userEvent.click(await screen.findByRole('button', { name: 'Table' }));
		expect(screen.getByText('Week of')).toBeInTheDocument();
	});
});
async function render30() {
	await renderReady(<TrendChart trend={trend(20)} days={30} />);
}

describe('SenderInventory', () => {
	it('says new and failing in words, with the rates as text', async () => {
		await renderReady(<SenderInventory senders={[sender({ is_new: true }), sender({ source_ip: '1.1.1.1', provider: null, reverse_dns: null, base_domain: null, org: null, spf_aligned_pct: 100, dkim_aligned_pct: 100, dmarc_pass_pct: 100, messages: 1670, share_pct: 88 })]} />);
		const table = await screen.findByRole('table', { name: 'Sender inventory' });
		const rows = within(table).getAllByRole('row');
		expect(within(rows[1]!).getByText('New sender')).toBeInTheDocument();
		expect(within(rows[1]!).getByText('Likely failing')).toBeInTheDocument();
		expect(within(rows[1]!).queryByText('Fails DMARC')).not.toBeInTheDocument();
		expect(within(rows[1]!).getByText(/SPF aligned, failing/)).toBeInTheDocument();
		expect(within(rows[2]!).getByText(/DKIM aligned, passing/)).toBeInTheDocument();
		expect(within(rows[2]!).queryByText('Likely failing')).not.toBeInTheDocument();
		expect(within(rows[1]!).getByText('12% of mail')).toBeInTheDocument();
	});
	it('says the figures are estimates, why, and what was checked', async () => {
		await renderReady(<SenderInventory senders={[sender()]} alignment={alignment} />);
		expect(screen.getByText('These alignment figures are estimates.')).toBeInTheDocument();
		expect(screen.getByText(/signed twice/)).toBeInTheDocument();
		expect(screen.getByText(/relaxed alignment only: we could not read your record, so adkim=s \/ aspf=s would not be applied/)).toBeInTheDocument();
		expect(screen.getByRole('columnheader', { name: 'SPF aligned (est.)' })).toBeInTheDocument();
		expect(screen.getByText('Scroll sideways to see every column.')).toBeInTheDocument();
		cleanup();
		await renderReady(<SenderInventory senders={[sender()]} alignment={{ ...alignment, spf: 'strict', basis: 'dns' }} />);
		expect(screen.getByText(/Checked with strict SPF and relaxed DKIM alignment, from your published DMARC record/)).toBeInTheDocument();
	});
	it('has an empty state', async () => {
		await renderReady(<SenderInventory senders={[]} />);
		expect(screen.getByText('No senders in this window')).toBeInTheDocument();
	});
});

describe('FixList', () => {
	it('ranks, names the impact in words and offers copyable records plus the guide', async () => {
		await renderReady(<FixList fixes={[fix(), fix({ id: 'x', kind: 'review-new-sender', severity: 'low', title: 'New sender: SendGrid', records: [], guide_url: null, affected_messages: 0 })]} showDomain />);
		const items = screen.getAllByRole('listitem').filter((li) => li.querySelector('h3'));
		expect(items).toHaveLength(2);
		expect(within(items[0]!).getByRole('heading')).toHaveTextContent(/Mailchimp sends 12% of your mail and fails DMARC/);
		expect(within(items[0]!).getByText('High impact')).toBeInTheDocument();
		expect(within(items[0]!).getByRole('link', { name: 'acme.com' })).toHaveAttribute('href', '/domains/1/analytics');
		expect(within(items[0]!).getByText('v=spf1 include:_spf.google.com include:servers.mcsv.net ~all')).toBeInTheDocument();
		expect(within(items[0]!).getByRole('button', { name: 'Copy value' })).toBeInTheDocument();
		expect(within(items[0]!).getByRole('link', { name: /Mailchimp setup guide/ })).toHaveAttribute('href', 'https://mailchimp.com/help/');
		expect(within(items[1]!).getByText('Low impact')).toBeInTheDocument();
	});
	it('says when there is nothing to fix', async () => {
		await renderReady(<FixList fixes={[]} />);
		expect(screen.getByText('Nothing to fix right now')).toBeInTheDocument();
	});
});

describe('ReadinessCard', () => {
	it('shows the verdict, step, and each reason with a word, not only colour', async () => {
		await renderReady(<ReadinessCard readiness={readiness()} />);
		expect(screen.getByText('You can move to p=quarantine; t=y, with care')).toBeInTheDocument();
		expect(screen.getByText('Proceed with care')).toBeInTheDocument();
		expect(screen.getByText(/step 1 of 5/)).toBeInTheDocument();
		expect(screen.getByText('OK:')).toBeInTheDocument();
		expect(screen.getByText('Careful:')).toBeInTheDocument();
		expect(screen.getByText('Blocker:')).toBeInTheDocument();
		expect(screen.getByText(/policy published in DNS right now/)).toBeInTheDocument();
	});
	it('admits when it fell back to the stored policy', async () => {
		await renderReady(<ReadinessCard readiness={readiness({ policy_source: 'stored' })} />);
		expect(screen.getByText(/last known policy \(the live DNS lookup failed\)/)).toBeInTheDocument();
	});
});

const alignment = { spf: 'relaxed', dkim: 'relaxed', basis: 'assumed', estimated: true } as const;
const domainData = {
	alignment,
	days: 30, domain: { id: 1, domain: 'acme.com' }, totals: { messages: 1910, passed: 1610, failed: 300, pass_rate: 84.3, days_with_reports: 20 }, trend: trend(20),
	senders: [sender()], sender_count: 1, fixes: [fix()], readiness: readiness(),
};
const domains = { domains: [{ id: 1, domain: 'acme.com', dmarc_policy: 'none', rua_address: 'r@x', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 0 }] };

describe('analytics pages', () => {
	it('domain page: readiness, fixes, trend and senders; the window drives the request', async () => {
		const { calls } = renderApp(
			<Routes><Route path="/domains/:id/analytics" element={<DomainAnalyticsPage />} /></Routes>,
			{ route: '/domains/1/analytics', routes: { 'GET /api/domains': domains, 'GET /api/domains/1/analytics': domainData } },
		);
		expect(await screen.findByRole('heading', { name: 'What to fix next' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Enforcement readiness' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Sender inventory' })).toBeInTheDocument();
		expect(screen.getByText('84%')).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
		await waitFor(() => expect(calls.some((c) => c.path === '/api/domains/1/analytics?days=7')).toBe(true));
	});

	it('workspace page: per-domain readiness links to the domain', async () => {
		renderApp(<AnalyticsPage />, {
			routes: {
				'GET /api/analytics': {
					...domainData, domain: undefined, readiness: undefined,
					domains: [{ domain_id: 1, domain: 'acme.com', dmarc_policy: 'none', messages: 1910, pass_rate: 84.3, readiness: { status: 'blocked', headline: 'Not safe to move to p=quarantine; t=y yet', next: null, policy_source: 'stored' } }],
				},
			},
		});
		const links = await screen.findAllByRole('link', { name: 'acme.com' });
		expect(links.length).toBeGreaterThan(0);
		links.forEach((l) => expect(l).toHaveAttribute('href', '/domains/1/analytics'));
		expect(screen.getByText('Not yet')).toBeInTheDocument();
	});

	it('shows a retryable error, not an empty page', async () => {
		renderApp(<AnalyticsPage />, { routes: { 'GET /api/analytics': fail(400, 'bad window') } });
		expect(await screen.findByText('Could not load analytics')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});
});
