import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConnectReports } from '../src/components/reports/ConnectReports';
import { READ_ONLY_REASON } from '../src/lib/session';
import { fail, renderApp } from './render';
import { uncountedReporters } from '../src/lib/uncounted';
import { ownRecordFromInherited } from '@ready-set-mail/dns-checks/dmarc-rua';
import { inheritedCoverage, offerEnforcement, recordFor } from '../src/lib/dmarc-coverage';

const ADDR = 'rua@rua.example.net';
const domain = { id: 1, domain: 'example.com' };
const NOW = Math.floor(Date.now() / 1000);
const view = (over: Record<string, unknown> = {}) => ({
	available: true,
	domain_id: 1,
	domain: 'example.com',
	managed_by: null,
	can_connect: true,
	refusal: null,
	address: null,
	connected_at: null,
	last_report_at: null,
	counted_since_connect: 0,
	reports_since_connect: 0,
	reports_before_connect: 0,
	visibility: null,
	state: 'not_connected',
	dns: null,
	...over,
});
const issued = (plan: unknown, over: Record<string, unknown> = {}) =>
	view({ address: ADDR, state: 'not_published', dns: { checked_at: NOW, error: null, plan }, ...over });
const ON = { 'GET /api/hosted/config': { enabled: true, reports: true, records: false } };

const show = (routes: Record<string, unknown>, role: 'owner' | 'admin' | 'member' = 'owner') => renderApp(<ConnectReports domain={domain} />, { role, routes: { ...ON, ...routes } });

describe('ConnectReports visibility', () => {
	it('renders nothing and asks for nothing unless the deployment issues report addresses', async () => {
		const { calls } = renderApp(<ConnectReports domain={domain} />, { routes: { 'GET /api/hosted/config': { enabled: true } } });
		await waitFor(() => expect(calls.some((c) => c.path === '/api/hosted/config')).toBe(true));
		expect(screen.queryByTestId('connect-reports')).not.toBeInTheDocument();
		expect(calls.some((c) => c.path.includes('report-address'))).toBe(false);
	});
	it('renders nothing when the config request fails', async () => {
		const { calls } = renderApp(<ConnectReports domain={domain} />, { routes: { 'GET /api/hosted/config': fail(500) } });
		await waitFor(() => expect(calls.some((c) => c.path === '/api/hosted/config')).toBe(true));
		expect(screen.queryByTestId('connect-reports')).not.toBeInTheDocument();
	});
});

describe('Connect reports', () => {
	it('connects, then shows the live record with it added and the state', async () => {
		let current: unknown = view();
		const plan = { kind: 'add', name: '_dmarc.example.com', current: 'v=DMARC1; p=reject; rua=mailto:a@example.com', record: `v=DMARC1; p=reject; rua=mailto:a@example.com,mailto:${ADDR}`, created: false };
		const { calls } = show({
			'GET /api/domains/1/report-address': () => current,
			'POST /api/domains/1/report-address': () => {
				current = issued(plan);
				return { __status: 201, body: current };
			},
			'GET /api/domains': { domains: [] },
		});
		expect(await screen.findByText('Reports not connected yet')).toBeInTheDocument();
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		expect(screen.getByText(ADDR)).toBeInTheDocument();
		expect(screen.getByText(plan.record)).toBeInTheDocument();
		expect(screen.getByText('Only rua= changes: the policy and every other tag stay as they are.')).toBeInTheDocument();
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
	});

	it('a domain with no DMARC record gets a p=none record, said plainly', async () => {
		show({ 'GET /api/domains/1/report-address': issued({ kind: 'add', name: '_dmarc.example.com', current: null, record: `v=DMARC1; p=none; rua=mailto:${ADDR}`, created: true }) });
		expect(await screen.findByText(`v=DMARC1; p=none; rua=mailto:${ADDR}`)).toBeInTheDocument();
		expect(screen.getByText(/p=none asks receivers for reports and changes nothing/)).toBeInTheDocument();
	});

	it('two addresses already: no record until the person chooses which to replace, or to add a third knowingly', async () => {
		const options = [
			{ replaces: 'mailto:a@x.test', record: `v=DMARC1; p=reject; rua=mailto:${ADDR},mailto:b@y.test` },
			{ replaces: 'mailto:b@y.test', record: `v=DMARC1; p=reject; rua=mailto:a@x.test,mailto:${ADDR}` },
			{ replaces: null, record: `v=DMARC1; p=reject; rua=mailto:a@x.test,mailto:b@y.test,mailto:${ADDR}` },
		];
		show({
			'GET /api/domains/1/report-address': issued({ kind: 'choose', name: '_dmarc.example.com', current: 'v=DMARC1; p=reject; rua=mailto:a@x.test,mailto:b@y.test', existing: ['mailto:a@x.test', 'mailto:b@y.test'], options, created: false }),
		});
		expect(await screen.findByText(/already lists 2 report addresses/)).toBeInTheDocument();
		expect(screen.getByText('Choose an option to see the record to publish.')).toBeInTheDocument();
		for (const o of options) expect(screen.queryByText(o.record)).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole('radio', { name: /Replace mailto:b@y\.test/ }));
		expect(screen.getByText(options[1]!.record)).toBeInTheDocument();
		await userEvent.click(screen.getByRole('radio', { name: /Keep both and add this address third/ }));
		expect(screen.getByText(options[2]!.record)).toBeInTheDocument();
		expect(screen.getByText('Some receivers may never send reports to a third address.')).toBeInTheDocument();
	});

	it('a subdomain that inherits: names the organizational domain and what its own record means', async () => {
		show({
			'GET /api/domains/1/report-address': issued({
				kind: 'inherited',
				from: 'parent.test',
				parent_record: 'v=DMARC1; p=reject',
				policy: 'reject',
				policy_tag: 'p',
				parent_has_address: false,
				own: { kind: 'add', name: '_dmarc.example.com', current: null, record: `v=DMARC1; p=reject; rua=mailto:${ADDR}`, created: true },
			}),
		});
		expect(await screen.findByText(/has no DMARC record of its own/)).toBeInTheDocument();
		expect(screen.getByText(/add parent\.test to this workspace and connect reports there instead/)).toBeInTheDocument();
		expect(screen.getByText(/Later changes to parent\.test/)).toBeInTheDocument();
		expect(screen.getByText(`v=DMARC1; p=reject; rua=mailto:${ADDR}`)).toBeInTheDocument();
	});

	it('several DMARC records: says receivers ignore them, offers no record', async () => {
		show({ 'GET /api/domains/1/report-address': issued({ kind: 'multiple', name: '_dmarc.example.com', records: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] }) });
		expect(await screen.findByText('_dmarc.example.com has 2 DMARC records')).toBeInTheDocument();
		expect(screen.getByText(/Receivers ignore all of them/)).toBeInTheDocument();
	});

	it('a failed lookup reads as unknown, never as "not published"', async () => {
		show({ 'GET /api/domains/1/report-address': issued(null, { state: 'unknown', dns: { checked_at: NOW, error: 'SERVFAIL', plan: null } }) });
		expect(await screen.findByText('Connected, DNS check failed')).toBeInTheDocument();
		expect(screen.getByText(/that does not mean the record is missing/)).toBeInTheDocument();
		expect(screen.queryByText('Connected, record not published yet')).not.toBeInTheDocument();
	});

	it('published, then receiving with the time of the last report', async () => {
		const pub = { kind: 'published', name: '_dmarc.example.com', record: `v=DMARC1; p=reject; rua=mailto:${ADDR}` };
		const { unmount } = show({ 'GET /api/domains/1/report-address': issued(pub, { state: 'waiting' }) });
		expect(await screen.findByText('Published, waiting for the first report')).toBeInTheDocument();
		expect(screen.getByText(/Receivers send reports about once a day/)).toBeInTheDocument();
		unmount();
		show({ 'GET /api/domains/1/report-address': issued(pub, { state: 'receiving', last_report_at: NOW - 3600, counted_since_connect: 2, reports_since_connect: 2, reports_before_connect: 3 }) });
		expect(await screen.findByText('Reports received')).toBeInTheDocument();
		expect(screen.getByText(/Last counted report received .*\(1 hour ago\)/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open the reports' })).toHaveAttribute('href', '/domains/1/reports');
		expect(screen.getByText('3 reports received before this connection.')).toBeInTheDocument();
	});

	it('disconnect asks first, then calls the API', async () => {
		const plan = { kind: 'published', name: '_dmarc.example.com', record: 'x' };
		let current: unknown = issued(plan, { state: 'waiting' });
		const { calls } = show({
			'GET /api/domains/1/report-address': () => current,
			'DELETE /api/domains/1/report-address': () => (current = view()),
			'GET /api/domains': { domains: [] },
		});
		expect(screen.queryByRole('button', { name: 'New address' })).not.toBeInTheDocument();
		await userEvent.click(await screen.findByRole('button', { name: 'Disconnect reports' }));
		const d = within(await screen.findByRole('dialog'));
		expect(d.getByText(/From now on, reports about example\.com are refused/)).toBeInTheDocument();
		await userEvent.click(d.getByRole('button', { name: 'Disconnect reports' }));
		expect(await screen.findByText('Reports not connected yet')).toBeInTheDocument();
		expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/domains/1/report-address']);
	});

	it('a read-only member sees the state; connect and disconnect are disabled and say why', async () => {
		const { unmount, calls } = show({ 'GET /api/domains/1/report-address': view() }, 'member');
		const connect = await screen.findByRole('button', { name: 'Connect reports' });
		await waitFor(() => expect(connect).toBeDisabled());
		expect(screen.getAllByText(READ_ONLY_REASON).length).toBeGreaterThan(0);
		unmount();
		show({ 'GET /api/domains/1/report-address': issued({ kind: 'published', name: 'n', record: 'x' }, { state: 'waiting' }) }, 'member');
		expect(await screen.findByText('Published, waiting for the first report')).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect reports' })).toBeDisabled());
		expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
	});

	it('a refused domain says why instead of offering the action; hosted-records domains point there', async () => {
		const { unmount } = show({ 'GET /api/domains/1/report-address': view({ can_connect: false, refusal: 'example.com was added before ownership checks.' }) });
		expect(await screen.findByText('example.com was added before ownership checks.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect reports' })).not.toBeInTheDocument();
		unmount();
		show({ 'GET /api/domains/1/report-address': view({ managed_by: 'hosted_records', can_connect: false }) });
		expect(await screen.findByText('Reports for example.com come through its hosted records.')).toBeInTheDocument();
	});

	it('a connect that fails says so and keeps the button', async () => {
		show({ 'GET /api/domains/1/report-address': view(), 'POST /api/domains/1/report-address': fail(403, 'example.com was added before ownership checks.') });
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(await screen.findByText('Could not connect reports')).toBeInTheDocument();
		expect(screen.getByText('example.com was added before ownership checks.')).toBeInTheDocument();
	});

	it('bare (inside a "not connected" container): only the action before an address exists, the full state after', async () => {
		let current: unknown = view();
		renderApp(<ConnectReports domain={domain} bare />, {
			routes: {
				...ON,
				'GET /api/domains/1/report-address': () => current,
				'POST /api/domains/1/report-address': () => (current = issued({ kind: 'add', name: '_dmarc.example.com', current: null, record: `v=DMARC1; p=none; rua=mailto:${ADDR}`, created: true })),
				'GET /api/domains': { domains: [] },
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Connect reports' }));
		expect(screen.queryByText('Reports not connected yet')).not.toBeInTheDocument();
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'DMARC reports' })).not.toBeInTheDocument();
	});

	it('inherited, parent connected in this workspace: says the reports arrive with the parent, links to it', async () => {
		show({
			'GET /api/domains/1/report-address': issued(
				{ kind: 'inherited', from: 'parent.test', parent_record: 'v=DMARC1; p=reject', policy: 'reject', policy_tag: 'p', parent_has_address: false, own: { kind: 'add', name: '_dmarc.example.com', current: null, record: `v=DMARC1; p=reject; rua=mailto:${ADDR}`, created: true } },
				{ parent: { domain_id: 9, domain: 'parent.test', connected: true } },
			),
		});
		expect(await screen.findByText(/is connected here, so once its record lists the report address/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'parent.test' })).toHaveAttribute('href', '/domains/9');
	});

	const inherited = (over: Record<string, unknown>, parent: unknown) =>
		issued(
			{ kind: 'inherited', from: 'parent.test', parent_record: 'v=DMARC1; p=reject; sp=quarantine', policy: 'quarantine', policy_tag: 'sp', parent_has_address: false, own: { kind: 'add', name: '_dmarc.example.com', current: null, record: `v=DMARC1; p=quarantine; rua=mailto:${ADDR}`, created: true }, ...over },
			{ parent },
		);

	it('inherited: names sp= when the parent sets it, and gives one true sentence for each case', async () => {
		const cases: Array<[Record<string, unknown>, unknown, RegExp]> = [
			[{ parent_has_address: true }, { domain_id: 9, domain: 'parent.test', connected: true }, /record lists the report address and parent\.test is connected here, so reports about example\.com are filed with parent\.test's reports/],
			[{ parent_has_address: true }, { domain_id: 9, domain: 'parent.test', connected: false }, /is not connected in this workspace, so those reports are refused/],
			[{ parent_has_address: true }, null, /is not in this workspace, so its reports, including those about example\.com, are not filed here/],
			[{}, null, /add parent\.test to this workspace and connect reports there instead/],
		];
		for (const [over, parent, sentence] of cases) {
			const { unmount } = show({ 'GET /api/domains/1/report-address': inherited(over, parent) });
			const route = await screen.findByTestId('inherited-route');
			expect(route.textContent).toMatch(sentence);
			expect(screen.getByText(/sp=quarantine applies to its subdomains/)).toBeInTheDocument();
			expect(screen.queryByText(/only accepts reports about/)).not.toBeInTheDocument();
			unmount();
		}
	});

	it('an invalid live record: says so, offers no record and no "only rua= changes"', async () => {
		show({ 'GET /api/domains/1/report-address': issued({ kind: 'invalid', name: '_dmarc.example.com', record: 'v=DMARC1; p=bogus', issues: ['Invalid p= value "bogus"'] }) });
		expect(await screen.findByText('The DMARC record at _dmarc.example.com is not valid')).toBeInTheDocument();
		expect(screen.getByText(/Fix it first, then check again/)).toBeInTheDocument();
		expect(screen.queryByText(/Only rua= changes/)).not.toBeInTheDocument();
		expect(screen.queryByText('Replace the TXT record at _dmarc.example.com with')).not.toBeInTheDocument();
	});

	it('a record over 255 characters is shown as quoted strings and says why', async () => {
		const long = `v=DMARC1; p=reject; rua=mailto:${'a'.repeat(240)}@x.test,mailto:${ADDR}`;
		show({ 'GET /api/domains/1/report-address': issued({ kind: 'add', name: '_dmarc.example.com', current: 'v=DMARC1; p=reject', record: long, created: false }) });
		expect(await screen.findByText(/longer than 255 characters/)).toBeInTheDocument();
		expect(screen.getByText(`"${long.slice(0, 255)}" "${long.slice(255)}"`)).toBeInTheDocument();
	});

	it('reports received before connecting, or while the record is not published, are a note, not "received"', async () => {
		show({ 'GET /api/domains/1/report-address': issued({ kind: 'add', name: '_dmarc.example.com', current: null, record: 'x', created: true }, { reports_since_connect: 1, reports_before_connect: 2 }) });
		expect(await screen.findByText('Connected, record not published yet')).toBeInTheDocument();
		expect(screen.getByText('2 reports received before this connection.')).toBeInTheDocument();
		expect(screen.queryByText('Reports received')).not.toBeInTheDocument();
	});

	it('published, only uncounted reports since connecting: still waiting, with the shared notices (uncounted, dropped, counting basis)', async () => {
		const pub = { kind: 'published', name: '_dmarc.example.com', record: `v=DMARC1; p=reject; rua=mailto:${ADDR}` };
		const visibility = {
			report_counting: 'registry',
			counting_note: null,
			uncounted: { reports: 3, messages: 3, latest_at: NOW, unknown: 1, unauthenticated: 2, by_reporter: [] },
			intake: { status: 'limited', limit: 'counted_storage_dropped', notice: null, dropped: [{ reporter: 'google', label: 'Google', since: '2026-11-14T03:12:00Z', last_at: '2026-11-14T04:00:00Z', messages: 2, text: '' }], not_processed: { messages: 0, last_at: null, reasons: [] } },
		};
		show({ 'GET /api/domains/1/report-address': issued(pub, { state: 'waiting', reports_since_connect: 3, counted_since_connect: 0, visibility }) });
		expect(await screen.findByText('Published, waiting for the first report')).toBeInTheDocument();
		const notices = screen.getAllByTestId('reports-notice').map((n) => n.textContent);
		expect(notices[0]).toMatch(/^Report storage limit reached; reports from Google since .* were not stored$/);
		expect(notices).toContain('1 report from a sender we do not recognise is not counted. 2 reports from senders that could not be authenticated are not counted.');
		expect(screen.getByText('Only reports from known reporters are counted.')).toBeInTheDocument();
		expect(screen.queryByText('Reports received')).not.toBeInTheDocument();
	});

	it.each([
		['v=DMARC1; p=reject', 'reject'],
		['v=DMARC1; p=quarantine; pct=5', 'quarantine'],
		['v=DMARC1; p=reject; sp=quarantine; pct=25; adkim=s; aspf=s', 'quarantine'],
		['v=DMARC1; p=reject; sp=none; pct=10; aspf=r', 'none'],
		['v=DMARC1; p=quarantine; adkim=S; fo=1; ruf=mailto:f@x.test; rua=mailto:a@x.test,mailto:b@y.test', 'quarantine'],
	])('parity: the server and the dashboard offer the same inherited record (%s)', (parent, policy) => {
		const e = offerEnforcement(inheritedCoverage('parent.test', parent, policy))!;
		expect(ownRecordFromInherited(parent, policy, ADDR)).toBe(recordFor(e, ADDR));
	});

	it('inherited record shown carries pct and alignment, and says so', async () => {
		show({ 'GET /api/domains/1/report-address': inherited({ parent_record: 'v=DMARC1; p=reject; sp=quarantine; pct=25; adkim=s', policy: 'quarantine' }, null) });
		expect(await screen.findByText(`v=DMARC1; p=quarantine; pct=25; adkim=s; rua=mailto:${ADDR}`)).toBeInTheDocument();
		expect(screen.getByText(/It keeps the inherited sp=quarantine as its p=quarantine at pct=25 with adkim=s, so nothing changes for its mail/)).toBeInTheDocument();
	});

	it('a subdomain\'s own record says the parent\'s failure-report settings (ruf=, fo=) are not carried over, only when the parent has them', async () => {
		const { unmount } = show({ 'GET /api/domains/1/report-address': inherited({ parent_record: 'v=DMARC1; p=reject; ruf=mailto:f@parent.test; fo=1', policy: 'reject', policy_tag: 'p' }, null) });
		expect(await screen.findByText(/parent\.test's failure-report settings \(ruf=, fo=\) are not carried over: no failure reports are requested for example\.com\./)).toBeInTheDocument();
		unmount();
		show({ 'GET /api/domains/1/report-address': inherited({ parent_record: 'v=DMARC1; p=reject', policy: 'reject', policy_tag: 'p' }, null) });
		expect(await screen.findByText(/It keeps p=reject/)).toBeInTheDocument();
		expect(screen.queryByText(/failure-report settings/)).not.toBeInTheDocument();
	});

	it('an unverified sender is never named by what it wrote: "an unverified sender (claims to be …)"', async () => {
		expect(uncountedReporters({ uncounted: { reports: 3, messages: 3, latest_at: null, by_reporter: [{ reporter: 'unverified sender', reports: 2, unverified: true, claims: 'google.com' }, { reporter: 'evil.example', reports: 1 }] } })).toBe(
			'From an unverified sender (claims to be google.com) (2), evil.example (1)',
		);
		const pub = { kind: 'published', name: '_dmarc.example.com', record: `v=DMARC1; p=reject; rua=mailto:${ADDR}` };
		const visibility = { report_counting: 'registry', counting_note: null, uncounted: { reports: 1, messages: 1, latest_at: NOW, unknown: 0, unauthenticated: 1, by_reporter: [{ reporter: 'unverified sender', reports: 1, unverified: true, claims: 'google.com' }] } };
		show({ 'GET /api/domains/1/report-address': issued(pub, { state: 'waiting', reports_since_connect: 1, visibility }) });
		expect(await screen.findByText('From an unverified sender (claims to be google.com) (1)')).toBeInTheDocument();
		expect(screen.queryByText(/From google\.com/)).not.toBeInTheDocument();
	});
});

