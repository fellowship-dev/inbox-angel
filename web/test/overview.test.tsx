import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { fail, renderApp, type Handler } from './render';

const hoursAgo = (h: number) => Math.floor(Date.now() / 1000) - h * 3600;
const domain = (id: number, name: string, extra = {}) => ({ id, domain: name, dmarc_policy: 'reject', rua_address: 'r@x.io', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, ...extra });
const checked = { dns_checked_at: hoursAgo(3), dns_check_attempted_at: hoursAgo(3), dns_check_status: 'ok' };
const summary = (id: number, name: string, extra = {}) => ({ domain_id: id, domain: name, dmarc_policy: 'reject', spf_record: 'v=spf1 -all', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 3, dmarc_pct: 100, dmarc_sp: 'reject', ...checked, ...extra });
const stats = (passed: number, total = 100) => ({ domain: 'x', days: 30, stats: total ? [{ day: '2026-10-20', total, passed, failed: total - passed }] : [] });
const noReports = stats(0, 0);

/**
 * The overview reads every summary in one request (GET /api/domains/summaries). Tests describe each domain with a
 * per-domain summary and 30-day stats; this folds them into the one batched answer, as the server would.
 */
function toBatch(routes: Record<string, unknown | Handler>): Record<string, unknown | Handler> {
	const out: Record<string, unknown | Handler> = {};
	const sums = new Map<number, any>();
	const st = new Map<number, any>();
	for (const [k, v] of Object.entries(routes)) {
		const m = /^GET \/api\/domains\/(\d+)\/(check-summary|stats)$/.exec(k);
		if (!m) out[k] = v;
		else if (m[2] === 'check-summary') sums.set(Number(m[1]), v);
		else st.set(Number(m[1]), v);
	}
	if (sums.size > 0 && !out['GET /api/domains/summaries']) {
		const summaries = [...sums.entries()].sort(([a], [b]) => a - b).map(([id, s]) => {
			const days = (st.get(id)?.stats ?? []) as Array<{ total: number; passed: number; failed: number }>;
			const t = days.reduce((a, d) => ({ total: a.total + d.total, passed: a.passed + d.passed, failed: a.failed + d.failed }), { total: 0, passed: 0, failed: 0 });
			return { ...s, total_messages: t.total, pass_messages: t.passed, fail_messages: t.failed };
		});
		out['GET /api/domains/summaries'] = { summaries, next_after: null, window_days: 30 };
	}
	return out;
}
const renderOverview = (opts: Parameters<typeof renderApp>[1] = {}): ReturnType<typeof renderApp> => renderApp(<OverviewPage />, { ...opts, routes: toBatch(opts.routes ?? {}) });

/** The row for one domain: a list item named by its domain. */
const row = (name: string | RegExp) => screen.findByRole('listitem', { name });

describe('OverviewPage: one row per domain that answers "am I done?"', () => {
	const routes = {
		'GET /api/domains': {
			domains: [domain(1, 'example.com'), domain(2, 'mail.example.com', { parent_id: 1, dmarc_policy: 'none' }), domain(3, 'bare.org', { dmarc_policy: null }), domain(4, 'ready.net', { dmarc_policy: 'none' })],
		},
		'GET /api/domains/1/check-summary': summary(1, 'example.com'),
		'GET /api/domains/2/check-summary': summary(2, 'mail.example.com', { dmarc_policy: 'none' }),
		'GET /api/domains/3/check-summary': summary(3, 'bare.org', { dmarc_policy: null, spf_record: null }),
		'GET /api/domains/4/check-summary': summary(4, 'ready.net', { dmarc_policy: 'none' }),
		'GET /api/domains/1/stats': stats(99),
		'GET /api/domains/2/stats': stats(80),
		'GET /api/domains/3/stats': noReports,
		'GET /api/domains/4/stats': stats(97),
	};

	it('answers for the whole workspace in one sentence, counting each state', async () => {
		renderOverview({ routes });
		expect(await screen.findByText('Not yet. Of 4 domains, 1 needs attention, 1 is awaiting your approval, 1 is worth fixing and 1 is verified.')).toBeInTheDocument();
		expect(screen.queryByLabelText('Summary')).not.toBeInTheDocument(); // no KPI strip
	});

	it('sorts what needs a person first, keeps a subdomain under its parent, and shows level, state, evidence and the next action', async () => {
		renderOverview({ routes });
		await screen.findByText(/^Not yet\./);
		const names = within(screen.getByRole('region', { name: 'Your domains' })).getAllByRole('listitem').map((li) => li.querySelector('h3')?.textContent);
		// bare.org needs attention; ready.net awaits approval; example.com (verified) carries its subdomain (worth fixing), so its group ranks by the child.
		expect(names).toEqual(['bare.org', 'ready.net', 'example.com', 'mail.example.com']);

		const bare = await row('bare.org');
		expect(within(bare).getByText('Needs attention')).toBeInTheDocument();
		expect(within(bare).getByText('Public DNS shows no SPF and no DMARC record, so receivers cannot verify mail from bare.org.')).toBeInTheDocument();
		expect(within(bare).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level 0 of 2: Delivering');
		expect(within(bare).getByRole('link', { name: 'Publish an SPF record for bare.org' })).toHaveAttribute('href', '/domains/3/setup/2');
		expect(within(bare).getByText('you or your DNS manager:')).toBeInTheDocument();
		expect(within(bare).getByText('Checked 3 hours ago')).toBeInTheDocument();

		const ready = await row('ready.net');
		expect(within(ready).getByText('Awaiting your approval')).toBeInTheDocument();
		expect(within(ready).getByText('97% of 100 reported messages passed DMARC in the last 30 days.')).toBeInTheDocument();
		expect(within(ready).getByRole('link', { name: /Review your senders, then approve p=quarantine/ })).toHaveAttribute('href', '/domains/4/dmarc-wizard');

		const done = await row('example.com');
		expect(within(done).getByText('Verified')).toBeInTheDocument();
		expect(within(done).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level 2 of 2: Protected');
		expect(within(done).getByText('Next: nothing to do.')).toBeInTheDocument();

		const sub = await row('mail.example.com');
		expect(within(sub).getByText('Subdomain of example.com')).toBeInTheDocument();
		expect(within(sub).getByText('Worth fixing')).toBeInTheDocument();
	});

	it('every state is a word and an icon, never colour alone', async () => {
		renderOverview({ routes });
		await screen.findByText(/^Not yet\./);
		for (const li of within(screen.getByRole('region', { name: 'Your domains' })).getAllByRole('listitem')) {
			const label = li.querySelector('[data-status]:not(li)');
			expect(label?.textContent).toMatch(/Needs attention|Awaiting your approval|Worth fixing|Verified/);
			expect(label?.querySelector('svg')).not.toBeNull();
		}
	});

	it('read-only members are sent to the domain page, not into a wizard', async () => {
		renderOverview({ role: 'member', routes });
		const bare = await row('bare.org');
		await waitFor(() => expect(within(bare).getByRole('link', { name: 'Publish an SPF record for bare.org' })).toHaveAttribute('href', '/domains/3'));
		expect(screen.queryByRole('region', { name: 'Get to your first answer' })).not.toBeInTheDocument();
	});

	it('says done, with its scope, only when every domain is verified', async () => {
		renderOverview({
			routes: { 'GET /api/domains': { domains: [domain(1, 'example.com')] }, 'GET /api/domains/1/check-summary': summary(1, 'example.com'), 'GET /api/domains/1/stats': noReports },
		});
		expect(await screen.findByText('Done, from public DNS only: example.com is verified.')).toBeInTheDocument();
		expect(screen.getByText('No DMARC reports in the last 30 days, so nobody has confirmed that every sender passes.')).toBeInTheDocument();
	});
});

describe('OverviewPage: unknown is never "not found"', () => {
	const page = (sum: object, name = 'example.org', stat: object = noReports) =>
		renderOverview({
			routes: {
				'GET /api/domains': { domains: [domain(3, name, { dmarc_policy: null })] },
				'GET /api/domains/3/check-summary': summary(3, name, sum),
				'GET /api/domains/3/stats': stat,
			},
		});

	it('a domain never read from DNS is Unknown, with no level and no "No ... record"', async () => {
		page({ dmarc_policy: null, spf_record: null, dns_checked_at: null, dns_check_attempted_at: null, dns_check_status: null });
		const r = await row('example.org');
		expect(within(r).getByText('Unknown')).toBeInTheDocument();
		expect(within(r).getByText('Nothing has been read from DNS for this domain yet.')).toBeInTheDocument();
		expect(within(r).getByText('Not checked yet')).toBeInTheDocument();
		expect(within(r).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level not known yet');
		expect(within(r).getByText('Level not known yet')).toBeInTheDocument();
		expect(within(r).getByRole('link', { name: /Open the domain to read its records from DNS/ })).toHaveAttribute('href', '/domains/3');
		expect(within(r).queryByText(/No (SPF|DMARC)/)).not.toBeInTheDocument();
	});

	it('a failed check with no good one yet says so, and counts nothing as known', async () => {
		page({ dmarc_policy: null, spf_record: null, dns_checked_at: null, dns_check_attempted_at: hoursAgo(1), dns_check_status: 'failed' });
		const r = await row('example.org');
		expect(within(r).getByText('The last DNS check failed, so nothing is confirmed yet.')).toBeInTheDocument();
		expect(within(r).getByText('Last check failed 1 hour ago. No successful check yet.')).toBeInTheDocument();
		expect(within(r).getByText('Unknown')).toBeInTheDocument();
	});

	it('a failed attempt after a good check keeps what was read, with the failure line', async () => {
		page({ dmarc_policy: 'reject', dns_checked_at: hoursAgo(72), dns_check_attempted_at: hoursAgo(1), dns_check_status: 'failed', dns_last_good_status: 'ok' });
		const r = await row('example.org');
		expect(within(r).getByText('Last check failed 1 hour ago. Last good check 3 days ago.')).toBeInTheDocument();
		expect(within(r).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level 2 of 2: Protected');
		// The latest check failed: what is shown is the last good check, and it is never Verified.
		expect(within(r).getByText('Unknown')).toBeInTheDocument();
		expect(within(r).queryByText('Verified')).not.toBeInTheDocument();
		expect(within(r).getByText(/^The latest DNS check failed\. At the last good check: public DNS shows/)).toBeInTheDocument();
	});

	it('once checked, a missing record is called missing', async () => {
		page({ dmarc_policy: null, spf_record: 'v=spf1 -all' });
		const r = await row('example.org');
		expect(within(r).getByText('Public DNS shows SPF but no DMARC record, so receivers get no instruction for mail that fails.')).toBeInTheDocument();
		expect(within(r).getByRole('link', { name: /Publish a DMARC record with p=none/ })).toHaveAttribute('href', '/domains/3/setup/4');
	});

	it('an inherited policy says where it comes from, and is not "no DMARC"', async () => {
		page({ dmarc_policy: 'reject', dmarc_inherited_from: 'example.org' }, 'mail.example.org');
		const r = await row('mail.example.org');
		expect(within(r).getByText('Public DNS shows SPF and DMARC at p=reject, inherited from example.org, so mail that fails DMARC is rejected.')).toBeInTheDocument();
		expect(within(r).queryByText(/no DMARC/)).not.toBeInTheDocument();
	});

	it('several DMARC records: receivers ignore them; this is a finding, not "not checked"', async () => {
		page({ dmarc_policy: null, dmarc_issue: 'multiple' });
		const r = await row('example.org');
		expect(within(r).getByText('Public DNS shows several DMARC records at _dmarc.example.org, so receivers ignore all of them.')).toBeInTheDocument();
		expect(within(r).getByText('Keep one DMARC record and delete the others')).toBeInTheDocument();
		expect(within(r).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level 0 of 2: Delivering');
	});

	it('an invalid DMARC record is called invalid even if SPF was never read', async () => {
		page({ dmarc_policy: null, dmarc_issue: 'invalid', spf_record: null, dns_checked_at: null, dns_check_status: 'failed' });
		const r = await row('example.org');
		expect(within(r).getByText('The DMARC record at _dmarc.example.org has no valid p= policy, so receivers ignore it.')).toBeInTheDocument();
	});

	it('a domain that does not exist says so, with no level and never "Delivering"', async () => {
		page({ dmarc_policy: null, spf_record: null, dns_check_status: 'nxdomain' }, 'no-such-host.example');
		const r = await row('no-such-host.example');
		expect(within(r).getByText('DNS says no-such-host.example does not exist, so it has no SPF or DMARC records to check.')).toBeInTheDocument();
		expect(within(r).getByText('Needs attention')).toBeInTheDocument();
		// No level is claimed: nothing on the ladder is reached, so it never reads as "Delivering".
		expect(within(r).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level not known yet');
		expect(within(r).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
	});

	it('when the last good check found no such domain and the latest failed, it is Unknown and may have changed', async () => {
		page({ dmarc_policy: null, spf_record: null, dns_checked_at: hoursAgo(30), dns_check_attempted_at: hoursAgo(1), dns_check_status: 'failed', dns_last_good_status: 'nxdomain' }, 'no-such-host.example');
		const r = await row('no-such-host.example');
		expect(within(r).getByText('Unknown')).toBeInTheDocument();
		expect(within(r).getByText(/may have changed/)).toBeInTheDocument();
		expect(within(r).getByText('Last check failed 1 hour ago. At the last good check (1 day ago) this domain did not resolve.')).toBeInTheDocument();
	});

	it('summaries that fail to load make every row Unknown with a retry, never a guessed level', async () => {
		const { calls } = renderOverview({
			routes: {
				'GET /api/domains': { domains: [domain(1, 'ok.com'), domain(2, 'broken.com')] },
				'GET /api/domains/summaries': fail(404, 'summaries unavailable'),
			},
		});
		const broken = await row('broken.com');
		expect(within(broken).getByText(/summaries unavailable/)).toBeInTheDocument();
		expect(within(broken).getByText('Unknown')).toBeInTheDocument();
		expect(within(broken).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Level not known yet');
		expect(screen.getByTestId('am-i-done')).not.toHaveTextContent(/^Done/);
		const before = calls.filter((c) => c.path.startsWith('/api/domains/summaries')).length;
		await userEvent.click(within(broken).getByRole('button', { name: 'Try again' }));
		await waitFor(() => expect(calls.filter((c) => c.path.startsWith('/api/domains/summaries')).length).toBeGreaterThan(before));
	});

	it('makes one request for every summary, not one per domain', async () => {
		const many = Array.from({ length: 12 }, (_, i) => domain(i + 1, `d${i + 1}.com`));
		const routes: Record<string, unknown> = { 'GET /api/domains': { domains: many } };
		many.forEach((d) => (routes[`GET /api/domains/${d.id}/check-summary`] = summary(d.id, d.domain)));
		const { calls } = renderOverview({ routes });
		await screen.findByText(/^Not yet|^Done/);
		expect(calls.filter((c) => c.path.startsWith('/api/domains/summaries'))).toHaveLength(1);
		expect(calls.filter((c) => /\/api\/domains\/\d+\//.test(c.path))).toEqual([]);
	});

	it('reports that are not connected are said to be not connected, not zero', async () => {
		renderOverview({
			routes: {
				'GET /api/domains': { domains: [domain(1, 'example.com', { rua_address: '' })] },
				'GET /api/domains/1/check-summary': summary(1, 'example.com', { dmarc_policy: 'none' }),
				'GET /api/domains/1/stats': noReports,
			},
		});
		const r = await row('example.com');
		expect(within(r).getByText('Reports are not connected for this domain, so nobody has confirmed that every sender passes.')).toBeInTheDocument();
	});
});

describe('OverviewPage: get to a first answer', () => {
	it('an empty workspace teaches the first step, with one action and no Cloudflare detour', async () => {
		renderOverview({ routes: { 'GET /api/domains': { domains: [] } } });
		expect(await screen.findByText('Nothing to check yet: this workspace has no domains.')).toBeInTheDocument();
		const list = screen.getByRole('region', { name: 'Get to your first answer' });
		expect(within(list).getByText('0 of 3 done')).toBeInTheDocument();
		expect(within(list).getByText(/Adding it changes nothing in its DNS/)).toBeInTheDocument();
		expect(within(list).getByRole('link', { name: 'Add a domain' })).toHaveAttribute('href', '/setup');
		expect(screen.queryByRole('link', { name: 'Connect Cloudflare' })).not.toBeInTheDocument();
	});

	it('shows each step from data, and disappears once all are done', async () => {
		const routes = (sum: object, st: object) => ({
			'GET /api/domains': { domains: [domain(1, 'example.com', { dmarc_policy: 'none' })] },
			'GET /api/domains/1/check-summary': summary(1, 'example.com', sum),
			'GET /api/domains/1/stats': st,
		});
		const first = renderOverview({ routes: routes({ dmarc_policy: null, spf_record: null, dns_checked_at: null, dns_check_attempted_at: null, dns_check_status: null }, noReports) });
		const list = await screen.findByRole('region', { name: 'Get to your first answer' });
		await waitFor(() => expect(within(list).getByText('1 of 4 done')).toBeInTheDocument());
		expect(within(list).getByRole('link', { name: 'Open example.com' })).toHaveAttribute('href', '/domains/1');
		expect(within(list).getByText(/not been read from DNS yet/)).toBeInTheDocument();
		first.unmount();

		renderOverview({ routes: routes({ dmarc_policy: 'none' }, stats(97)) });
		await screen.findByText(/^Not yet:/);
		expect(screen.queryByRole('region', { name: 'Get to your first answer' })).not.toBeInTheDocument();
	});

	it('waiting for reports is its own state, not a fake tick', async () => {
		renderOverview({
			routes: {
				'GET /api/domains': { domains: [domain(1, 'example.com', { dmarc_policy: 'none' })] },
				'GET /api/domains/1/check-summary': summary(1, 'example.com', { dmarc_policy: 'none' }),
				'GET /api/domains/1/stats': noReports,
			},
		});
		const list = await screen.findByRole('region', { name: 'Get to your first answer' });
		await waitFor(() => expect(within(list).getByText('3 of 4 done')).toBeInTheDocument());
		const step = within(list).getByText('Receive DMARC reports').closest('li')!;
		expect(step).toHaveAttribute('data-state', 'waiting');
		expect(within(step).getByText('Waiting')).toBeInTheDocument();
	});

	it('a member in an empty workspace is told who adds domains, with no action', async () => {
		renderOverview({ role: 'member', routes: { 'GET /api/domains': { domains: [] } } });
		expect(await screen.findByText('This workspace has no domains yet')).toBeInTheDocument();
		expect(screen.getByText(/An owner or admin adds them/)).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: 'Add a domain' })).not.toBeInTheDocument();
	});

	it('members see the read-only notice and a disabled Add domain', async () => {
		renderOverview({ role: 'member', routes: { 'GET /api/domains': { domains: [] } } });
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: /Add domain/ })).toBeDisabled());
	});

	it('list failure offers a retry', async () => {
		renderOverview({ routes: { 'GET /api/domains': fail(404, 'nope') } });
		expect(await screen.findByText('Could not load your domains')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
	});
});

describe('OverviewPage: pending ownership claims keep the lazy DNS preview', () => {
	const claim = { id: 5, domain: 'acme.com', status: 'pending', txt_name: '_inboxangel-challenge.acme.com', txt_value: 'ia-verify=abc123', created_at: 1700000000, last_checked_at: null, last_error: null };

	it('shows "Check public DNS" on the claim, requests nothing until pressed, and the proof step says the level is visible first', async () => {
		const { calls } = renderOverview({ routes: { 'GET /api/domains': { domains: [], pending_claims: [claim] } } });
		const section = await screen.findByRole('region', { name: 'Waiting for verification' });
		expect(within(section).getByRole('button', { name: 'Check public DNS' })).toBeInTheDocument();
		expect(calls.some((c) => c.path.includes('/claims/5/preview'))).toBe(false);
		expect(screen.getByText('Not yet: 1 domain is waiting for proof that it is yours.')).toBeInTheDocument();
		const step = within(screen.getByRole('region', { name: 'Get to your first answer' })).getByText('Prove it is yours').closest('li')!;
		expect(within(step).getByText(/Its live level from public DNS is visible before proof/)).toBeInTheDocument();
	});
});
