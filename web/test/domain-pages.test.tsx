import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import { BulkImportPage } from '../src/pages/domains/BulkImportPage';
import { DomainSettingsPage } from '../src/pages/domains/DomainSettingsPage';
import { fail, renderApp } from './render';

const domain = { id: 1, domain: 'example.com', dmarc_policy: 'none', rua_address: 'r@reports.test', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };

describe('AddDomainPage', () => {
	const added = { domain: { ...domain, id: 7, domain: 'new.example.org' }, rua_hint: 'x' };

	it('links to bulk import and CT discovery so they are reachable', async () => {
		renderApp(<AddDomainPage />, { routes: { 'GET /api/zones': fail(400, 'Cloudflare API token not configured') } });
		expect(await screen.findByRole('link', { name: /Import a list of domains/ })).toHaveAttribute('href', '/bulk-import');
		expect(screen.getByRole('link', { name: /find subdomains from certificate logs/ })).toHaveAttribute('href', '/ct-discover');
	});

	it('normalises the input, then shows the record and a failed live check as "Lookup failed"', async () => {
		const { calls } = renderApp(<AddDomainPage />, {
			routes: {
				'GET /api/zones': fail(400),
				'POST /api/domains': added,
				'GET /api/domains/7/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' },
			},
		});
		await userEvent.type(await screen.findByLabelText('Your domain'), ' HTTPS://New.Example.org/ ');
		const go = screen.getByRole('button', { name: 'Continue' });
		await waitFor(() => expect(go).toBeEnabled());
		await userEvent.click(go);
		expect(await screen.findByText('Lookup failed')).toBeInTheDocument();
		expect(screen.queryByText('Not found')).toBeNull();
		expect(calls.find((c) => c.path === '/api/domains' && c.method === 'POST')?.body).toEqual({ domain: 'new.example.org' });
		expect(screen.getByText('v=DMARC1; p=none; rua=mailto:r@reports.test')).toBeInTheDocument();
		expect(screen.getByText('_dmarc.new.example.org')).toBeInTheDocument();
	});

	it('shows the subdomain inheritance summary', async () => {
		renderApp(<AddDomainPage />, {
			routes: {
				'GET /api/zones': fail(400),
				'POST /api/domains': { ...added, parent_context: { domain: 'example.org', dmarc_policy: 'reject', dmarc_sp: null, has_dmarc: true } },
				'GET /api/domains/7/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
			},
		});
		await userEvent.type(await screen.findByLabelText('Your domain'), 'new.example.org');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect((await screen.findAllByText(/already protected by the parent/)).length).toBeGreaterThan(0);
		expect(screen.getByText('SPF does not inherit')).toBeInTheDocument();
		expect(await screen.findByText('Not found')).toBeInTheDocument();
	});

	it('shows the server error inline (409)', async () => {
		renderApp(<AddDomainPage />, { routes: { 'GET /api/zones': fail(400), 'POST /api/domains': fail(409) } });
		await userEvent.type(await screen.findByLabelText('Your domain'), 'dup.com');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('Already exists.')).toBeInTheDocument();
	});
});

describe('BulkImportPage', () => {
	it('lists per-domain results with words, not just colour', async () => {
		renderApp(<BulkImportPage />, {
			routes: {
				'POST /api/domains/bulk-import': { imported: 1, total: 3, results: [{ domain: 'a.com', status: 'imported', manual_dns: true }, { domain: 'b.com', status: 'duplicate' }, { domain: 'c', status: 'invalid', error: 'bad name' }] },
			},
		});
		await userEvent.type(await screen.findByLabelText('Domains'), 'a.com, b.com, c');
		const btn = screen.getByRole('button', { name: 'Import domains' });
		await waitFor(() => expect(btn).toBeEnabled());
		await userEvent.click(btn);
		expect(await screen.findByText('1 of 3 domains imported')).toBeInTheDocument();
		expect(screen.getByText('DNS provisioning: manual required')).toBeInTheDocument();
		expect(screen.getByText('Already added')).toBeInTheDocument();
		expect(screen.getByText('Invalid')).toBeInTheDocument();
	});

	it('is disabled for members', async () => {
		renderApp(<BulkImportPage />, { role: 'member' });
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Import domains' })).toBeDisabled();
	});
});

describe('DomainSettingsPage', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	const routes = (over = {}) => ({
		'GET /api/domains': { domains: [domain] },
		'GET /api/domains/1/monitor-subs': { subs: [{ id: 5, email: 'sub@x.io', domain: 'example.com', active: 1, created_at: 1700000000 }] },
		...over,
	});
	const page = (opts: Parameters<typeof renderApp>[1]) =>
		renderApp(
			<Routes>
				<Route path="/domains/:id/settings" element={<DomainSettingsPage />} />
			</Routes>,
			{ route: '/domains/1/settings', ...opts },
		);

	it('members see data but every write control is disabled', async () => {
		page({ role: 'member', routes: routes() });
		expect(await screen.findByRole('cell', { name: 'sub@x.io' })).toBeInTheDocument();
		expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
		for (const name of [/Pause all/, /^Pause\s*sub@x\.io/, /Set as default/, /Remove domain/]) {
			await waitFor(() => expect(screen.getByRole('button', { name })).toBeDisabled());
		}
		expect(screen.getByRole('button', { name: /Download CSV/ })).toBeEnabled();
	});

	it('removal takes two steps and only then calls DELETE', async () => {
		const { calls } = page({ routes: routes({ 'DELETE /api/domains/1': { ok: true } }) });
		const remove = await screen.findByRole('button', { name: /Remove domain/ });
		await waitFor(() => expect(remove).toBeEnabled());
		await userEvent.click(remove);
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, remove' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/domains/1')).toBe(true));
	});

	it('exports the CSV with the key in a header, never in the URL', async () => {
		let seen: { url: string; headers: Record<string, string> } | undefined;
		page({ routes: routes() });
		await screen.findByRole('cell', { name: 'sub@x.io' });
		const base = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('/export')) {
				seen = { url: String(input), headers: init?.headers as Record<string, string> };
				return new Response('day,count\n', { status: 200 });
			}
			return base(input, init);
		}));
		URL.createObjectURL = vi.fn(() => 'blob:x');
		URL.revokeObjectURL = vi.fn();
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		await userEvent.click(screen.getByRole('button', { name: /Download CSV/ }));
		await waitFor(() => expect(seen).toBeDefined());
		expect(seen?.url).toBe('/api/domains/1/export');
		expect(seen?.headers?.['X-Api-Key']).toBeUndefined();
	});
});
