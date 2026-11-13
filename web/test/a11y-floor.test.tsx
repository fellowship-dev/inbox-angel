import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SenderInventory } from '../src/components/analytics/SenderInventory';
import { TrendChart } from '../src/components/analytics/TrendChart';
import { DomainLevelCard } from '../src/components/domain/DomainLevelCard';
import type { Sender, TrendDay } from '../src/lib/analytics';
import { renderApp } from './render';

afterEach(() => vi.restoreAllMocks());

const trend = (n: number): TrendDay[] =>
	Array.from({ length: n }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, total: 100, passed: 90, failed: 10 }));

describe('TrendChart tick labels', () => {
	it('are 12px at the rendered size: the SVG is drawn at its measured width, never scaled', async () => {
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
			return { width: this.tagName === 'FIGURE' ? 343 : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
		});
		renderApp(<TrendChart trend={trend(30)} days={30} />);
		const svg = await screen.findByRole('img', { name: /Stacked columns/ });
		await waitFor(() => expect(svg).toHaveAttribute('width', '343'));
		expect(svg).toHaveAttribute('viewBox', '0 0 343 200');
		const labels = svg.querySelectorAll('text');
		expect(labels.length).toBeGreaterThan(0);
		for (const t of labels) {
			expect(t.getAttribute('font-size')).toBe('12');
			expect(t.getAttribute('class') ?? '').not.toMatch(/text-\[/);
		}
		// 3 value ticks, and only as many day labels as fit at 12px on a phone.
		expect(labels.length - 3).toBeLessThanOrEqual(6);
	});
});

const sender = (o: Partial<Sender> = {}): Sender => ({
	source_ip: '198.2.180.1', reverse_dns: 'mail1.mcsv.net', base_domain: 'mcsv.net', org: 'Example Org', country_code: 'US',
	provider: { id: 'mailchimp', name: 'Mailchimp', evidence: 'authenticated as mcsv.net' }, domains: ['example.com'], messages: 240, share_pct: 12, spf_aligned_pct: 0, dkim_aligned_pct: 0, dmarc_pass_pct: 0,
	spf_domain: 'mcsv.net', dkim_domain: 'mcsv.net', first_seen: 1_760_000_000, last_seen: 1_760_900_000, is_new: false, ...o,
});

describe('SenderInventory scroll cue', () => {
	it('marks the edge that hides columns with a hairline and keeps the label visible while it overflows', async () => {
		renderApp(<SenderInventory senders={[sender()]} />);
		const region = await screen.findByRole('region', { name: 'Sender inventory' });
		expect(region.className).not.toMatch(/gradient/);
		expect(region).not.toHaveClass('border-r-control');
		const cue = screen.getByText('Scroll sideways to see every column.');
		expect(cue).toHaveClass('sm:hidden');

		Object.defineProperty(region, 'clientWidth', { configurable: true, value: 343 });
		Object.defineProperty(region, 'scrollWidth', { configurable: true, value: 720 });
		fireEvent.scroll(region);
		await waitFor(() => expect(region).toHaveClass('border-r-control'));
		expect(region).not.toHaveClass('border-l-control');
		expect(cue).not.toHaveClass('sm:hidden');

		region.scrollLeft = 377;
		fireEvent.scroll(region);
		await waitFor(() => expect(region).toHaveClass('border-l-control'));
		expect(region).not.toHaveClass('border-r-control');
	});
});

const summary = { domain_id: 1, domain: 'example.com', dmarc_policy: 'none', spf_record: 'v=spf1 -all', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null };
const cardRoutes = {
	'GET /api/domains/1/check-summary': summary,
	'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [{ day: '2026-10-20', total: 100, passed: 97, failed: 3 }] },
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' },
};
const domain = { id: 1, domain: 'example.com', dmarc_policy: 'none', rua_address: 'r@x.io', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 } as const;

describe('DomainLevelCard setup nudge', () => {
	it('invites writers to continue setup', async () => {
		renderApp(<DomainLevelCard domain={domain as never} />, { routes: cardRoutes });
		expect(await screen.findByRole('link', { name: /Continue setup \(2\/5\)/ })).toBeInTheDocument();
	});
	it('does not invite read-only members, who cannot run the wizard', async () => {
		renderApp(<DomainLevelCard domain={domain as never} />, { role: 'member', routes: cardRoutes });
		const card = await screen.findByRole('group', { name: /Level \d/ });
		await within(card).findByText(/97% pass rate over 7 days/);
		expect(within(card).queryByRole('link', { name: /Continue setup/ })).not.toBeInTheDocument();
		expect(within(card).getByRole('link', { name: /View/ })).toBeInTheDocument();
	});
});
