import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { tokenStore } from '../src/lib/api';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { ForgotPage } from '../src/pages/auth/ForgotPage';
import { InvitePage } from '../src/pages/auth/InvitePage';
import { ResetPage } from '../src/pages/auth/ResetPage';
import { fail, me, renderApp } from './render';

beforeEach(() => localStorage.clear());

describe('sign in', () => {
	it('signs in with email and password, stores the token and fetches the session', async () => {
		let signedIn = false;
		const { calls } = renderApp(<AuthPage />, {
			role: null,
			routes: {
				'POST /api/auth/login': () => {
					signedIn = true;
					return { token: 'tok-1' };
				},
				'GET /api/me': () => (signedIn ? me('owner') : fail(401)),
			},
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'a@example.com');
		await user.type(screen.getByLabelText('Password'), 'correct-horse');
		await user.click(screen.getByRole('button', { name: 'Sign in' }));

		await waitFor(() => expect(tokenStore.get()).toBe('tok-1'));
		expect(calls.find((c) => c.path === '/api/auth/login')?.body).toEqual({ email: 'a@example.com', password: 'correct-horse' });
	});

	it('shows the server message for a wrong password and keeps no token', async () => {
		renderApp(<AuthPage />, { role: null, routes: { 'POST /api/auth/login': fail(401, 'invalid credentials') } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'a@example.com');
		await user.type(screen.getByLabelText('Password'), 'nope-nope');
		await user.click(screen.getByRole('button', { name: 'Sign in' }));

		expect(await screen.findByRole('alert')).toHaveTextContent('invalid credentials');
		expect(tokenStore.get()).toBe('');
	});

	it('offers OAuth buttons only for configured providers', async () => {
		renderApp(<AuthPage />, { role: null, status: { oauth_providers: ['github'] } });
		expect(await screen.findByRole('button', { name: 'GitHub' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Google' })).not.toBeInTheDocument();
	});

	it('has no OAuth section and says sign-up is closed on a closed self-hosted instance', async () => {
		renderApp(<AuthPage />, { role: null });
		await screen.findByRole('button', { name: 'Sign in' });
		expect(screen.queryByText('or continue with')).not.toBeInTheDocument();
		expect(screen.getByText(/Sign-up is closed/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Create an account' })).not.toBeInTheDocument();
	});
});

describe('first-run setup', () => {
	it('shows the create-account form when no owner exists, and validates before calling the API', async () => {
		const { calls } = renderApp(<AuthPage />, { role: null, status: { configured: false, has_domain: false } });
		const user = userEvent.setup();
		expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
		await user.type(screen.getByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'different-123');
		await user.click(screen.getByRole('button', { name: 'Create account' }));

		expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/auth/setup')).toBe(false);
	});

	it('creates the owner with the telemetry choice', async () => {
		let done = false;
		const { calls } = renderApp(<AuthPage />, {
			role: null,
			status: { configured: false, has_domain: false },
			routes: {
				'POST /api/auth/setup': () => ((done = true), { token: 'tok-owner', has_domain: false }),
				'GET /api/me': () => (done ? me('owner') : fail(401)),
			},
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('checkbox'));
		await user.click(screen.getByRole('button', { name: 'Create account' }));

		await waitFor(() => expect(tokenStore.get()).toBe('tok-owner'));
		expect(calls.find((c) => c.path === '/api/auth/setup')?.body).toMatchObject({ email: 'owner@example.com', telemetry: true });
	});
});

describe('hosted sign-up', () => {
	it('lets people create an account when sign-up is open, and switch back', async () => {
		renderApp(<AuthPage />, { role: null, status: { mode: 'saas', signup_open: true } });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Create an account' }));
		expect(screen.getByRole('heading', { name: 'Create an account' })).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Sign in' }));
		expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
	});
});

describe('forgot and reset', () => {
	it('gives the same answer for any email', async () => {
		renderApp(<ForgotPage />, { role: null, routes: { 'POST /api/auth/forgot': { ok: true } } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'whoever@example.com');
		await user.click(screen.getByRole('button', { name: 'Send reset link' }));
		expect(await screen.findByText(/If an account exists for/)).toHaveTextContent('whoever@example.com');
	});

	function resetRoute(token: string) {
		return (
			<Routes>
				<Route path="/reset/:token" element={<ResetPage />} />
			</Routes>
		);
	}

	it('turns a 400 into the expired-link screen', async () => {
		renderApp(resetRoute('abcdefghijkl'), { role: null, route: '/reset/abcdefghijkl', routes: { 'POST /api/auth/reset': fail(400, 'reset link is invalid or has expired') } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('New password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: /Set password/ }));
		expect(await screen.findByRole('heading', { name: 'Link expired' })).toBeInTheDocument();
	});

	it('rejects a malformed token without calling the API', async () => {
		const { calls } = renderApp(resetRoute('x'), { role: null, route: '/reset/short' });
		expect(await screen.findByRole('heading', { name: 'Link expired' })).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/auth/reset')).toBe(false);
	});
});

describe('invite', () => {
	const route = (
		<Routes>
			<Route path="/invite/:token" element={<InvitePage />} />
		</Routes>
	);

	it('shows who invited you and the role, then accepts', async () => {
		let accepted = false;
		const { calls } = renderApp(route, {
			role: null,
			route: '/invite/tok123',
			routes: {
				'GET /api/invites/tok123': { email: 'new@example.com', invited_by: 'boss@example.com', role: 'member' },
				'POST /api/invites/tok123': () => ((accepted = true), { token: 'tok-new' }),
				'GET /api/me': () => (accepted ? me('member') : fail(401)),
			},
		});
		const user = userEvent.setup();
		expect(await screen.findByText('boss@example.com')).toBeInTheDocument();
		expect(screen.getByLabelText('Invited email')).toHaveTextContent('new@example.com');
		await user.type(screen.getByLabelText('Your name'), 'New Person');
		await user.type(screen.getByLabelText('Password'), 'long-enough-1');
		await user.type(screen.getByLabelText('Confirm password'), 'long-enough-1');
		await user.click(screen.getByRole('button', { name: 'Accept invite' }));
		await waitFor(() => expect(tokenStore.get()).toBe('tok-new'));
		expect(calls.find((c) => c.method === 'POST' && c.path === '/api/invites/tok123')?.body).toEqual({ name: 'New Person', password: 'long-enough-1' });
	});

	it('distinguishes a dead invite (404) from a failed lookup', async () => {
		renderApp(route, { role: null, route: '/invite/gone', routes: { 'GET /api/invites/gone': fail(404, 'invite not found or expired') } });
		expect(await screen.findByRole('heading', { name: 'Invite not found' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
	});

	it('offers a retry when the server fails', async () => {
		renderApp(route, { role: null, route: '/invite/x', routes: { 'GET /api/invites/x': fail(503) } });
		expect(await screen.findByRole('heading', { name: 'Could not load the invite' }, { timeout: 4000 })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});
});
