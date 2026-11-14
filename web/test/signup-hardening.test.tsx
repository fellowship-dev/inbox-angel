// Before public sign-up opens: resends pass the bot check, the welcome page asks for the name, names render clean.
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanName } from '../src/lib/names';
import type { AuthStatus } from '../src/lib/types';
import { CheckEmail } from '../src/pages/auth/CheckEmail';
import { __resetTurnstileLoaderForTests } from '../src/pages/auth/Turnstile';
import { WelcomePage } from '../src/pages/auth/WelcomePage';
import { MembersPage } from '../src/pages/members/MembersPage';
import { fail, me, renderApp } from './render';

const HOSTED: Partial<AuthStatus> = { mode: 'saas', signup_open: true, configured: true, turnstile_site_key: '1x00000000000000000000AA' };
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jIn0.sig';

beforeEach(() => localStorage.clear());

/** A stand-in for Cloudflare's script, already loaded: records render/reset/remove; `solve()` plays the widget's callback. */
function fakeTurnstile() {
	const widgets: Array<{ el: HTMLElement; opts: any; id: string }> = [];
	const api = {
		render: vi.fn((el: HTMLElement, opts: any) => {
			const id = `w${widgets.length + 1}`;
			widgets.push({ el, opts, id });
			return id;
		}),
		reset: vi.fn(),
		remove: vi.fn(),
	};
	window.turnstile = api as any;
	const solve = (token = 'tok-1', i = widgets.length - 1) => act(() => widgets[i]!.opts.callback(token));
	return { api, widgets, solve };
}
afterEach(() => {
	delete window.turnstile;
	__resetTurnstileLoaderForTests();
	document.querySelectorAll('script[data-cf-turnstile]').forEach((el) => el.remove());
});

describe('the human check is rendered explicitly, per form', () => {
	it('"Check your email": the widget is rendered on this screen, Resend waits for it, sends its token, then resets', async () => {
		const t = fakeTurnstile();
		const { calls } = renderApp(<CheckEmail email="a@example.com" />, { role: null, status: HOSTED, routes: { 'POST /api/auth/resend-verification': { ok: true } } });
		const button = await screen.findByRole('button', { name: 'Resend verification email' });
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		expect(t.api.render.mock.calls[0]![0]).toBe(screen.getByTestId('human-check'));
		expect(t.api.render.mock.calls[0]![1]).toMatchObject({ sitekey: HOSTED.turnstile_site_key });
		expect(button).toBeDisabled();
		expect(screen.getByText('Waiting for the human check…')).toBeInTheDocument();
		await t.solve('tok-1');
		expect(button).toBeEnabled();
		await userEvent.setup().click(button);
		expect(await screen.findByText('If this address is waiting to be confirmed, a new link is on its way. It can take a minute to arrive.')).toBeInTheDocument();
		expect(calls.find((c) => c.path === '/api/auth/resend-verification')?.body).toEqual({ email: 'a@example.com', cf_turnstile_token: 'tok-1' });
		expect(t.api.reset).toHaveBeenCalledWith('w1'); // a token is single use
		expect(button).toBeDisabled();
	});

	it('an expired token disables the button again', async () => {
		const t = fakeTurnstile();
		renderApp(<CheckEmail email="a@example.com" />, { role: null, status: HOSTED });
		const button = await screen.findByRole('button', { name: 'Resend verification email' });
		await waitFor(() => expect(t.api.render).toHaveBeenCalled());
		await t.solve('tok-1');
		expect(button).toBeEnabled();
		await act(() => t.widgets[0]!.opts['expired-callback']());
		expect(button).toBeDisabled();
		expect(t.api.reset).toHaveBeenCalledWith('w1');
	});

	it('a check that does not pass says so and offers another try', async () => {
		const t = fakeTurnstile();
		renderApp(<CheckEmail email="a@example.com" />, { role: null, status: HOSTED });
		const button = await screen.findByRole('button', { name: 'Resend verification email' });
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		await act(() => t.widgets[0]!.opts['error-callback']());
		expect(button).toBeDisabled();
		expect(screen.getByRole('alert')).toHaveTextContent('The human check did not pass. Try it again or reload the page.');
		await userEvent.setup().click(screen.getByRole('button', { name: 'Try it again' }));
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(2));
		expect(t.api.remove).toHaveBeenCalledWith('w1');
	});

	it('the widget is removed when its form goes away, and a form reached by in-app navigation gets its own', async () => {
		const t = fakeTurnstile();
		const { unmount } = renderApp(<CheckEmail email="a@example.com" onBack={() => {}} />, { role: null, status: HOSTED });
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		unmount();
		expect(t.api.remove).toHaveBeenCalledWith('w1');
		renderApp(<CheckEmail email="a@example.com" />, { role: null, status: HOSTED });
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(2));
	});

	it('loads the script once, explicitly; if it cannot load, says so and retries', async () => {
		renderApp(<CheckEmail email="a@example.com" />, { role: null, status: HOSTED });
		await screen.findByRole('button', { name: 'Resend verification email' });
		const script = await waitFor(() => {
			const s = document.querySelector<HTMLScriptElement>('script[data-cf-turnstile]');
			expect(s).not.toBeNull();
			return s!;
		});
		expect(script.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
		await act(async () => script.onerror!(new Event('error')));
		expect(await screen.findByRole('alert')).toHaveTextContent('The human check could not be loaded. Check your connection, then try again.');
		const t = fakeTurnstile(); // the network is back
		await userEvent.setup().click(screen.getByRole('button', { name: 'try again' }));
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
	});

	it('no site key: no widget and nothing to wait for', async () => {
		renderApp(<CheckEmail email="a@example.com" />, { role: null, status: { ...HOSTED, turnstile_site_key: null } });
		expect(await screen.findByRole('button', { name: 'Resend verification email' })).toBeEnabled();
		expect(screen.queryByTestId('human-check')).toBeNull();
	});

	it('the expired-link page\'s "Send me a new link" renders its own widget', async () => {
		const t = fakeTurnstile();
		renderApp(
			<Routes>
				<Route path="/welcome/:token" element={<WelcomePage />} />
			</Routes>,
			{ role: null, status: HOSTED, route: `/welcome/${TOKEN}`, routes: { 'POST /api/auth/welcome': { __status: 410, body: { code: 'link_expired', error: 'expired' } } } },
		);
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Password'), 'chosen-once-1');
		await user.type(screen.getByLabelText('Confirm password'), 'chosen-once-1');
		await user.click(screen.getByRole('button', { name: 'Save password and continue' }));
		expect(await screen.findByRole('button', { name: 'Send me a new link' })).toBeDisabled();
		await waitFor(() => expect(t.api.render).toHaveBeenCalledTimes(1));
		await t.solve('tok-9');
		expect(screen.getByRole('button', { name: 'Send me a new link' })).toBeEnabled();
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
