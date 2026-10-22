import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogPage } from '../src/pages/audit/AuditLogPage';
import { fail, renderApp } from './render';

const entry = (id: number, over: Record<string, unknown> = {}) => ({
	id,
	actor_id: 'u1',
	actor_email: 'owner@example.com',
	actor_type: 'user',
	action: 'dns.record_added',
	resource_type: 'domain',
	resource_id: '1',
	resource_name: `example-${id}.com`,
	before_value: null,
	after_value: '{"p":"reject"}',
	meta: null,
	created_at: 1_760_000_000,
	...over,
});

beforeEach(() => {
	window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

describe('AuditLogPage', () => {
	it('explains a 403 for members instead of failing generically', async () => {
		renderApp(<AuditLogPage />, { role: 'member', routes: { 'GET /api/audit-log': fail(403, 'admin required') } });
		expect(await screen.findByText('Only owners and admins can see the audit log')).toBeInTheDocument();
		expect(screen.queryByText('Could not load the audit log')).not.toBeInTheDocument();
	});

	it('lists entries and expands the after value', async () => {
		const user = userEvent.setup();
		renderApp(<AuditLogPage />, {
			routes: { 'GET /api/audit-log': { entries: [entry(1), entry(2, { actor_type: 'system', actor_email: null, action: 'cron.sweep', after_value: null })], page: 1, limit: 50 } },
		});
		expect(await screen.findByText('example-1.com')).toBeInTheDocument();
		expect(screen.getByText('system')).toBeInTheDocument();
		await user.click(screen.getByText('after'));
		expect(screen.getByText(/"p": "reject"/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
	});

	it('pages with Next when 50 entries come back, and resets to page 1 on filter change', async () => {
		const user = userEvent.setup();
		const full = Array.from({ length: 50 }, (_, i) => entry(i + 1));
		const { calls } = renderApp(<AuditLogPage />, { routes: { 'GET /api/audit-log': { entries: full, page: 1, limit: 50 } } });
		await screen.findByText('example-1.com');
		await user.click(screen.getByRole('button', { name: /Next/ }));
		await screen.findByText('Page 2');
		expect(calls.some((c) => c.path === '/api/audit-log?page=2&limit=50')).toBe(true);
		await user.click(screen.getByRole('button', { name: 'DNS' }));
		await waitFor(() => expect(calls.some((c) => c.path === '/api/audit-log?page=1&limit=50&action=dns.')).toBe(true));
		expect(await screen.findByText('Page 1')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'DNS' })).toHaveAttribute('aria-pressed', 'true');
	});

	it('shows an empty state', async () => {
		renderApp(<AuditLogPage />, { routes: { 'GET /api/audit-log': { entries: [], page: 1, limit: 50 } } });
		expect(await screen.findByText('No audit entries yet')).toBeInTheDocument();
	});
});
