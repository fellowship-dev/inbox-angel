import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { enforcementLevel, parseDmarcPct, parseDmarcSp, parseDmarcTags } from '../src/lib/dmarc-record';
import { explain, failingMailFate } from '../src/lib/reports';
import { ReportDetailPage } from '../src/pages/reports/ReportDetailPage';
import { DmarcWizardPage } from '../src/pages/wizards/DmarcWizardPage';
import { renderApp } from './render';

describe('item 5: DMARC tag helpers', () => {
	it('parseDmarcTags: lower-cased keys, trimmed values, first occurrence wins', () => {
		expect(parseDmarcTags('v=DMARC1; P=reject ; sp=none; pct=10; p=none')).toEqual({ v: 'DMARC1', p: 'reject', sp: 'none', pct: '10' });
		expect(parseDmarcTags(null)).toEqual({});
	});
	it('parseDmarcSp reads sp= and never p=', () => {
		expect(parseDmarcSp('v=DMARC1; p=reject; sp=quarantine')).toBe('quarantine');
		expect(parseDmarcSp('v=DMARC1; p=reject')).toBeNull();
	});
	it('parseDmarcPct: absent or unreadable is 100, clamps to 100', () => {
		expect(parseDmarcPct('v=DMARC1; p=reject; pct=10')).toBe(10);
		expect(parseDmarcPct('v=DMARC1; p=reject')).toBe(100);
		expect(parseDmarcPct('v=DMARC1; p=reject; pct=abc')).toBe(100);
		expect(parseDmarcPct('v=DMARC1; p=reject; pct=250')).toBe(100);
		expect(parseDmarcPct(null)).toBe(100);
	});
	it('enforcementLevel: reject at pct=10 is partial, only reject at 100 is full', () => {
		expect(enforcementLevel('v=DMARC1; p=reject; pct=10')).toEqual({ level: 'partial', policy: 'reject', pct: 10 });
		expect(enforcementLevel('v=DMARC1; p=reject').level).toBe('full');
		expect(enforcementLevel('v=DMARC1; p=quarantine').level).toBe('quarantine');
		expect(enforcementLevel('v=DMARC1; p=none; pct=10').level).toBe('none');
		expect(enforcementLevel(null).level).toBe('unknown');
	});
});

describe('item 5: failing-mail explanation', () => {
	const src = (over = {}) => ({ source_ip: '1.1.1.1', header_from: 'example.com', spf_domain: null, dkim_domain: null, spf_pass: 0, dkim_pass: 0, org: null, base_domain: null, ...over }) as Parameters<typeof explain>[0];
	const live = (sp: string | null, pct = 100) => ({ domain: 'example.com', sp, pct });

	it('pct below 100 limits what the policy asks for', () => {
		expect(failingMailFate('reject', live(null, 10))).toBe('Your DMARC policy (p=reject; pct=10) asks receivers to reject only 10% of it, and the rest is handled one policy level weaker.');
		expect(failingMailFate('reject', live(null))).toBe('Your DMARC policy (p=reject) asks receivers to reject it.');
	});
	it('a subdomain sender meets sp= when the record has one', () => {
		const t = explain(src({ header_from: 'news.example.com' }), 'reject', live('none'));
		expect(t).toContain('news.example.com is a subdomain, so sp=none applies to it instead of p=reject');
		expect(t).toContain('still deliver it');
		expect(t).not.toContain('asks receivers to reject it');
	});
	it('a subdomain sender inherits p= when there is no sp=, and says so', () => {
		const t = explain(src({ header_from: 'news.example.com' }), 'quarantine', live(null));
		expect(t).toContain('news.example.com is a subdomain and your record has no sp= tag, so it inherits p=quarantine');
		expect(t).toContain('send it to spam');
	});
	it('the base domain is not treated as a subdomain, and sp= does not apply to it', () => {
		expect(explain(src(), 'reject', live('none'))).toContain('Your DMARC policy (p=reject) asks receivers to reject it.');
	});
	it('an unknown policy stays unknown even with a subdomain sender', () => {
		expect(failingMailFate(null, live('none'), 'news.example.com')).toContain('could not be read');
	});
});

describe('item 5: pages', () => {
	const domain = { id: 3, domain: 'example.com', dmarc_policy: 'reject', rua_address: 'r@reports.example.com', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 1 };

	it('the wizard does not call p=reject; pct=10 "Fully enforced"', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/dmarc-wizard" element={<DmarcWizardPage />} />
			</Routes>,
			{ route: '/domains/3/dmarc-wizard', routes: { 'GET /api/domains': { domains: [domain] }, 'GET /api/domains/3/dns-check': { found: true, has_rua: true, current_record: 'v=DMARC1; p=reject; pct=10; rua=mailto:r@reports.example.com', cf_managed: false } } },
		);
		expect(await screen.findByRole('heading', { name: 'Partially enforced: 10%' })).toBeInTheDocument();
		expect(screen.queryByText('Fully enforced')).toBeNull();
		expect(screen.queryByText(/Nothing more to do here/)).toBeNull();
	});

	it('the report page explains a subdomain sender with the live sp=', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/reports/:date" element={<ReportDetailPage />} />
			</Routes>,
			{
				route: '/domains/3/reports/2026-10-01',
				routes: {
					'GET /api/domains': { domains: [domain] },
					'GET /api/domains/3/dns-check': { found: true, has_rua: true, current_record: 'v=DMARC1; p=reject; sp=quarantine', cf_managed: false },
					'GET /api/domains/3/reports': {
						date: '2026-10-01', domain: 'example.com', summary: { total: 5, passed: 0, failed: 5 },
						sources: [{ source_ip: '9.9.9.9', header_from: 'news.example.com', spf_domain: null, dkim_domain: null, count: 5, spf_pass: 0, dkim_pass: 0, disposition: 'none', reporters: 'google.com', base_domain: null, org: null }],
					},
				},
			},
		);
		expect(await screen.findByText(/news\.example\.com is a subdomain, so sp=quarantine applies to it instead of p=reject/)).toBeInTheDocument();
	});
});
