import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ClaimCard } from '../src/components/domain/ClaimCard';
import { ClaimPreview } from '../src/components/domain/ClaimPreview';
import type { ClaimPreviewData } from '../src/lib/claim-preview';
import { fail, renderApp } from './render';

const claim = { id: 4, domain: 'acme.io', status: 'pending' as const, txt_name: '_readysetmail.acme.io', txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null };

const view = (over: Partial<ClaimPreviewData> = {}): ClaimPreviewData => ({
	domain: 'acme.io',
	checked_at: new Date().toISOString(),
	source: 'public_dns',
	cached: false,
	nxdomain: false,
	spf: { status: 'found', record: 'v=spf1 include:_spf.google.com ~all', lookup_count: 3, over_limit: false },
	dmarc: { status: 'found', policy: 'none', issue: null, inherited_from: null, record: 'v=DMARC1; p=none' },
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

	it('found records: the overview own level and findings, the records in mono, DKIM as a row', async () => {
		show(view());
		await loaded();
		expect(screen.getByRole('group', { name: /Level 1/ })).toHaveTextContent('Authenticated');
		const findings = screen.getByRole('list', { name: 'Findings' });
		expect(findings).toHaveTextContent('SPF record published');
		expect(findings).toHaveTextContent('DMARC is monitoring only (p=none)');
		expect(screen.getByText('v=spf1 include:_spf.google.com ~all')).toHaveClass('font-mono');
		expect(screen.getByText('v=DMARC1; p=none')).toHaveClass('font-mono');
		expect(within(row('DKIM')).getByText('Key found')).toBeInTheDocument();
		expect(within(row('DKIM')).getByText('google._domainkey.acme.io')).toHaveClass('font-mono');
		// SPF and DMARC are findings of the card: no second row for them
		expect(screen.queryByText('Monitoring only (p=none)')).toBeNull();
	});

	it('a wildcard under _domainkey is neutral and says public DNS cannot tell, never "Key found"', async () => {
		show(view({ dkim: { status: 'wildcard', selectors: [], scanned: 36, failed: 0 } }));
		await loaded();
		const dkim = row('DKIM');
		expect(dkim).toHaveAttribute('data-status', 'neutral');
		expect(within(dkim).getByText("Can't tell from public DNS")).toBeInTheDocument();
		expect(within(dkim).getByText("Every name under acme.io answers with the same TXT record, so public DNS can't show which DKIM keys exist.")).toBeInTheDocument();
		expect(screen.queryByText('Key found')).toBeNull();
		expect(screen.queryByText('Not found in common places')).toBeNull();
	});

	it('an inherited policy says where it came from, in the overview words', async () => {
		show(view({ dmarc: { status: 'found', policy: 'reject', issue: null, inherited_from: 'acme.io', record: 'v=DMARC1; p=none; sp=reject' } }));
		await loaded();
		expect(screen.getByRole('group', { name: /Level 2/ })).toHaveTextContent('Protected');
		expect(screen.getByRole('list', { name: 'Findings' })).toHaveTextContent('DMARC enforced (p=reject), inherited from acme.io');
	});

	it('missing records are findings: Level 0 and the overview sentences', async () => {
		show(view({ spf: { status: 'missing', record: null, lookup_count: null, over_limit: false }, dmarc: { status: 'missing', policy: null, issue: null, inherited_from: null, record: null }, dkim: { status: 'not_found', selectors: [], scanned: 36, failed: 0 } }));
		await loaded();
		expect(screen.getByRole('group', { name: /Level 0/ })).toBeInTheDocument();
		const findings = screen.getByRole('list', { name: 'Findings' });
		expect(findings).toHaveTextContent('No SPF record found. Receivers cannot tell which servers may send for you.');
		expect(findings).toHaveTextContent('No DMARC record found.');
		const dkim = row('DKIM');
		expect(within(dkim).getByText('Not found in common places')).toBeInTheDocument();
		expect(dkim).toHaveAttribute('data-status', 'neutral');
		expect(within(dkim).getByText("We checked 36 common selectors. Public DNS can't list every DKIM key, so a key may still exist under another name.")).toBeInTheDocument();
	});

	it('several DMARC records and an invalid record are the overview warnings, with no level claimed for a policy', async () => {
		const { unmount } = show(view({ dmarc: { status: 'found', policy: null, issue: 'multiple', inherited_from: null, record: 'v=DMARC1; p=none | v=DMARC1; p=reject' } }));
		await loaded();
		expect(screen.getByRole('list', { name: 'Findings' })).toHaveTextContent('Multiple DMARC records: receivers ignore them');
		expect(screen.getByRole('group', { name: /Level 0/ })).toBeInTheDocument();
		unmount();
		show(view({ dmarc: { status: 'found', policy: null, issue: 'invalid', inherited_from: null, record: 'v=DMARC1; p=banana' } }));
		await loaded();
		expect(screen.getByRole('list', { name: 'Findings' })).toHaveTextContent('DMARC record is invalid');
	});

	it('over 10 lookups is a broken SPF record: a failed finding and Level 0, said once (no second row)', async () => {
		show(view({ spf: { status: 'found', record: 'v=spf1 include:a ~all', lookup_count: 12, over_limit: true }, dmarc: { status: 'found', policy: 'reject', issue: null, inherited_from: null, record: 'v=DMARC1; p=reject', pct: 100 } }));
		await loaded();
		expect(screen.getByRole('group', { name: /Level 0/ })).toBeInTheDocument();
		expect(screen.getByRole('list', { name: 'Findings' })).toHaveTextContent('SPF over the lookup limit: 12 of 10 DNS lookups');
		expect(screen.queryByText('Over 10 lookups')).toBeNull();
	});

	it('a domain that does not exist: no level, no findings, one "Does not resolve" row', async () => {
		show(view({ nxdomain: true, spf: { status: 'missing', record: null, lookup_count: null, over_limit: false }, dmarc: { status: 'missing', policy: null, issue: null, inherited_from: null, record: null }, dkim: { status: 'not_found', selectors: [], scanned: 36, failed: 0 } }));
		await loaded();
		expect(screen.queryByRole('group', { name: /Level/ })).toBeNull();
		expect(screen.queryByRole('list', { name: 'Findings' })).toBeNull();
		expect(screen.getAllByRole('listitem')).toHaveLength(1);
		expect(screen.getByText('Does not resolve')).toBeInTheDocument();
		expect(screen.getByText(/DNS says this name does not exist/)).toBeInTheDocument();
		expect(screen.queryByText('Not found')).toBeNull();
	});

	it('a failed DMARC lookup is "Lookup failed", never "Not found", and there is no level to guess', async () => {
		show(view({ dmarc: { status: 'error', policy: null, issue: null, inherited_from: null, record: null }, lookup_failed: ['dmarc'] }));
		await loaded();
		expect(screen.queryByRole('group', { name: /Level/ })).toBeNull();
		const level = row('Protection level');
		expect(level).toHaveAttribute('data-status', 'error');
		expect(within(level).getByText("Not shown, because a DNS lookup failed. We don't guess.")).toBeInTheDocument();
		expect(row('DMARC')).toHaveAttribute('data-status', 'error');
		expect(within(row('DMARC')).getByText('Lookup failed')).toBeInTheDocument();
		expect(screen.queryByText('Not found')).toBeNull();
		expect(screen.queryByText('No DMARC record found.')).toBeNull();
		expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
	});

	it('a failed SPF or DKIM lookup is an error row too, and hides the level', async () => {
		show(view({ spf: { status: 'error', record: null, lookup_count: null, over_limit: false }, dkim: { status: 'error', selectors: [], scanned: 36, failed: 5 } }));
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
		await screen.findByText('_readysetmail.acme.io');
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
