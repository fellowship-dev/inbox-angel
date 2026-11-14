import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentSetupPage } from '../src/pages/agent/AgentSetupPage';
import { SetupCheck } from '../src/components/SetupCheck';
import { FIRST_PROMPT } from '../src/lib/instance';
import { me, renderApp } from './render';

const ready = { 'GET /api/agents/status': { available: true, server_url: 'https://mail.example.com/mcp' } };
const notReady = { 'GET /api/agents/status': { available: false, server_url: null } };
const owner = { 'GET /api/me': { ...me('owner'), instance_owner: true } };
const preflight = (items: unknown[]) => ({ 'GET /api/instance/preflight': { mode: 'self-host', agents: { available: false, server_url: null }, items } });

describe('Agents page', () => {
	it('shows what an agent can do, the server URL, a first prompt, where to revoke, and what it can never do', async () => {
		renderApp(<AgentSetupPage />, { routes: ready });
		expect(await screen.findByText('https://mail.example.com/mcp')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'What an agent can do here' })).toBeInTheDocument();
		expect(screen.getByText(FIRST_PROMPT)).toBeInTheDocument();
		expect(FIRST_PROMPT).toMatch(/whoami/);
		expect(FIRST_PROMPT).toMatch(/Don't change anything yourself/);
		expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open your connections' })).toHaveAttribute('href', '/settings');
		const never = screen.getByRole('heading', { name: 'What an agent can never do here' }).closest('section')!;
		expect(within(never).getByText('Change your DNS records')).toBeInTheDocument();
		expect(within(never).getByText('Tighten your DMARC policy to quarantine or reject')).toBeInTheDocument();
	});

	it('tells someone who does not run the instance that agents are not set up, without settings names or a preflight request', async () => {
		const { calls } = renderApp(<AgentSetupPage />, { role: 'member', routes: notReady });
		expect(await screen.findByText("Agents can't connect to this instance yet")).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/OAUTH_KV|BETTER_AUTH_URL/);
		expect(screen.queryByText('https://mail.example.com/mcp')).not.toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/instance/preflight')).toBe(false);
	});

	it('tells the person who runs it exactly what to configure', async () => {
		renderApp(<AgentSetupPage />, {
			routes: { ...notReady, ...owner, ...preflight([{ id: 'oauth_storage', severity: 'action', setting: 'OAUTH_KV', message: 'No OAUTH_KV namespace is bound.' }, { id: 'booking_link', severity: 'note', setting: 'BOOKING_URL', message: 'No booking link.' }]) },
		});
		expect(await screen.findByText('No OAUTH_KV namespace is bound.')).toBeInTheDocument();
		expect(screen.queryByText('No booking link.')).not.toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'the operator guide' })).toHaveAttribute('href', expect.stringContaining('agent-operations.md'));
	});
});

describe('SetupCheck', () => {
	it('shows the owner a banner only while something needs action, with setting names and no values', async () => {
		renderApp(<SetupCheck compact />, { routes: { ...owner, ...preflight([{ id: 'bot_check', severity: 'action', setting: 'TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY', message: 'Sign-up is closed: the bot check is not configured.' }]) } });
		expect(await screen.findByText('One setting needs your attention')).toBeInTheDocument();
		expect(screen.getByText(/Only you see this/)).toBeInTheDocument();
		expect(screen.getByText('(TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY)')).toBeInTheDocument();
	});

	it('stays quiet for notes only', async () => {
		const { calls } = renderApp(<SetupCheck compact />, { routes: { ...owner, ...preflight([{ id: 'booking_link', severity: 'note', setting: 'BOOKING_URL', message: 'No booking link.' }]) } });
		await waitFor(() => expect(calls.some((c) => c.path === '/api/instance/preflight')).toBe(true));
		expect(screen.queryByText('No booking link.')).not.toBeInTheDocument();
	});

	it('never asks the server when the viewer does not run the instance', async () => {
		const { calls } = renderApp(<SetupCheck />, { role: 'admin' });
		await waitFor(() => expect(calls.some((c) => c.path === '/api/me')).toBe(true));
		await new Promise((r) => setTimeout(r, 50));
		expect(calls.some((c) => c.path === '/api/instance/preflight')).toBe(false);
	});

	it('in Settings, lists notes too, or says there is nothing to fix', async () => {
		renderApp(<SetupCheck />, { routes: { ...owner, ...preflight([]) } });
		expect(await screen.findByText('Nothing to fix')).toBeInTheDocument();
	});
});
