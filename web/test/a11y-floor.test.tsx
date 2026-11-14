import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SenderInventory } from '../src/components/analytics/SenderInventory';
import { TrendChart } from '../src/components/analytics/TrendChart';
import { DomainRow } from '../src/components/domain/DomainRow';
import type { Sender, TrendDay } from '../src/lib/analytics';
import type { DomainVerdict } from '../src/lib/verdict';
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

const verdict: DomainVerdict = {
	status: 'attention',
	level: 0,
	sentence: 'Public DNS shows no SPF record, so receivers cannot tell which servers may send for example.com.',
	evidence: null,
	checked: 'Checked 3 hours ago',
	next: { label: 'Publish an SPF record', who: 'You or your DNS manager', to: '/domains/1/setup/2' },
	reportsNotConnected: false,
	reportsConfirmed: false,
	help: null,
};
const row = (canWrite: boolean, v: DomainVerdict | null = verdict) =>
	renderApp(
		<ul>
			<DomainRow domain={{ id: 1, domain: 'example.com' }} verdict={v} canWrite={canWrite} />
		</ul>,
	);

describe('DomainRow', () => {
	it('sends writers to the wizard step that makes the change', async () => {
		row(true);
		expect(await screen.findByRole('link', { name: 'Publish an SPF record for example.com' })).toHaveAttribute('href', '/domains/1/setup/2');
	});
	it('sends read-only members, who cannot run the wizard, to the domain page instead', async () => {
		row(false);
		expect(await screen.findByRole('link', { name: 'Publish an SPF record for example.com' })).toHaveAttribute('href', '/domains/1');
	});
	it('is named by its domain and carries the state as a word', async () => {
		row(true);
		const li = await screen.findByRole('listitem', { name: 'example.com' });
		expect(within(li).getByText('Needs attention')).toBeInTheDocument();
		expect(within(li).getByRole('heading', { level: 3, name: 'example.com' })).toBeInTheDocument();
	});
	it('while loading, says so instead of guessing a level', async () => {
		row(true, null);
		const li = await screen.findByRole('listitem', { name: 'example.com' });
		expect(li).toHaveAttribute('aria-busy', 'true');
		expect(within(li).getByText('Checking what is known…')).toBeInTheDocument();
		expect(within(li).queryByRole('progressbar')).not.toBeInTheDocument();
	});
});
