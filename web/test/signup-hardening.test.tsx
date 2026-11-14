// Before public sign-up opens: resends pass the bot check, the welcome page asks for the name, names render clean.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanName } from '../src/lib/names';
import type { AuthStatus } from '../src/lib/types';
import { CheckEmail } from '../src/pages/auth/CheckEmail';
import { WelcomePage } from '../src/pages/auth/WelcomePage';
import { MembersPage } from '../src/pages/members/MembersPage';
import { fail, me, renderApp } from './render';

const HOSTED: Partial<AuthStatus> = { mode: 'saas', signup_open: true, configured: true, turnstile_site_key: '1x00000000000000000000AA' };
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jIn0.sig';

beforeEach(() => localStorage.clear());

describe('resend passes the bot check', () => {
	it('"Check your email" shows the bot check with the resend button, and says the truth about what was sent', async () => {
		const { calls, container } = renderApp(<CheckEmail email="a@example.com" />, { role: null, status: HOSTED, routes: { 'POST /api/auth/resend-verification': { ok: true } } });
		const button = await screen.findByRole('button', { name: 'Resend verification email' });
		expect(container.querySelector('form .cf-turnstile')).not.toBeNull();
		await userEvent.setup().click(button);
		expect(await screen.findByText('If this address is waiting to be confirmed, a new link is on its way. It can take a minute to arrive.')).toBeInTheDocument();
		expect(screen.queryByText(/Verification email sent/)).toBeNull();
		expect(calls.find((c) => c.path === '/api/auth/resend-verification')).toBeTruthy();
	});

	it('the expired-link page\'s "Send me a new link" shows the bot check too', async () => {
		const { container } = renderApp(
			<Routes>
				<Route path="/welcome/:token" element={<WelcomePage />} />
			</Routes>,
			{ role: null, status: HOSTED, route: `/welcome/${TOKEN}`, routes: { 'POST /api/auth/welcome': { __status: 410, body: { code: 'link_expired', error: 'expired' } } } },
		);
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Password'), 'chosen-once-1');
		await user.type(screen.getByLabelText('Confirm password'), 'chosen-once-1');
		await user.click(screen.getByRole('button', { name: 'Save password and continue' }));
		await screen.findByRole('button', { name: 'Send me a new link' });
		expect(container.querySelector('form .cf-turnstile')).not.toBeNull();
	});
});

describe('the welcome page asks for the name', () => {
	it('an optional "Your name" goes with the password', async () => {
		let saved = false;
		const { calls } = renderApp(
			<Routes>
				<Route path="/welcome/:token" element={<WelcomePage />} />
				<Route path="/" element={<p>home</p>} />
			</Routes>,
			{ role: null, status: HOSTED, route: `/welcome/${TOKEN}`, routes: { 'POST /api/auth/welcome': () => ((saved = true), { ok: true }), 'GET /api/me': () => (saved ? me('owner') : fail(401)) } },
		);
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Your name (optional)'), 'Cleo Fox');
		expect(screen.getByText('Shown to people you invite to your workspace.')).toBeInTheDocument();
		await user.type(screen.getByLabelText('Password'), 'chosen-once-1');
		await user.type(screen.getByLabelText('Confirm password'), 'chosen-once-1');
		await user.click(screen.getByRole('button', { name: 'Save password and continue' }));
		await screen.findByText('home');
		expect(calls.find((c) => c.path === '/api/auth/welcome')?.body).toEqual({ token: TOKEN, password: 'chosen-once-1', name: 'Cleo Fox' });
	});
});

describe('names render clean', () => {
	it('control and invisible characters are removed, and length is capped', () => {
		expect(cleanName('A‮evil\u0000 ​name\n\tx')).toBe('A evil name x');
		expect([...cleanName('x'.repeat(200))]).toHaveLength(80);
		expect(cleanName(null)).toBe('');
	});

	it('a member\'s stored name with a bidi override shows as plain text', async () => {
		renderApp(<MembersPage />, {
			role: 'owner',
			routes: {
				'GET /api/team': { users: [{ id: 'u2', email: 'x@example.com', name: 'Eve\u202Etxt.exe', role: 'member', last_login_at: null, created_at: 1 }], current_user_id: 'o1' },
				'GET /api/team/invites': { invites: [] },
			},
		});
		await waitFor(() => expect(screen.getByText('Eve txt.exe')).toBeInTheDocument());
		expect(screen.queryByText(/‮/)).toBeNull();
	});
});
