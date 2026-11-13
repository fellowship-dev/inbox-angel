import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ClaimCard } from '../src/components/domain/ClaimCard';
import { ClaimPreview, type ClaimPreviewData } from '../src/components/domain/ClaimPreview';
import { fail, renderApp } from './render';

const claim = { id: 4, domain: 'acme.io', status: 'pending' as const, txt_name: '_inboxangel.acme.io', txt_value: 'inboxangel-verify=abc', created_at: 1, last_checked_at: null, last_error: null };

const view = (over: Partial<ClaimPreviewData> = {}): ClaimPreviewData => ({
	domain: 'acme.io',
	checked_at: new Date().toISOString(),
	source: 'public_dns',
	cached: false,
	spf: { status: 'found', record: 'v=spf1 include:_spf.google.com ~all', lookup_count: 3, over_limit: false, issues: [] },
	dmarc: { status: 'found', record: 'v=DMARC1; p=none', policy: 'none', inherited: false, found_at: '_dmarc.acme.io' },
	dkim: { status: 'found', selectors: ['google._domainkey.acme.io'], scanned: 36, failed: 0 },
	mx: { status: 'found' },
	lookup_failed: [],
	...over,
});

const PATH = 'GET /api/domains/claims/4/preview';
const show = (data: ClaimPreviewData | unknown, props: { lazy?: boolean } = {}) => renderApp(<ClaimPreview claimId={4} domain="acme.io" {...props} />, { routes: { [PATH]: data } });
/** The data has arrived (the heading shows while it is still loading). */
const loaded = () => screen.findByText(/Checked from public DNS/);
const row = (title: string) => screen.getByText(title, { selector: 'span.font-semibold' }).closest('li') as HTMLElement;

describe('ClaimPreview', () => {
	it('says what it is: public records, shown before ownership is proven, nothing stored', async () => {
		show(view());
		expect(await screen.findByRole('heading', { name: 'Public DNS for acme.io' })).toBeInTheDocument();
		expect(screen.getByText("Anyone can look these records up. They're shown before you prove ownership so you can see where acme.io stands. Nothing is stored until it's verified.")).toBeInTheDocument();
	});

	it('found records: the level, and SPF, DMARC and DKIM rows with the records in mono', async () => {
		show(view());
		expect(await screen.findByRole('group', { name: /Level 1/ })).toHaveTextContent('Authenticated');
		expect(within(row('SPF')).getByText('SPF record published')).toBeInTheDocument();
		expect(within(row('SPF')).getByText('v=spf1 include:_spf.google.com ~all')).toHaveClass('font-mono');
		expect(within(row('DMARC')).getByText('Monitoring only (p=none)')).toBeInTheDocument();
		expect(within(row('DMARC')).getByText('Failing mail is still delivered.')).toBeInTheDocument();
		expect(within(row('DKIM')).getByText('Key found')).toBeInTheDocument();
		expect(within(row('DKIM')).getByText('google._domainkey.acme.io')).toHaveClass('font-mono');
		// the level's findings are the rows: nothing is shown twice
		expect(screen.queryByRole('list', { name: 'Findings' })).toBeNull();
	});

	it('an enforced policy is Protected and inherited records say where they came from', async () => {
		show(view({ dmarc: { status: 'found', record: 'v=DMARC1; p=reject', policy: 'reject', inherited: true, found_at: '_dmarc.io.example' } }));
		expect(await screen.findByRole('group', { name: /Level 2/ })).toHaveTextContent('Protected');
		expect(within(row('DMARC')).getByText('Enforced (p=reject)')).toBeInTheDocument();
		expect(within(row('DMARC')).getByText('Inherited from _dmarc.io.example.')).toBeInTheDocument();
	});

	it('missing records are findings: Level 0 and "Not found" with a plain sentence', async () => {
		show(view({ spf: { status: 'missing', record: null, lookup_count: null, over_limit: false, issues: [] }, dmarc: { status: 'missing', record: null, policy: null, inherited: false, found_at: null }, dkim: { status: 'not_found', selectors: [], scanned: 36, failed: 0 } }));
		expect(await screen.findByRole('group', { name: /Level 0/ })).toBeInTheDocument();
		expect(within(row('SPF')).getByText("No SPF record. Receivers can't tell which servers may send for acme.io.")).toBeInTheDocument();
		expect(within(row('DMARC')).getByText('No DMARC record.')).toBeInTheDocument();
		const dkim = row('DKIM');
		expect(within(dkim).getByText('Not found in common places')).toBeInTheDocument();
		expect(dkim).toHaveAttribute('data-status', 'neutral');
		expect(within(dkim).getByText("We checked 36 common selectors. Public DNS can't list every DKIM key, so a key may still exist under another name.")).toBeInTheDocument();
	});

	it('over 10 lookups and broken records get their own rows', async () => {
		show(view({
			spf: { status: 'found', record: 'v=spf1 include:a ~all', lookup_count: 12, over_limit: true, issues: [] },
			dmarc: { status: 'multiple', record: null, policy: null, inherited: false, found_at: '_dmarc.acme.io' },
		}));
		await loaded();
		expect(within(row('SPF')).getByText('Over 10 lookups')).toBeInTheDocument();
		expect(within(row('SPF')).getByText('Receivers may reject mail when SPF needs more than 10 DNS lookups. This record needs 12.')).toBeInTheDocument();
		expect(within(row('DMARC')).getByText('More than one DMARC record is published, so receivers ignore them all.')).toBeInTheDocument();
	});

	it('an invalid SPF record explains itself with the first issue', async () => {
		show(view({ spf: { status: 'invalid', record: 'v=spf1 include:gone.example', lookup_count: 1, over_limit: false, issues: ['gone.example has no SPF record'] } }));
		await loaded();
		expect(within(row('SPF')).getByText("The SPF record doesn't parse, so receivers treat it as broken. gone.example has no SPF record")).toBeInTheDocument();
	});

	it('a failed lookup is "Lookup failed", never "Not found", and there is no level to guess', async () => {
		show(view({ dmarc: { status: 'error', record: null, policy: null, inherited: false, found_at: null }, lookup_failed: ['dmarc'] }));
		await loaded();
		expect(screen.queryByRole('group', { name: /Level/ })).toBeNull();
		const level = row('Protection level');
		expect(level).toHaveAttribute('data-status', 'error');
		expect(within(level).getByText("Not shown, because a DNS lookup failed. We don't guess.")).toBeInTheDocument();
		expect(row('DMARC')).toHaveAttribute('data-status', 'error');
		expect(within(row('DMARC')).getByText('Lookup failed')).toBeInTheDocument();
		expect(screen.queryByText('Not found')).toBeNull();
		expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
	});

	it('a DKIM lookup that failed is an error row, and a failed SPF hides the level too', async () => {
		show(view({ spf: { status: 'error', record: null, lookup_count: null, over_limit: false, issues: [] }, dkim: { status: 'error', selectors: [], scanned: 36, failed: 5 } }));
		await loaded();
		expect(row('SPF')).toHaveAttribute('data-status', 'error');
		expect(row('DKIM')).toHaveAttribute('data-status', 'error');
		expect(screen.queryByRole('group', { name: /Level/ })).toBeNull();
		expect(screen.queryByText('Not found')).toBeNull();
		expect(screen.queryByText('Not found in common places')).toBeNull();
	});

	it('says when it was checked, and Check again asks again', async () => {
		const { calls } = show(view());
		expect(await screen.findByText('Checked from public DNS just now.')).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
		await waitFor(() => expect(calls.filter((c) => c.path === '/api/domains/claims/4/preview')).toHaveLength(2));
	});

	it('relative time is in minutes', async () => {
		show(view({ checked_at: new Date(Date.now() - 2 * 60_000 - 5_000).toISOString(), cached: true }));
		expect(await screen.findByText('Checked from public DNS 2 min ago.')).toBeInTheDocument();
	});

	it('a 429 is an information notice, not a record status', async () => {
		show({ __status: 429, body: { error: 'Checked too often. Try again in a minute.', code: 'rate_limited', retry_after: 60 } });
		const notice = await screen.findByRole('status');
		expect(notice).toHaveTextContent('Checked too often. Try again in a minute.');
		expect(screen.queryByText('Not found')).toBeNull();
		expect(screen.queryByText('Lookup failed')).toBeNull();
	});

	it('any other failure is a "Lookup failed" row, never a missing record', async () => {
		show(fail(500));
		await screen.findByRole('heading', { name: 'Public DNS for acme.io' });
		expect(await screen.findByText('Lookup failed')).toBeInTheDocument();
		expect(screen.queryByText('Not found')).toBeNull();
	});

	it('shows a busy skeleton while loading', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const { container } = show(view());
		const mocked = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('/preview')) await gate;
			return mocked(input, init);
		});
		await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull());
		release();
		await loaded();
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
	});

	it('lazy: nothing is requested until the button is pressed', async () => {
		const { calls } = show(view(), { lazy: true });
		const button = await screen.findByRole('button', { name: 'Check public DNS' });
		expect(calls.some((c) => c.path.includes('/preview'))).toBe(false);
		expect(screen.queryByRole('heading', { name: /Public DNS for/ })).toBeNull();
		await userEvent.click(button);
		expect(await screen.findByRole('heading', { name: 'Public DNS for acme.io' })).toBeInTheDocument();
		expect(calls.filter((c) => c.path.includes('/preview'))).toHaveLength(1);
		expect(screen.queryByRole('button', { name: 'Check public DNS' })).toBeNull();
	});
});

describe('ClaimCard and the preview', () => {
	it('without the preview prop: no preview and no request', async () => {
		const { calls } = renderApp(<ClaimCard claim={claim} />);
		await screen.findByText('_inboxangel.acme.io');
		expect(screen.queryByText(/Public DNS for/)).toBeNull();
		expect(screen.queryByRole('button', { name: 'Check public DNS' })).toBeNull();
		expect(calls.some((c) => c.path.includes('/preview'))).toBe(false);
	});

	it('with preview: loads it above the TXT instructions', async () => {
		renderApp(<ClaimCard claim={claim} preview />, { routes: { [PATH]: view() } });
		const heading = await loaded();
		const instructions = screen.getByText(/Prove you own/);
		expect(heading.compareDocumentPosition(instructions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('with preview="lazy": a button, and no request until pressed', async () => {
		const { calls } = renderApp(<ClaimCard claim={claim} preview="lazy" />, { routes: { [PATH]: view() } });
		await userEvent.click(await screen.findByRole('button', { name: 'Check public DNS' }));
		await loaded();
		expect(calls.filter((c) => c.path.includes('/preview'))).toHaveLength(1);
	});

	it('a claim another workspace won shows no preview', async () => {
		const { calls } = renderApp(<ClaimCard claim={{ ...claim, status: 'lost' }} preview />);
		await screen.findByText(/Another workspace verified this domain first/);
		expect(calls.some((c) => c.path.includes('/preview'))).toBe(false);
	});
});
