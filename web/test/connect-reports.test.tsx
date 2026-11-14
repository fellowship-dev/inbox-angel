import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConnectReports } from '../src/components/reports/ConnectReports';
import { READ_ONLY_REASON } from '../src/lib/session';
import { fail, renderApp } from './render';

const ADDR = 'rua+abcdefghijklmnopqrstuvwxyz234567@rua.example.net';
const domain = { id: 1, domain: 'example.com' };
const NOW = Math.floor(Date.now() / 1000);
const view = (over: Record<string, unknown> = {}) => ({
	available: true,
	domain_id: 1,
	domain: 'example.com',
	managed_by: null,
	can_issue: true,
	refusal: null,
	address: null,
	issued_at: null,
	rotated_at: null,
	previous_valid_until: null,
	last_report_at: null,
	state: 'not_issued',
	dns: null,
	...over,
});
const issued = (plan: unknown, over: Record<string, unknown> = {}) =>
	view({ address: ADDR, issued_at: NOW - 60, state: 'not_published', dns: { checked_at: NOW, error: null, plan }, ...over });
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
	it('issues the address, then shows the live record with it added and the state', async () => {
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
		expect(await screen.findByText('Address issued, record not published yet')).toBeInTheDocument();
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
				parent_has_address: false,
				own: { kind: 'add', name: '_dmarc.example.com', current: null, record: `v=DMARC1; p=reject; rua=mailto:${ADDR}`, created: true },
			}),
		});
		expect(await screen.findByText(/has no DMARC record of its own/)).toBeInTheDocument();
		expect(screen.getByText(/connect reports on parent\.test instead/)).toBeInTheDocument();
		expect(screen.getByText(/later changes to parent\.test/)).toBeInTheDocument();
		expect(screen.getByText(`v=DMARC1; p=reject; rua=mailto:${ADDR}`)).toBeInTheDocument();
	});

	it('several DMARC records: says receivers ignore them, offers no record', async () => {
		show({ 'GET /api/domains/1/report-address': issued({ kind: 'multiple', name: '_dmarc.example.com', records: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] }) });
		expect(await screen.findByText('_dmarc.example.com has 2 DMARC records')).toBeInTheDocument();
		expect(screen.getByText(/Receivers ignore all of them/)).toBeInTheDocument();
	});

	it('a failed lookup reads as unknown, never as "not published"', async () => {
		show({ 'GET /api/domains/1/report-address': issued(null, { state: 'unknown', dns: { checked_at: NOW, error: 'SERVFAIL', plan: null } }) });
		expect(await screen.findByText('Address issued, DNS check failed')).toBeInTheDocument();
		expect(screen.getByText(/that does not mean the record is missing/)).toBeInTheDocument();
		expect(screen.queryByText('Address issued, record not published yet')).not.toBeInTheDocument();
	});

	it('published, then receiving with the time of the last report', async () => {
		const pub = { kind: 'published', name: '_dmarc.example.com', record: `v=DMARC1; p=reject; rua=mailto:${ADDR}` };
		const { unmount } = show({ 'GET /api/domains/1/report-address': issued(pub, { state: 'waiting' }) });
		expect(await screen.findByText('Published, waiting for the first report')).toBeInTheDocument();
		expect(screen.getByText(/Receivers send reports about once a day/)).toBeInTheDocument();
		unmount();
		show({ 'GET /api/domains/1/report-address': issued(pub, { state: 'receiving', last_report_at: NOW - 3600 }) });
		expect(await screen.findByText('Receiving reports')).toBeInTheDocument();
		expect(screen.getByText(/Last report received .*\(1 hour ago\)/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open the reports' })).toHaveAttribute('href', '/domains/1/reports');
	});

	it('rotate and disconnect each ask first, then call the API', async () => {
		const plan = { kind: 'published', name: '_dmarc.example.com', record: 'x' };
		let current: unknown = issued(plan, { state: 'waiting' });
		const { calls } = show({
			'GET /api/domains/1/report-address': () => current,
			'POST /api/domains/1/report-address/rotate': () => (current = issued(plan, { previous_valid_until: NOW + 72 * 3600 })),
			'DELETE /api/domains/1/report-address': () => (current = view()),
			'GET /api/domains': { domains: [] },
		});
		await userEvent.click(await screen.findByRole('button', { name: 'New address' }));
		const d1 = within(await screen.findByRole('dialog'));
		expect(d1.getByText(/keeps working for 72 hours/)).toBeInTheDocument();
		await userEvent.click(d1.getByRole('button', { name: 'Issue a new address' }));
		expect(await screen.findByText(/The previous address keeps working until/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Disconnect reports' }));
		const d2 = within(await screen.findByRole('dialog'));
		expect(d2.getByText(/stops working now/)).toBeInTheDocument();
		await userEvent.click(d2.getByRole('button', { name: 'Disconnect reports' }));
		expect(await screen.findByText('Reports not connected yet')).toBeInTheDocument();
		expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/domains/1/report-address/rotate', 'DELETE /api/domains/1/report-address']);
	});

	it('a read-only member sees the state; issue, rotate and disconnect are disabled and say why', async () => {
		const { unmount, calls } = show({ 'GET /api/domains/1/report-address': view() }, 'member');
		const connect = await screen.findByRole('button', { name: 'Connect reports' });
		await waitFor(() => expect(connect).toBeDisabled());
		expect(screen.getAllByText(READ_ONLY_REASON).length).toBeGreaterThan(0);
		unmount();
		show({ 'GET /api/domains/1/report-address': issued({ kind: 'published', name: 'n', record: 'x' }, { state: 'waiting' }) }, 'member');
		expect(await screen.findByText('Published, waiting for the first report')).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole('button', { name: 'New address' })).toBeDisabled());
		expect(screen.getByRole('button', { name: 'Disconnect reports' })).toBeDisabled();
		expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
	});

	it('a refused domain says why instead of offering the action; hosted-records domains point there', async () => {
		const { unmount } = show({ 'GET /api/domains/1/report-address': view({ can_issue: false, refusal: 'example.com was added before ownership checks.' }) });
		expect(await screen.findByText('example.com was added before ownership checks.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Connect reports' })).not.toBeInTheDocument();
		unmount();
		show({ 'GET /api/domains/1/report-address': view({ managed_by: 'hosted_records', can_issue: false }) });
		expect(await screen.findByText('Reports for example.com come through its hosted records.')).toBeInTheDocument();
	});

	it('an issue that fails says so and keeps the button', async () => {
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
		expect(await screen.findByText('Address issued, record not published yet')).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'DMARC reports' })).not.toBeInTheDocument();
	});
});
