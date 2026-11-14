import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import { createQueryClient } from '../src/lib/query';
import { readSignupDomain, rememberSignupDomain, SIGNUP_DOMAIN_KEY } from '../src/lib/signup-intent';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { DomainStep } from '../src/pages/wizards/setup/DomainStep';
import { fail, me, mockApi, renderApp, STATUS } from './render';

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

const OPEN = { signup_open: true } as const;
const LINE = /You're adding .* You'll confirm it after you verify your email\./;

describe('AuthPage initialMode="signup"', () => {
	it('opens on the create-account form when sign-up is open', async () => {
		renderApp(<AuthPage initialMode="signup" />, { role: null, status: OPEN });
		expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
	});

	it('is the normal sign-in screen when sign-up is closed', async () => {
		renderApp(<AuthPage initialMode="signup" />, { role: null, status: { signup_open: false } });
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
		expect(screen.queryByText(LINE)).toBeNull();
	});

	it('without the prop, still opens on sign-in', async () => {
		renderApp(<AuthPage />, { role: null, status: OPEN });
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
	});

	it('says which domain is being added, in mono, in one line', async () => {
		rememberSignupDomain('acme.io');
		renderApp(<AuthPage initialMode="signup" />, { role: null, status: OPEN });
		const line = await screen.findByText(LINE);
		expect(line).toHaveTextContent("You're adding acme.io. You'll confirm it after you verify your email.");
		expect(screen.getByText('acme.io')).toHaveClass('font-mono');
	});

	it('shows no line when nothing is remembered', async () => {
		renderApp(<AuthPage initialMode="signup" />, { role: null, status: OPEN });
		await screen.findByRole('heading', { name: 'Create an account' });
		expect(screen.queryByText(LINE)).toBeNull();
	});

	it('cannot be made to render markup: a script-like value never gets stored, and a tampered entry is dropped on read', async () => {
		rememberSignupDomain('<img src=x onerror=alert(1)>');
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
		localStorage.setItem(SIGNUP_DOMAIN_KEY, JSON.stringify({ domain: '<img src=x onerror=alert(1)>', expires: Date.now() + 1e6 }));
		const { container } = renderApp(<AuthPage initialMode="signup" />, { role: null, status: OPEN });
		await screen.findByRole('heading', { name: 'Create an account' });
		expect(container.querySelector('img')).toBeNull();
		expect(screen.queryByText(LINE)).toBeNull();
		expect(localStorage.getItem(SIGNUP_DOMAIN_KEY)).toBeNull();
	});
});

const at = (route: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
function boot(route: string, routes: Record<string, unknown>) {
	const api = mockApi({ 'GET /api/auth/status': { ...STATUS, ...OPEN }, 'GET /api/version': { current: '1.2.0', latest: '1.2.0', update_available: false, release_url: '' }, ...routes });
	render(<App queryClient={createQueryClient()} Router={at(route)} />);
	return api;
}

describe('the /signup route', () => {
	it('anonymous: the create-account screen with the remembered domain', async () => {
		rememberSignupDomain('acme.io');
		boot('/signup', { 'GET /api/me': fail(401) });
		expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeInTheDocument();
		expect(screen.getByText(LINE)).toHaveTextContent("You're adding acme.io.");
	});

	it('signed in: goes to the app instead (and a domain-less workspace on to setup)', async () => {
		boot('/signup', { 'GET /api/me': me('owner'), 'GET /api/auth/status': { ...STATUS, ...OPEN, has_domain: false } });
		await waitFor(() => expect(screen.queryByRole('heading', { name: 'Create an account' })).toBeNull());
		await waitFor(() => expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull());
	});
});

const claim = { id: 4, domain: 'acme.io', status: 'pending', txt_name: '_inboxangel.acme.io', txt_value: 'inboxangel-verify=abc', created_at: 1, last_checked_at: null, last_error: null };
const noPreview = { 'GET /api/domains/claims/4/preview': fail(429) };

describe('DomainStep prefill', () => {
	it('starts with the remembered domain in the input, and submits it only when the person presses Continue', async () => {
		rememberSignupDomain('acme.io');
		const { calls } = renderApp(<DomainStep onDomainSet={() => {}} />, { routes: { 'GET /api/zones': fail(400), 'POST /api/settings/base-domain': { __status: 202, body: { pending: true, claim } }, ...noPreview } });
		const input = (await screen.findByLabelText('Main domain')) as HTMLInputElement;
		expect(input.value).toBe('acme.io');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByText('Verify you own this domain');
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ domain: 'acme.io' });
	});

	it('uses the typed value when edited', async () => {
		rememberSignupDomain('acme.io');
		const { calls } = renderApp(<DomainStep onDomainSet={() => {}} />, { routes: { 'GET /api/zones': fail(400), 'POST /api/settings/base-domain': { __status: 202, body: { pending: true, claim } }, ...noPreview } });
		const input = await screen.findByLabelText('Main domain');
		await userEvent.clear(input);
		await userEvent.type(input, 'München.de ');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ domain: 'xn--mnchen-3ya.de' }));
	});

	it('keeps the existing error for something that is not a domain, and sends nothing', async () => {
		const { calls } = renderApp(<DomainStep onDomainSet={() => {}} />, { routes: { 'GET /api/zones': fail(400) } });
		await userEvent.type(await screen.findByLabelText('Main domain'), 'https://x.com/path');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('Enter a valid domain like yourdomain.com')).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('a prefilled domain that is not in the Cloudflare zone list switches to the typed input', async () => {
		rememberSignupDomain('acme.io');
		renderApp(<DomainStep onDomainSet={() => {}} />, { routes: { 'GET /api/zones': { zones: [{ id: 'z1', name: 'other.com', status: 'active' }] } } });
		const input = (await screen.findByLabelText('Main domain')) as HTMLInputElement;
		await waitFor(() => expect(input.tagName).toBe('INPUT'));
		expect(input.value).toBe('acme.io');
	});

	it('a prefilled domain that is in the zone list is selected in the list', async () => {
		rememberSignupDomain('acme.io');
		renderApp(<DomainStep onDomainSet={() => {}} />, { routes: { 'GET /api/zones': { zones: [{ id: 'z1', name: 'acme.io', status: 'active' }] } } });
		await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('acme.io'));
	});

	it('forgets the remembered domain once the claim is made (202)', async () => {
		rememberSignupDomain('acme.io');
		renderApp(<DomainStep onDomainSet={() => {}} />, { routes: { 'GET /api/zones': fail(400), 'POST /api/settings/base-domain': { __status: 202, body: { pending: true, claim } }, ...noPreview } });
		await screen.findByLabelText('Main domain');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByText('Verify you own this domain');
		expect(readSignupDomain()).toBeNull();
	});

	it('forgets it once the domain is added (201), and keeps it when the request fails', async () => {
		rememberSignupDomain('acme.io');
		const onDomainSet = vi.fn();
		let ok = false;
		renderApp(<DomainStep onDomainSet={onDomainSet} />, { routes: { 'GET /api/zones': fail(400), 'POST /api/settings/base-domain': () => (ok ? { ok: true, domain: 'acme.io', domain_id: 9 } : fail(500)) } });
		await screen.findByLabelText('Main domain');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByText('Server error. Try again.');
		expect(readSignupDomain()).toBe('acme.io');
		ok = true;
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await waitFor(() => expect(onDomainSet).toHaveBeenCalledWith(9));
		expect(readSignupDomain()).toBeNull();
	});

	it('keeps a remembered domain when a different one was submitted', async () => {
		rememberSignupDomain('acme.io');
		renderApp(<DomainStep onDomainSet={() => {}} />, { routes: { 'GET /api/zones': fail(400), 'POST /api/settings/base-domain': { ok: true, domain: 'other.com', domain_id: 2 } } });
		const input = await screen.findByLabelText('Main domain');
		await userEvent.clear(input);
		await userEvent.type(input, 'other.com');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await waitFor(() => expect(screen.getByRole('button', { name: /Continue|Setting up/ })).toBeInTheDocument());
		expect(readSignupDomain()).toBe('acme.io');
	});
});

describe('AddDomainPage prefill', () => {
	it('starts with the remembered domain, submits on Continue, then forgets it', async () => {
		rememberSignupDomain('acme.io');
		const { calls } = renderApp(<AddDomainPage />, { routes: { 'GET /api/zones': fail(400), 'POST /api/domains': { __status: 202, body: { pending: true, claim, domain: null } }, ...noPreview } });
		const input = (await screen.findByLabelText('Your domain')) as HTMLInputElement;
		expect(input.value).toBe('acme.io');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByText('Verify you own this domain');
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ domain: 'acme.io' });
		expect(readSignupDomain()).toBeNull();
	});

	it('forgets it after a 201 too', async () => {
		rememberSignupDomain('acme.io');
		renderApp(<AddDomainPage />, {
			routes: {
				'GET /api/zones': fail(400),
				'POST /api/domains': { __status: 201, body: { domain: { id: 7, domain: 'acme.io', rua_address: '', parent_id: null }, rua_hint: '' } },
				'GET /api/domains/7/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
			},
		});
		await screen.findByLabelText('Your domain');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByText('Domain added');
		expect(readSignupDomain()).toBeNull();
	});

	it('shows the typed input when the prefilled domain is not one of the zones', async () => {
		rememberSignupDomain('acme.io');
		renderApp(<AddDomainPage />, { routes: { 'GET /api/zones': { zones: [{ id: 'z1', name: 'other.com', status: 'active' }] } } });
		const input = (await screen.findByLabelText('Your domain')) as HTMLInputElement;
		await waitFor(() => expect(input.tagName).toBe('INPUT'));
		expect(input.value).toBe('acme.io');
	});
});

describe('AuthPage on an instance without bot protection', () => {
	const CLOSED = { mode: 'saas', signup_open: false, signin_available: false, signup_unavailable_reason: 'bot_protection_not_configured' } as const;
	const MESSAGE = 'Sign-up and sign-in are not available on this instance yet: bot protection is not configured.';

	it.each([[undefined], ['signup' as const]])('shows one Alert and no form (initialMode %s)', async (initialMode) => {
		renderApp(<AuthPage initialMode={initialMode} />, { role: null, status: CLOSED });
		expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGE);
		expect(screen.getAllByRole('alert')).toHaveLength(1);
		expect(document.querySelector('form')).toBeNull();
		expect(screen.queryByLabelText(/email/i)).toBeNull();
		expect(screen.queryByLabelText(/password/i)).toBeNull();
		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.queryByText(/coming soon/i)).toBeNull();
	});

	it('self-host and a working hosted instance keep their forms', async () => {
		const { unmount } = renderApp(<AuthPage />, { role: null, status: { signin_available: true } });
		expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
		expect(screen.queryByText(MESSAGE)).toBeNull();
		unmount();
		renderApp(<AuthPage initialMode="signup" />, { role: null, status: { mode: 'saas', signup_open: true, signin_available: true } });
		expect(await screen.findByRole('button', { name: 'Create account' })).toBeInTheDocument();
	});
});
