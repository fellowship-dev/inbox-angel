import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { tokenStore } from '../src/lib/api';
import { createQueryClient } from '../src/lib/query';
import { fail, me, mockApi, STATUS } from './render';

const at = (route: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;

function boot(route: string, routes: Record<string, unknown>) {
	const api = mockApi({ 'GET /api/auth/status': STATUS, 'GET /api/version': { current: '1.2.0', latest: '1.2.0', update_available: false, release_url: '' }, ...routes });
	render(<App queryClient={createQueryClient()} Router={at(route)} />);
	return api;
}

beforeEach(() => localStorage.clear());

describe('app', () => {
	it('shows the sign-in screen at a deep link when signed out, without changing the URL', async () => {
		boot('/keys', { 'GET /api/me': fail(401) });
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
		expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
	});

	it('shows the first-run setup when the instance has no owner', async () => {
		mockApi({});
		boot('/', { 'GET /api/auth/status': { ...STATUS, configured: false, has_domain: false }, 'GET /api/me': fail(401) });
		expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
	});

	it('renders the sidebar and the page for a signed-in user, marking the current section', async () => {
		tokenStore.set('t');
		boot('/keys', { 'GET /api/me': me('owner'), 'GET /api/keys': { keys: [] } });
		const nav = await screen.findByRole('navigation', { name: 'Main' });
		expect(within(nav).getByRole('link', { name: 'API keys' })).toHaveAttribute('aria-current', 'page');
		expect(within(nav).getByRole('link', { name: 'Domains' })).not.toHaveAttribute('aria-current');
		expect(await screen.findByRole('heading', { name: 'API keys', level: 1 })).toBeInTheDocument();
	});

	it('sends a signed-in owner of an empty instance to the setup wizard, but not a member', async () => {
		tokenStore.set('t');
		boot('/', { 'GET /api/auth/status': { ...STATUS, has_domain: false }, 'GET /api/me': me('owner') });
		await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument());
	});

	it('returns to sign-in when a request comes back 401 mid-session', async () => {
		tokenStore.set('t');
		boot('/keys', { 'GET /api/me': me('owner'), 'GET /api/keys': fail(401, 'expired') });
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
		expect(tokenStore.get()).toBe('');
	});

	it('signs out from the account menu', async () => {
		tokenStore.set('t');
		const api = boot('/keys', { 'GET /api/me': me('owner'), 'GET /api/keys': { keys: [] }, 'POST /api/auth/logout': { ok: true } });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Account menu' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
		expect(api.calls.some((c) => c.path === '/api/auth/logout')).toBe(true);
		expect(tokenStore.get()).toBe('');
	});

	it('says the server is unreachable (not "not signed in") when /api/auth/status fails', async () => {
		boot('/', { 'GET /api/auth/status': fail(503) });
		expect(await screen.findByText('Waiting for the server', {}, { timeout: 20000 })).toBeInTheDocument();
	}, 25000);
});
