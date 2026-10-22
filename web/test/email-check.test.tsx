import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailCheckPage } from '../src/pages/check/EmailCheckPage';
import { fail, renderApp } from './render';

const result = {
	id: 7,
	from_email: 'me@acme.io',
	from_domain: 'acme.io',
	spf_result: 'pass',
	spf_domain: 'acme.io',
	spf_record: 'v=spf1 include:_spf.google.com ~all',
	dkim_result: 'none',
	dkim_domain: null,
	dmarc_result: 'pass',
	dmarc_policy: 'none',
	dmarc_record: 'v=DMARC1; p=none',
	overall_status: 'at_risk',
	session_token: 'tok',
	spf_lookup_count: 4,
	created_at: 1_760_000_000,
};

afterEach(() => vi.useRealTimers());

describe('EmailCheckPage', () => {
	it('goes idle -> waiting -> done and refreshes history', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let polls = 0;
		let history: unknown[] = [];
		renderApp(<EmailCheckPage />, {
			routes: {
				'GET /api/check-results': () => ({ results: history }),
				'POST /api/check-sessions': { token: 'tok', email: 'check-abc@reports.example.com' },
				'GET /api/check-sessions/tok': () => {
					polls++;
					if (polls < 2) return { status: 'pending' };
					history = [result];
					return { status: 'done', result };
				},
			},
		});
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		expect(await screen.findByText('No checks yet')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Start check' }));
		expect(await screen.findByTestId('check-address')).toHaveTextContent('check-abc@reports.example.com');
		expect(screen.getByText(/Waiting for email/)).toBeInTheDocument();
		await act(() => vi.advanceTimersByTimeAsync(3000));
		expect(screen.getByText(/Waiting for email/)).toBeInTheDocument();
		await act(() => vi.advanceTimersByTimeAsync(3000));
		expect(await screen.findByRole('heading', { name: 'acme.io' })).toBeInTheDocument();
		expect(screen.getAllByText('At risk').length).toBeGreaterThan(0);
		expect(screen.getAllByText(/No DKIM signature found/).length).toBeGreaterThan(0);
		expect(screen.getByRole('button', { name: 'Run another check' })).toBeInTheDocument();
		// The new result is the expanded history row.
		expect(await screen.findByRole('button', { expanded: true, name: /acme\.io/ })).toBeInTheDocument();
	});

	it('treats a 429 on create as an error state, not a failed check', async () => {
		const user = userEvent.setup();
		renderApp(<EmailCheckPage />, {
			routes: { 'GET /api/check-results': { results: [] }, 'POST /api/check-sessions': fail(429) },
		});
		await user.click(await screen.findByRole('button', { name: 'Start check' }));
		expect(await screen.findByText('Could not start the check')).toBeInTheDocument();
		expect(screen.getByText(/Too many requests/)).toBeInTheDocument();
		expect(screen.queryByText('Fail')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});

	it('gives up after five minutes and offers Retry / Cancel', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		renderApp(<EmailCheckPage />, {
			routes: {
				'GET /api/check-results': { results: [] },
				'POST /api/check-sessions': { token: 'tok', email: 'check-abc@reports.example.com' },
				'GET /api/check-sessions/tok': { status: 'pending' },
			},
		});
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(await screen.findByRole('button', { name: 'Start check' }));
		await screen.findByTestId('check-address');
		await act(() => vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100));
		expect(await screen.findByText('No email received yet')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByText(/Waiting for email/)).toBeInTheDocument();
		await act(() => vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100));
		await user.click(await screen.findByRole('button', { name: 'Cancel' }));
		expect(screen.getByRole('button', { name: 'Start check' })).toBeInTheDocument();
	});

	it('shows when a hosted check address expires, and says nothing in self-host', async () => {
		const run = async (extra: object) => {
			const { unmount } = renderApp(<EmailCheckPage />, {
				routes: { 'GET /api/check-results': { results: [] }, 'POST /api/check-sessions': { token: 'tok', email: 'check+tok.example.io', ...extra }, 'GET /api/check-sessions/tok': { status: 'pending' } },
			});
			await userEvent.click(await screen.findByRole('button', { name: 'Start check' }));
			await screen.findByTestId('check-address');
			return unmount;
		};
		const unmount = await run({ expires_at: 1_800_000_000 });
		expect(screen.getByText(/takes one email and expires at/)).toBeInTheDocument();
		unmount();
		await run({});
		expect(screen.queryByText(/expires at/)).not.toBeInTheDocument();
	});

	it('shows history with error and retry when it fails to load', async () => {
		renderApp(<EmailCheckPage />, { routes: { 'GET /api/check-results': fail(403) } });
		expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
	});
});
