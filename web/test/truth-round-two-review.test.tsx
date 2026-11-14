import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRecommendedRecord, enforcementLevel, invalidDmarcSp, parseDmarcPct, parseDmarcPolicy, parseDmarcSp, weakerSubdomainPolicy } from '../src/lib/dmarc-record';
import { getGuidance } from '../src/lib/dmarc';
import { explain, failingMailFate } from '../src/lib/reports';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { DmarcWizardPage } from '../src/pages/wizards/DmarcWizardPage';
import { fail, renderApp } from './render';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('review item 6: one tag parser (RFC 7489: whitespace around = and ;, tag names in any case)', () => {
	it.each([
		['p = reject', 'reject'],
		['P=Reject', 'reject'],
		['p= quarantine ', 'quarantine'],
		['p =none', 'none'],
	])('parseDmarcPolicy reads %s', (tag, want) => {
		expect(parseDmarcPolicy(`v=DMARC1 ; ${tag}; rua=mailto:r@x.test`)).toBe(want);
	});
	it('parseDmarcSp and parseDmarcPct use the same parser', () => {
		expect(parseDmarcSp('v=DMARC1; p=reject; sp = none')).toBe('none');
		expect(parseDmarcSp('v=DMARC1; p=reject; SP=Quarantine')).toBe('quarantine');
		expect(parseDmarcPct('v=DMARC1; p=reject; PCT = 25')).toBe(25);
	});
	it('a p= with spaces is rewritten in place, never duplicated by a second, weaker p=', () => {
		expect(buildRecommendedRecord('v=DMARC1; p = reject; sp=none', 'reject', null)).toBe('v=DMARC1; p=reject; sp=none');
		expect(buildRecommendedRecord('v=DMARC1; P=Reject', 'reject', null)).toBe('v=DMARC1; p=reject');
		const r = buildRecommendedRecord('v=DMARC1; p = quarantine; sp = none', 'reject', 'r@x.test');
		expect(r).toBe('v=DMARC1; p=reject; sp = none; rua=mailto:r@x.test');
		expect(r.match(/(^|;)\s*p\s*=/gi)).toHaveLength(1);
	});
	it('sp= is not mistaken for p=, and a missing p= is appended once', () => {
		expect(buildRecommendedRecord('v=DMARC1; sp=none;', 'quarantine', null)).toBe('v=DMARC1; sp=none; p=quarantine');
	});
});

describe('review item 8: our report address is found in any letter case', () => {
	it('is not appended again when the record has it in another case', () => {
		expect(buildRecommendedRecord('v=DMARC1; p=none; rua=mailto:RUA@Reports.Example.com', 'none', 'rua@reports.example.com')).toBe('v=DMARC1; p=none; rua=mailto:RUA@Reports.Example.com');
	});
	it('is appended when it is genuinely absent, keeping the other address', () => {
		expect(buildRecommendedRecord('v=DMARC1; p=none; rua=mailto:a@else.test!10m', 'none', 'rua@reports.example.com')).toBe('v=DMARC1; p=none; rua=mailto:a@else.test!10m,mailto:rua@reports.example.com');
	});
});

describe('review item 7: an sp= that is not a policy is absent, and said to be invalid', () => {
	it('parseDmarcSp ignores sp=bogus; invalidDmarcSp reports it', () => {
		expect(parseDmarcSp('v=DMARC1; p=reject; sp=bogus')).toBeNull();
		expect(invalidDmarcSp('v=DMARC1; p=reject; sp=bogus')).toBe('bogus');
		expect(invalidDmarcSp('v=DMARC1; p=reject; sp=none')).toBeNull();
		expect(invalidDmarcSp('v=DMARC1; p=reject')).toBeNull();
		expect(weakerSubdomainPolicy('v=DMARC1; p=reject; sp=bogus')).toBeNull();
		expect(weakerSubdomainPolicy('v=DMARC1; p=reject; sp=none')).toBe('none');
		expect(weakerSubdomainPolicy('v=DMARC1; p=quarantine; sp=reject')).toBeNull();
	});
	const src = { source_ip: '1.1.1.1', header_from: 'news.example.com', spf_domain: null, dkim_domain: null, spf_pass: 0, dkim_pass: 0, org: null, base_domain: null } as Parameters<typeof explain>[0];
	it('the failing-mail explanation says the value is not valid and that the subdomain inherits p=', () => {
		const t = explain(src, 'reject', { domain: 'example.com', sp: null, invalidSp: 'bogus', pct: 100 });
		expect(t).toContain('The record\'s sp=bogus is not a valid policy and is ignored, so it inherits p=reject');
		expect(t).not.toContain('sp=bogus applies');
	});
	it("sp= on a monitored subdomain's own record is not claimed to apply to its children", () => {
		const t = failingMailFate('reject', { domain: 'mail.example.com', sp: 'none', pct: 100, monitoredSubdomain: true }, 'a.mail.example.com');
		expect(t).toContain('a.mail.example.com is a subdomain of mail.example.com, which has its own DMARC record.');
		expect(t).toContain('p= and sp= on mail.example.com do not decide this mail');
		expect(t).not.toContain('sp=none applies');
		expect(t).not.toContain('asks receivers');
	});
	it('on the organizational domain sp= still applies to its subdomains', () => {
		expect(failingMailFate('reject', { domain: 'example.com', sp: 'none', pct: 100, monitoredSubdomain: false }, 'a.example.com')).toContain('sp=none applies to it instead of p=reject');
	});
});

describe('review item 4: domain-page guidance agrees with the wizard (pct and sp)', () => {
	const d = { dmarc_policy: 'reject' as const, domain: 'gov.uk', rua_address: 'r@x.test' };
	it('p=reject, all mail, no sp: still "Fully protected"', () => {
		expect(getGuidance(d, 99, true, 'v=DMARC1; p=reject').title).toBe('Fully protected');
		expect(getGuidance(d, 99, true).title).toBe('Fully protected');
	});
	it('p=reject; pct=25 is partial, not "rejected by receiving servers"', () => {
		const g = getGuidance(d, 99, true, 'v=DMARC1; p=reject; pct=25');
		expect(g.title).toBe('Partially enforced: 25%');
		expect(g.body).toContain('applies to only 25% of mail that fails');
		expect(g.body).not.toContain('is rejected by receiving servers');
		expect(g.tone).toBe('warning');
	});
	it('p=reject; sp=none: enforced on the domain, not on subdomains', () => {
		const g = getGuidance(d, 99, true, 'v=DMARC1; p=reject; sp=none');
		expect(g.title).toBe('Enforced on this domain; subdomains are not');
		expect(g.body).toContain('follow sp=none');
		expect(g.body).toContain('Set sp=reject');
	});
	it('sp=bogus does not count as a weaker sp=', () => {
		expect(getGuidance(d, 99, true, 'v=DMARC1; p=reject; sp=bogus').title).toBe('Fully protected');
	});
	it('the level comes from the same enforcementLevel the wizard uses', () => {
		expect(enforcementLevel('v=DMARC1; p=reject; pct=25').level).toBe('partial');
	});
});

const wizDomain = { id: 3, domain: 'gov.uk', dmarc_policy: 'reject', rua_address: 'r@reports.example.com', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 1 };
const wizard = (record: string) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id/dmarc-wizard" element={<DmarcWizardPage />} />
		</Routes>,
		{ route: '/domains/3/dmarc-wizard', routes: { 'GET /api/domains': { domains: [wizDomain] }, 'GET /api/domains/3/dns-check': { found: true, has_rua: true, current_record: record, cf_managed: false } } },
	);

describe('review item 3: the wizard does not say "fully enforced" or "nothing more to do" around a weaker sp=', () => {
	it('p=reject; sp=none: title, warning and closing note all say subdomains are not enforced', async () => {
		wizard('v=DMARC1; p=reject; sp=none; rua=mailto:r@reports.example.com');
		expect(await screen.findByRole('heading', { name: 'Enforced on this domain; subdomains are not' })).toBeInTheDocument();
		expect(screen.queryByText('Fully enforced')).toBeNull();
		expect(screen.getByText(/Subdomains follow/)).toBeInTheDocument();
		expect(screen.getByText(/One thing left: set sp=reject at your DNS provider so subdomains are rejected too/)).toBeInTheDocument();
		expect(screen.queryByText(/Nothing more to do here/)).toBeNull();
	});
	it('p=reject; pct=25; sp=none: the partial card also shows the sp warning', async () => {
		wizard('v=DMARC1; p=reject; pct=25; sp=none');
		expect(await screen.findByRole('heading', { name: 'Partially enforced: 25%' })).toBeInTheDocument();
		expect(screen.getByText(/Subdomains follow/)).toBeInTheDocument();
	});
	it('the progress bar does not mark Reject complete below pct=100, and does at 100', async () => {
		const a = wizard('v=DMARC1; p=reject; pct=25');
		await screen.findByRole('heading', { name: 'Partially enforced: 25%' });
		expect(screen.getByText('Reject').closest('li')).not.toHaveTextContent('(complete)');
		a.unmount();
		wizard('v=DMARC1; p=reject');
		await screen.findByRole('heading', { name: 'Fully enforced' });
		expect(screen.getByText('Reject').closest('li')).toHaveTextContent('(complete)');
	});
	it('sp=bogus is not echoed as a policy: it is said to be invalid, and the card stays "Fully enforced"', async () => {
		wizard('v=DMARC1; p=reject; sp=bogus');
		expect(await screen.findByRole('heading', { name: 'Fully enforced' })).toBeInTheDocument();
		expect(screen.getByText(/sp=bogus, which is not a valid policy, so it is ignored and subdomains inherit p=reject/)).toBeInTheDocument();
		expect(screen.queryByText(/Subdomains follow/)).toBeNull();
	});
});

describe('review item 7: the domain page says an invalid sp= is not valid', () => {
	it('names the value as invalid and the policy subdomains inherit', async () => {
		const parent = { ...wizDomain, id: 1, domain: 'example.com' };
		const child = { ...wizDomain, id: 2, domain: 'a.example.com', parent_id: 1 };
		renderApp(
			<Routes>
				<Route path="/domains/:id" element={<DomainDetailPage />} />
			</Routes>,
			{
				route: '/domains/1',
				routes: {
					'GET /api/domains': { domains: [parent, child] },
					'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [] },
					'GET /api/domains/1/sources': { sources: [] },
					'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
					'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: 'v=DMARC1; p=reject; sp=bogus', cf_managed: false },
				},
			},
		);
		expect(await screen.findByText('sp= is not a valid policy')).toBeInTheDocument();
		expect(screen.getByText(/which is not none, quarantine or reject, so it is ignored: subdomains without their own record inherit p=reject/)).toBeInTheDocument();
		expect(screen.queryByText(/not enforced/)).toBeNull();
	});
});

describe('review item 1: the add-domain page builds the record from the live one', () => {
	const mine = { id: 7, domain: 'google.com', dmarc_policy: 'none', rua_address: 'r@reports.test', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 0 };
	const add = async (d: typeof mine, dns: unknown) => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
		const r = renderApp(<AddDomainPage />, { routes: { 'GET /api/zones': fail(400), 'POST /api/domains': { domain: d, rua_hint: '' }, 'GET /api/domains/7/dns-check': dns, 'GET /api/domains/7/onboarding-status': { domain_id: 7, dmarc: { found: false, has_our_rua: false, current_record: null } } } });
		await user.type(await screen.findByLabelText('Your domain'), d.domain);
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		return r;
	};
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});
	const dnsCalls = (calls: Array<{ path: string }>) => calls.filter((c) => c.path === '/api/domains/7/dns-check').length;

	it('live p=reject and no reports address: nothing is offered, no weaker policy, and it does not poll', async () => {
		const { calls } = await add({ ...mine, rua_address: '' }, { found: true, has_rua: false, current_record: 'v=DMARC1; p=reject; pct=100', cf_managed: false });
		expect(await screen.findByText(/TXT record found\. No reports address is configured/)).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Add this DNS record' })).toBeNull();
		expect(screen.queryByText('DMARC record')).toBeNull();
		expect(document.body.textContent).not.toMatch(/(^|[^s])p=none/);
		expect(screen.getByText('Report address not configured yet')).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(31_000);
		});
		expect(dnsCalls(calls)).toBe(1);
	});

	it('live p=reject with a reports address: the offered record keeps p=reject and adds our address', async () => {
		const { calls } = await add(mine, { found: true, has_rua: false, current_record: 'v=DMARC1; p=reject; sp=none', cf_managed: false });
		expect(await screen.findByText('v=DMARC1; p=reject; sp=none; rua=mailto:r@reports.test')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Update your DMARC record' })).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/(^|[^s])p=none/);
		expect(screen.getByText(/Your policy stays/)).toBeInTheDocument();
		expect(screen.queryByText(/just watching/)).toBeNull();
		// Control: with an address to wait for, it does keep polling.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(16_000);
		});
		expect(dnsCalls(calls)).toBeGreaterThanOrEqual(2);
	});

	it('no record at all with a reports address: p=none plus our rua, as before', async () => {
		await add(mine, { found: false, has_rua: false, current_record: null, cf_managed: false });
		expect(await screen.findByText('v=DMARC1; p=none; rua=mailto:r@reports.test')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Add this DNS record' })).toBeInTheDocument();
		expect(screen.getByText(/just watching/)).toBeInTheDocument();
	});

	it('a failed lookup offers no record: it could be hiding a stronger policy', async () => {
		await add(mine, { found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' });
		expect(await screen.findByText(/so no record is offered until the lookup works/)).toBeInTheDocument();
		await waitFor(() => expect(screen.getByText(/Could not check DNS just now/)).toBeInTheDocument());
		expect(screen.queryByText('DMARC record')).toBeNull();
		expect(document.body.textContent).not.toContain('v=DMARC1');
	});
});
