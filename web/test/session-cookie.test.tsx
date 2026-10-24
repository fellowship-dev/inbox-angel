import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { purgeLegacyToken } from '../src/lib/api';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { InvitePage } from '../src/pages/auth/InvitePage';
import { NoWorkspacePage } from '../src/pages/auth/NoWorkspacePage';
import { fail, me, renderApp } from './render';

beforeEach(() => localStorage.clear());

describe('cookie-only session', () => {
	it('deletes a leftover token from localStorage on startup', () => {
		localStorage.setItem('ia_api_key', 'old-secret');
		localStorage.setItem('ia_theme', 'dark');
		purgeLegacyToken();
		expect(localStorage.getItem('ia_api_key')).toBeNull();
		expect(localStorage.getItem('ia_theme')).toBe('dark');
	});

	it('never sends an X-Api-Key header and relies on same-origin credentials', async () => {
		const { calls, fn } = renderApp(<div>page</div>, { role: 'owner' });
		await screen.findByText('page');
		expect(calls.length).toBeGreaterThan(0);
		for (const c of calls) expect(c.headers['x-api-key']).toBeUndefined();
		for (const [, init] of fn.mock.calls) expect((init as RequestInit).credentials).toBe('same-origin');
	});
});

describe('email verification', () => {
	async function fillSignup() {
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Create an account' }));
		await user.type(screen.getByLabelText('Email'), 'new@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		return user;
	}

	it('shows "Check your email" after sign-up and can resend', async () => {
		const { calls } = renderApp(<AuthPage />, {
			role: null,
			status: { mode: 'saas', signup_open: true },
			routes: { 'POST /api/auth/signup': { __status: 201, body: { verification_required: true } }, 'POST /api/auth/resend-verification': { ok: true } },
		});
		const user = await fillSignup();
		expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
		expect(screen.getByLabelText('Verification email address')).toHaveTextContent('new@example.com');
		await user.click(screen.getByRole('button', { name: 'Resend verification email' }));
		expect(await screen.findByText(/Verification email sent/)).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/auth/resend-verification')?.body).toEqual({ email: 'new@example.com' });
	});

	it('login of an unverified user shows the same screen', async () => {
		renderApp(<AuthPage />, {
			role: null,
			status: { mode: 'saas' },
			routes: { 'POST /api/auth/login': { __status: 403, body: { error: 'verify your email', code: 'email_not_verified' } } },
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'a@example.com');
		await user.type(screen.getByLabelText('Password'), 'correct-horse');
		await user.click(screen.getByRole('button', { name: 'Sign in' }));
		expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
	});

	it('a new invitee is told to verify instead of being signed in', async () => {
		renderApp(
			<Routes>
				<Route path="/invite/:token" element={<InvitePage />} />
			</Routes>,
			{
				role: null,
				route: '/invite/t1',
				routes: {
					'GET /api/invites/t1': { email: 'new@example.com', invited_by: 'boss@example.com', role: 'member', workspace_name: 'Acme', user_exists: false },
					'POST /api/invites/t1': { __status: 201, body: { verification_required: true } },
				},
			},
		);
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Your name'), 'New');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Accept invite' }));
		expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
	});

	it('an unverified cookie session (403 on /api/me) lands on sign-in, not an error', async () => {
		renderApp(<AuthPage />, { role: null, routes: { 'GET /api/me': fail(403, 'verify your email address first') } });
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByText('Waiting for the server')).not.toBeInTheDocument());
	});
});

describe('signed in with no workspace (signed up through an invite)', () => {
	it('lists the waiting invitations and accepts one', async () => {
		const pending = { token: 'inv-tok', role: 'member', invited_by: 'owner@example.com', workspace_id: 'ws_a', workspace_name: 'Acme' };
		const { calls } = renderApp(<NoWorkspacePage />, {
			routes: {
				'GET /api/me': { user: { id: 'u1', email: 'friend@example.com', name: 'F' }, role: null, workspace_id: null, kind: 'session', pending_invites: [pending] },
				'POST /api/invites/inv-tok': { ok: true },
			},
		});
		expect(await screen.findByText('Acme')).toBeInTheDocument();
		await userEvent.setup().click(screen.getByRole('button', { name: 'Accept' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/invites/inv-tok')).toBe(true));
	});
});

describe('a login whose invitations are gone', () => {
	it('can create a workspace of its own', async () => {
		const { calls } = renderApp(<NoWorkspacePage />, {
			routes: {
				'GET /api/me': { user: { id: 'u1', email: 'friend@example.com', name: 'F' }, role: null, workspace_id: null, kind: 'session', pending_invites: [] },
				'POST /api/workspaces': { id: 'ws_new', name: 'Friend Co', role: 'owner', member_count: 1 },
			},
		});
		expect(await screen.findByText(/create a workspace of your own below/i)).toBeInTheDocument();
		const user = userEvent.setup();
		await user.type(screen.getByLabelText(/start a workspace of your own/i), 'Friend Co');
		await user.click(screen.getByRole('button', { name: 'Create workspace' }));
		await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/workspaces')?.body).toEqual({ name: 'Friend Co' }));
	});
});
