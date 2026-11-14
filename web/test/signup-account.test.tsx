// The remembered sign-up domain belongs to one account: sign-out and a different account's sign-in clear it.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { createQueryClient } from '../src/lib/query';
import { bindSignupDomainToEmail, readSignupDomain, reconcileSignupDomain, rememberSignupDomain, SIGNUP_DOMAIN_KEY } from '../src/lib/signup-intent';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { me, mockApi, renderApp, STATUS } from './render';

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

const stored = () => JSON.parse(localStorage.getItem(SIGNUP_DOMAIN_KEY) ?? 'null');
const put = (entry: Record<string, unknown>) => localStorage.setItem(SIGNUP_DOMAIN_KEY, JSON.stringify({ domain: 'acme.io', expires: Date.now() + 1e6, ...entry }));
const at = (route: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;

describe('reconcileSignupDomain / bindSignupDomainToEmail', () => {
	it('binds an entry with no email to the account that signed in', () => {
		rememberSignupDomain('acme.io');
		reconcileSignupDomain('Owner@Example.com');
		expect(stored().email).toBe('owner@example.com');
		expect(readSignupDomain()).toBe('acme.io');
	});

	it('keeps it for the same account, whatever the case', () => {
		put({ email: 'owner@example.com' });
		reconcileSignupDomain('OWNER@example.com');
		expect(readSignupDomain()).toBe('acme.io');
	});

	it('clears it for a different account', () => {
		put({ email: 'someone@else.com' });
		reconcileSignupDomain('owner@example.com');
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});

	it('the sign-up form records the submitted email on the entry', () => {
		rememberSignupDomain('acme.io');
		bindSignupDomainToEmail(' New@Example.com ');
		expect(stored()).toMatchObject({ domain: 'acme.io', email: 'new@example.com' });
		bindSignupDomainToEmail('x@y.com'); // nothing stored: no-op
		localStorage.clear();
		bindSignupDomainToEmail('x@y.com');
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});
});

describe('the session', () => {
	it('another account signing in clears it', async () => {
		put({ email: 'someone@else.com' });
		renderApp(<p>page</p>, { role: 'owner' });
		await screen.findByText('page');
		await waitFor(() => expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull());
	});

	it('the same account keeps it', async () => {
		put({ email: me('owner').user!.email });
		renderApp(<p>page</p>, { role: 'owner' });
		await screen.findByText('page');
		expect(readSignupDomain()).toBe('acme.io');
	});

	it('an entry with no email is bound to whoever signs in', async () => {
		put({});
		renderApp(<p>page</p>, { role: 'owner' });
		await screen.findByText('page');
		await waitFor(() => expect(stored().email).toBe('owner@example.com'));
	});

	it('signing out clears it', async () => {
		put({ email: me('owner').user!.email });
		mockApi({ 'GET /api/auth/status': STATUS, 'GET /api/version': { current: '1.2.0', latest: '1.2.0', update_available: false, release_url: '' }, 'GET /api/me': me('owner'), 'GET /api/keys': { keys: [] }, 'GET /api/access': { products: [], principals: [], credentials: [], grants: [] }, 'GET /api/resources': { domains: [] }, 'GET /api/mcp/connections': { connections: [] }, 'GET /api/metrics/google/connections': { configured: false, connections: [] }, 'POST /api/auth/logout': { ok: true } });
		render(<App queryClient={createQueryClient()} Router={at('/keys')} />);
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Account menu' }));
		expect(readSignupDomain()).toBe('acme.io');
		await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
		await screen.findByRole('heading', { name: 'Sign in' });
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});
});

describe('the sign-up form', () => {
	it('records the email it was submitted with on the remembered domain', async () => {
		rememberSignupDomain('acme.io');
		renderApp(<AuthPage initialMode="signup" />, { role: null, status: { signup_open: true }, routes: { 'POST /api/auth/signup': { verification_required: true } } });
		await userEvent.type(await screen.findByLabelText('Email'), 'New@Example.com');
		await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
		await screen.findByText(/Check your email/i);
		expect(stored()).toMatchObject({ domain: 'acme.io', email: 'new@example.com' });
	});
});
