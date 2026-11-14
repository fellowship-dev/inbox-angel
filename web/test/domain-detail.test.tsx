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
	dmarc: { found: true, has_our_rua: false, current_record: current },
	spf: { record: 'v=spf1 include:_spf.google.com -all', lookup_count: 4, flattening_active: false },
	dkim: { selectors: [{ name: 'google._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null },
};

const summary = {
	domain_id: 1, domain: 'example.com', dmarc_policy: 'quarantine', spf_record: 'v=spf1 include:_spf.google.com -all', dns_checked_at: Math.floor(Date.now() / 1000) - 60,
	dns_check_attempted_at: Math.floor(Date.now() / 1000) - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
	total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null,
	spf_lookup_count: 4, dmarc_pct: 100, dmarc_sp: 'quarantine',
};

const routes = (over: Record<string, unknown> = {}) => ({
	'GET /api/domains': { domains: [domain] },
	'GET /api/domains/1/check-summary': summary,
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

/** Collapsed sections hold their content until opened, like a person would. */
const open = async (section: string) => userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${section}`) }));

const page = (opts: Parameters<typeof renderApp>[1]) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id" element={<DomainDetailPage />} />
		</Routes>,
		{ route: '/domains/1', ...opts },
	);

describe('DomainDetailPage DKIM keys', () => {
	const withSelectors = (selectors: Array<{ name: string; record: string }>) => routes({ 'GET /api/domains/1/onboarding-status': { ...onboarding, dkim: { selectors, source: 'doh' } } });

	it('an empty p= is a revoked key: never a pass, never counted as found', async () => {
		page({ routes: withSelectors([{ name: 's1._domainkey.example.com', record: 'v=DKIM1; p=' }, { name: 's2._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=' }]) });
		const row = (await screen.findByText('DKIM selectors')).closest('li') as HTMLElement;
		expect(row).toHaveAttribute('data-status', 'fail');
		expect(within(row).getByText(/No usable DKIM key\. 2 selectors have an empty key \(p=\), which means revoked\./)).toBeInTheDocument();
		expect(within(row).queryByText(/selectors? found/)).not.toBeInTheDocument();
		expect(within(row).getAllByText('Revoked: empty key')).toHaveLength(2);
	});

	it('a wildcard answer is neutral: not a pass, not a missing record', async () => {
		page({ routes: routes({ 'GET /api/domains/1/onboarding-status': { ...onboarding, dkim: { selectors: [], source: 'doh', wildcard: true, wildcard_record: 'v=DMARC1; p=reject' } } }) });
		const row = (await screen.findByText('DKIM selectors')).closest('li') as HTMLElement;
		expect(row).toHaveAttribute('data-status', 'neutral');
		expect(within(row).getByText("Can't tell from public DNS")).toBeInTheDocument();
		expect(within(row).getByText("Every name under example.com answers with the same TXT record, so public DNS can't show which DKIM keys exist.")).toBeInTheDocument();
		expect(within(row).queryByText(/No DKIM record found/)).not.toBeInTheDocument();
	});

	it('counts only usable keys when some are revoked', async () => {
		page({ routes: withSelectors([{ name: 'google._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }, { name: 'old._domainkey.example.com', record: 'v=DKIM1; p=' }]) });
		const row = (await screen.findByText('DKIM selectors')).closest('li') as HTMLElement;
		expect(row).toHaveAttribute('data-status', 'pass');
		expect(within(row).getByText(/1 usable key found\. 1 selector has an empty key/)).toBeInTheDocument();
	});
});

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
		await open('DNS records');
		await open('Rollout');
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

	it('invites only writers to continue an unfinished setup', async () => {
		const wizard = { 'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' } };
		const unfinished = { ...wizard, 'GET /api/domains/1/check-summary': { ...summary, dmarc_policy: 'none', dmarc_sp: 'none' } };
		const owner = page({ routes: routes(unfinished) });
		expect(await screen.findByRole('link', { name: 'Continue setup' })).toBeInTheDocument();
		owner.unmount();
		// A domain DNS shows enforcing has finished setup, whatever the wizard recorded.
		const enforced = page({ routes: routes(wizard) });
		await screen.findByRole('region', { name: 'Where it stands' });
		await screen.findByText(/Public DNS shows SPF and DMARC at p=quarantine/);
		expect(screen.queryByRole('link', { name: 'Continue setup' })).not.toBeInTheDocument();
		enforced.unmount();
		page({ role: 'member', routes: routes(unfinished) });
		expect(await screen.findByRole('heading', { level: 1, name: 'example.com' })).toBeInTheDocument();
		await screen.findByTestId('read-only-notice');
		expect(screen.queryByText(/Setup incomplete/)).not.toBeInTheDocument();
		expect(screen.queryByRole('link', { name: 'Continue setup' })).not.toBeInTheDocument();
	});

	it('shows "Lookup failed", never "Not found", when DNS lookups fail', async () => {
		page({
			routes: routes({
				'GET /api/domains/1/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' },
				'GET /api/domains/1/onboarding-status': { ...onboarding, spf: { record: null, lookup_count: null, flattening_active: false }, dns_errors: ['spf: timeout'] },
			}),
		});
		await open('DNS records');
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
		await open('DNS records');
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
		await open('Rollout');
		await waitFor(() => expect(screen.getByRole('button', { name: /Advance policy/ })).toBeDisabled());
	});

	it('advances only after the confirm dialog, posting the next step', async () => {
		const { calls } = page({ routes: routes({ 'POST /api/domains/1/rollout-advance': { ok: true } }) });
		await open('Rollout');
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
		await open('DNS records');
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
		await open('DNS tools');
		const disable = await screen.findByRole('button', { name: 'Disable' });
		await waitFor(() => expect(disable).toBeEnabled());
		await userEvent.click(disable);
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/domains/1/spf-flatten')).toBe(true));
	});
});

describe('DomainDetailPage: the first screen says what to do', () => {
	it('leads with "Do this next": one to three actions as Do this / Why, with who acts, most urgent first', async () => {
		page({ routes: routes() });
		const section = await screen.findByRole('region', { name: 'Do this next' });
		const items = await within(section).findAllByRole('listitem');
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveAttribute('data-status', 'approval');
		expect(within(items[0]!).getByText('Awaiting your approval')).toBeInTheDocument();
		expect(within(items[0]!).getByText('Approve moving DMARC to p=reject')).toBeInTheDocument();
		expect(within(items[0]!).getByText(/97% of 100 reported messages passed DMARC in the last 7 days/)).toBeInTheDocument();
		expect(within(items[0]!).getByText('An owner or admin')).toBeInTheDocument();
		expect(within(items[0]!).getByRole('link', { name: 'Review the change' })).toHaveAttribute('href', '/domains/1/dmarc-wizard');
		// At p=quarantine the next step (reject) waits on reports, so the missing reports address is the step, not a note.
		expect(items[1]).toHaveAttribute('data-status', 'improve');
		expect(within(items[1]!).getByText('Add the reports address to your DMARC record')).toBeInTheDocument();
		expect(within(items[1]!).getByText('Do this:')).toBeInTheDocument();
		expect(within(items[1]!).getByText('Why:')).toBeInTheDocument();
	});

	it('read-only members see the actions and who makes them, without being sent into a wizard', async () => {
		page({ role: 'member', routes: routes() });
		const section = await screen.findByRole('region', { name: 'Do this next' });
		const [first] = await within(section).findAllByRole('listitem');
		await waitFor(() => expect(within(first!).getByText('An owner or admin makes this change.')).toBeInTheDocument());
		expect(within(first!).queryByRole('link', { name: 'Review the change' })).not.toBeInTheDocument();
	});

	it('then where it stands: the level ladder, the state and its evidence', async () => {
		page({ routes: routes() });
		const section = await screen.findByRole('region', { name: 'Where it stands' });
		expect(await within(section).findByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level 2 of 2: Protected');
		expect(within(section).getByText(/Public DNS shows SPF and DMARC at p=quarantine/)).toBeInTheDocument();
		expect(within(section).getByText('Checked 1 minute ago')).toBeInTheDocument();
	});

	it('collapses records, reports and the health report behind summaries, and opens them on demand', async () => {
		page({ routes: routes() });
		const records = await screen.findByRole('button', { name: /^DNS records/ });
		expect(records).toHaveAttribute('aria-expanded', 'false');
		await waitFor(() => expect(records).toHaveTextContent('DMARC, SPF and 1 DKIM key, read live from public DNS.'));
		expect(screen.queryByRole('list', { name: 'DNS records' })).not.toBeInTheDocument();
		await userEvent.click(records);
		expect(records).toHaveAttribute('aria-expanded', 'true');
		expect(await screen.findByRole('list', { name: 'DNS records' })).toBeInTheDocument();
		// Long lists inside stay behind their count.
		const dkim = screen.getByRole('button', { name: 'Show 1 DKIM record' });
		expect(dkim).toHaveAttribute('aria-expanded', 'false');
		await userEvent.click(dkim);
		expect(screen.getByRole('button', { name: 'Hide the DKIM record' })).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByRole('button', { name: /^Reports/ })).toHaveTextContent('97% of 100 reported messages passed DMARC in the last 7 days.');
		expect(screen.getByRole('button', { name: /^Email health report/ })).toHaveAttribute('aria-expanded', 'false');
	});

	it('headings never skip a level, open or closed', async () => {
		const { container, calls } = page({ routes: routes({ 'GET /api/domains/1/health-report': healthReport }) });
		// The health report runs live DNS: nothing is requested until its section is opened.
		await screen.findByRole('region', { name: 'Do this next' });
		expect(calls.some((c) => c.path.includes('/health-report'))).toBe(false);
		await userEvent.click(await screen.findByRole('button', { name: /^Email health report/ }));
		await screen.findByRole('button', { name: /^Email health report:\s*1 finding and 1 proposed fix/ });
		const levels = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));
		expect(levels[0]).toBe(1);
		expect(container.querySelectorAll('h2')[0]).toHaveTextContent('Do this next');
		levels.reduce((prev, l) => {
			expect(l - prev).toBeLessThanOrEqual(1);
			return l;
		});
	});

	it('a DKIM selector DNS cannot find is Unknown, never "Not found"', async () => {
		page({ routes: routes({ 'GET /api/domains/1/onboarding-status': { ...onboarding, dkim: { selectors: [], source: 'doh' } } }) });
		await open('DNS records');
		const row = (await screen.findByText('DKIM selectors')).closest('li') as HTMLElement;
		expect(within(row).getByText('Unknown')).toBeInTheDocument();
		expect(within(row).queryByText('Not found')).not.toBeInTheDocument();
		const section = screen.getByRole('region', { name: 'Do this next' });
		expect(within(section).getByText('Ask your email provider which DKIM selector it signs with')).toBeInTheDocument();
	});
});

const healthReport = {
	generatedAt: '2026-11-13T00:00:00Z',
	coverage: { detail: 'Observed reports only.' },
	dns: { generatedAt: '2026-11-13T00:00:00Z', findings: [{ id: 'spf-softfail', title: 'SPF ends in ~all', status: 'confirmed', severity: 'low', evidence: ['v=spf1 ~all'], recommendation: 'Consider -all.' }], unchecked: [], lookupFailed: [] },
	remediation: [{ finding: 'spf-softfail', observation: ['~all'], impact: 'Soft fail.', steps: ['Change ~all to -all.'], prerequisites: ['Every sender listed.'], changes: [], verification: ['Re-run the report.'] }],
	sections: Object.fromEntries(['dmarc', 'tls', 'google', 'inbox_placement'].map((k) => [k, { status: 'unavailable', reason: 'no_reports', source: k, population: 'none', window: { since: 1700000000, until: 1700100000 }, data: null }])),
};

describe('DomainDetailPage: a domain added elsewhere', () => {
	it('refetches the cached list once before saying "not found"', async () => {
		let n = 0;
		const { calls } = page({ routes: routes({ 'GET /api/domains': () => (n++ === 0 ? { domains: [] } : { domains: [domain] }) }) });
		expect(await screen.findByRole('heading', { level: 1, name: 'example.com' })).toBeInTheDocument();
		expect(screen.queryByText('Domain not found')).not.toBeInTheDocument();
		expect(calls.filter((c) => c.path === '/api/domains').length).toBe(2);
	});

	it('still missing after that one refetch: says so, once', async () => {
		const { calls } = page({ routes: routes({ 'GET /api/domains': { domains: [] } }) });
		expect(await screen.findByText('Domain not found')).toBeInTheDocument();
		expect(calls.filter((c) => c.path === '/api/domains').length).toBe(2);
	});
});
