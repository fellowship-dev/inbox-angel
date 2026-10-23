import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { tokenStore } from '../src/lib/api';
import { createQueryClient } from '../src/lib/query';
import { hashFor, LAST_WORKSPACE_KEY, parseHash, workspaceStore } from '../src/lib/workspace';
import { fail, mockApi, STATUS, type Handler } from './render';
import type { Me, Role } from '../src/lib/types';

const domain = (id: number, name: string, extra = {}) => ({ id, domain: name, dmarc_policy: 'reject', rua_address: 'r@x.io', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0, ...extra });
const summary = (id: number, name: string, extra = {}) => ({ domain_id: id, domain: name, dmarc_policy: 'reject', spf_record: 'v=spf1 -all', total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, ...extra });
const wizard = (done: number) => ({ domain: done > 0 ? 'complete' : 'not_started', spf: done > 1 ? 'complete' : 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started' });

const FELLOWSHIP = { id: 'ws_default', name: 'Fellowship', role: 'owner' as Role, member_count: 2, created_at: 1 };
const LEXGO = { id: 'ws_lexgo', name: 'Lexgo', role: 'owner' as Role, member_count: 3, created_at: 2 };

const meFor = (w: { id: string; role: Role }): Me => ({ user: { id: 'u1', email: 'max@example.com', name: 'Max' }, role: w.role, workspace_id: w.id, kind: 'session' });

/** An API where /api/me answers for the workspace named by X-Workspace-Id (403 for one the person is not in), like the server. */
function server(workspaces = [FELLOWSHIP, LEXGO], extra: Record<string, unknown | Handler> = {}) {
	const domains: Record<string, string[]> = { ws_default: ['fellowship.example.com'], ws_lexgo: ['lexgo-one.example.com', 'lexgo-two.example.com'] };
	const current = (h: Record<string, string>) => {
		const id = h['x-workspace-id'];
		return id ? workspaces.find((w) => w.id === id) : workspaces[0];
	};
	return mockApi({
		'GET /api/auth/status': STATUS,
		'GET /api/version': { current: '1.2.0', latest: '1.2.0', update_available: false, release_url: '' },
		'GET /api/me': ({ headers }: { headers: Record<string, string> }) => {
			const w = current(headers);
			return w ? meFor(w) : fail(403, 'not a member of that workspace');
		},
		'GET /api/workspaces': { workspaces },
		'GET /api/domains': ({ headers }: { headers: Record<string, string> }) => ({
			domains: (domains[current(headers)?.id ?? ''] ?? []).map((name, i) => domain(i + 1, name)),
		}),
		...Object.fromEntries([1, 2].flatMap((id) => [
			[`GET /api/domains/${id}/stats`, { domain: 'x', days: 7, stats: [] }],
			[`GET /api/domains/${id}/check-summary`, summary(id, 'x')],
			[`GET /api/domains/${id}/wizard-state`, wizard(2)],
		])),
		...extra,
	});
}

function boot(hash: string) {
	window.location.hash = hash;
	return render(<App queryClient={createQueryClient()} />);
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.location.hash = '';
	workspaceStore.reload();
	tokenStore.set('t');
});

describe('workspace URLs', () => {
	it('parses and builds #/w/<id>/… and leaves invite and reset links alone', () => {
		expect(parseHash('#/w/ws_a/domains/1')).toEqual({ workspaceId: 'ws_a', rest: '/domains/1', isPublic: false });
		expect(parseHash('#/w/ws_a')).toEqual({ workspaceId: 'ws_a', rest: '/', isPublic: false });
		expect(parseHash('#/keys')).toEqual({ workspaceId: null, rest: '/keys', isPublic: false });
		expect(parseHash('#/invite/abc').isPublic).toBe(true);
		expect(parseHash('#/reset/abc').isPublic).toBe(true);
		expect(hashFor('ws_a', '/domains/1')).toBe('#/w/ws_a/domains/1');
		expect(hashFor('ws_a')).toBe('#/w/ws_a/');
	});
});

describe('workspace switcher', () => {
	it('lands in the last-used workspace, writes it into the URL and sends it with every request', async () => {
		localStorage.setItem(LAST_WORKSPACE_KEY, 'ws_lexgo');
		workspaceStore.reload();
		const api = server();
		boot('#/');
		expect(await screen.findByRole('button', { name: /Workspace: Lexgo/ })).toBeInTheDocument();
		await waitFor(() => expect(window.location.hash).toBe('#/w/ws_lexgo/'));
		expect((await screen.findAllByText('lexgo-one.example.com')).length).toBeGreaterThan(0);
		expect(api.calls.filter((c) => c.path === '/api/domains').every((c) => c.headers['x-workspace-id'] === 'ws_lexgo')).toBe(true);
	});

	it('first visit with nothing remembered opens the oldest workspace and remembers it', async () => {
		server();
		boot('#/');
		expect(await screen.findByRole('button', { name: /Workspace: Fellowship/ })).toBeInTheDocument();
		await waitFor(() => expect(window.location.hash).toBe('#/w/ws_default/'));
		expect(localStorage.getItem(LAST_WORKSPACE_KEY)).toBe('ws_default');
	});

	it('a deep link keeps its workspace and page, and the sidebar links stay inside the workspace', async () => {
		server(undefined, { 'GET /api/keys': { keys: [] } });
		boot('#/w/ws_lexgo/keys');
		expect(await screen.findByRole('heading', { name: 'API keys', level: 1 })).toBeInTheDocument();
		const nav = screen.getByRole('navigation', { name: 'Main' });
		expect(within(nav).getByRole('link', { name: 'Members' })).toHaveAttribute('href', '#/w/ws_lexgo/members');
		expect(await screen.findByRole('button', { name: /Workspace: Lexgo/ })).toBeInTheDocument();
	});

	it('lists every workspace with the role in it, and switching shows only the selected one’s data', async () => {
		const api = server([FELLOWSHIP, { ...LEXGO, role: 'member' }]);
		boot('#/w/ws_default/');
		expect((await screen.findAllByText('fellowship.example.com')).length).toBeGreaterThan(0);
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: /Workspace: Fellowship/ }));
		const menu = await screen.findByRole('menu');
		expect(within(menu).getByRole('menuitem', { name: /Fellowship.*owner/ })).toHaveAttribute('aria-current', 'true');
		expect(within(menu).getByRole('menuitem', { name: /Lexgo.*member/ })).toBeInTheDocument();
		expect(within(menu).getByRole('menuitem', { name: 'Create workspace' })).toBeInTheDocument();

		await user.click(within(menu).getByRole('menuitem', { name: /Lexgo/ }));
		await waitFor(() => expect(window.location.hash).toBe('#/w/ws_lexgo/'));
		expect((await screen.findAllByText('lexgo-one.example.com')).length).toBeGreaterThan(0);
		expect(screen.queryByText('fellowship.example.com')).not.toBeInTheDocument();
		// every request after the switch is for Lexgo
		const after = api.calls.slice(api.calls.findIndex((c) => c.headers['x-workspace-id'] === 'ws_lexgo'));
		expect(after.filter((c) => c.path === '/api/domains' || c.path === '/api/me').every((c) => c.headers['x-workspace-id'] === 'ws_lexgo')).toBe(true);
		// and the role there is read-only: the notice shows, the add button is locked
		expect((await screen.findAllByText(/read-only/i)).length).toBeGreaterThan(0);
	});

	it('a remembered workspace that no longer exists is dropped silently', async () => {
		localStorage.setItem(LAST_WORKSPACE_KEY, 'ws_deleted');
		workspaceStore.reload();
		server();
		boot('#/');
		await waitFor(() => expect(window.location.hash).toBe('#/w/ws_default/'));
		expect(localStorage.getItem(LAST_WORKSPACE_KEY)).toBe('ws_default');
		expect(screen.queryByText('That workspace is not available to you')).not.toBeInTheDocument();
	});

	it('a workspace the person lost access to falls back to one they have, with a notice', async () => {
		server();
		boot('#/w/ws_gone/members');
		await waitFor(() => expect(window.location.hash).toBe('#/w/ws_default/members'));
		expect(await screen.findByText('That workspace is not available to you')).toBeInTheDocument();
		expect(await screen.findByRole('button', { name: /Workspace: Fellowship/ })).toBeInTheDocument();
	});

	it('self-host: only the instance owner is offered "Create workspace"; a member or admin of the default workspace is not', async () => {
		server([{ ...FELLOWSHIP, role: 'member' }, { ...LEXGO, role: 'owner' }]);
		boot('#/w/ws_lexgo/');
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: /Workspace: Lexgo/ }));
		const menu = await screen.findByRole('menu');
		expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
		expect(within(menu).queryByRole('menuitem', { name: 'Create workspace' })).not.toBeInTheDocument();
	});

	it('hosted: anyone may create a workspace', async () => {
		server([{ ...FELLOWSHIP, role: 'member' }], { 'GET /api/auth/status': { ...STATUS, mode: 'saas' } });
		boot('#/w/ws_default/');
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: /Workspace: Fellowship/ }));
		expect(await screen.findByRole('menuitem', { name: 'Create workspace' })).toBeInTheDocument();
	});

	it('creates a workspace and opens it at its empty state, not at the setup wizard', async () => {
		const created = { id: 'ws_new', name: 'Acme', role: 'owner' as Role, member_count: 1, created_at: 3 };
		let list = [FELLOWSHIP, LEXGO];
		const api = server(undefined, {
			'GET /api/workspaces': () => ({ workspaces: list }),
			'POST /api/workspaces': () => ((list = [...list, created]), { id: 'ws_new', name: 'Acme', role: 'owner', member_count: 1 }),
			'GET /api/me': ({ headers }: { headers: Record<string, string> }) => {
				const w = list.find((x) => x.id === (headers['x-workspace-id'] ?? 'ws_default'));
				return w ? meFor(w) : fail(403);
			},
			'GET /api/domains': ({ headers }: { headers: Record<string, string> }) => ({ domains: headers['x-workspace-id'] === 'ws_new' ? [] : [] }),
			'GET /api/auth/status': ({ headers }: { headers: Record<string, string> }) => ({ ...STATUS, has_domain: headers['x-workspace-id'] !== 'ws_new' }),
		});
		boot('#/w/ws_default/');
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: /Workspace: Fellowship/ }));
		await user.click(await screen.findByRole('menuitem', { name: 'Create workspace' }));
		await user.type(await screen.findByLabelText('Workspace name'), 'Acme');
		await user.click(screen.getByRole('button', { name: 'Create workspace' }));
		await waitFor(() => expect(window.location.hash).toBe('#/w/ws_new/'));
		expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/workspaces')?.body).toEqual({ name: 'Acme' });
		expect(await screen.findByText('No domains yet')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Add your first domain' })).toHaveAttribute('href', '#/w/ws_new/setup');
		expect(screen.getByRole('link', { name: 'Connect Cloudflare' })).toBeInTheDocument();
		expect(window.location.hash).toBe('#/w/ws_new/'); // not bounced to the wizard
	});

	it('the Members page names the workspace it is for', async () => {
		server(undefined, { 'GET /api/team': { users: [], current_user_id: 'u1' } });
		boot('#/w/ws_lexgo/members');
		expect(await screen.findByText(/Lexgo: everyone here can see all of its domains/)).toBeInTheDocument();
	});

	it('signed out, the sign-in screen shows at a workspace link without changing it', async () => {
		server(undefined, { 'GET /api/me': fail(401) });
		tokenStore.clear();
		boot('#/w/ws_lexgo/keys');
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
		expect(window.location.hash).toBe('#/w/ws_lexgo/keys');
	});
});

describe('workspace settings (roles in the UI)', () => {
	const settings = async (role: Role, workspaces: typeof FELLOWSHIP[], routes: Record<string, unknown | Handler> = {}) => {
		const { renderApp } = await import('./render');
		const { SettingsPage } = await import('../src/pages/settings/SettingsPage');
		return renderApp(<SettingsPage />, {
			role,
			routes: {
				'GET /api/workspaces': { workspaces },
				'GET /api/me': { user: { id: 'u1', email: 'max@example.com', name: 'Max' }, role, workspace_id: 'ws_default', kind: 'session' },
				'GET /api/version': { current: '1.2.0', latest: '1.2.0', update_available: false, release_url: '' },
				'GET /api/domains': { domains: [] },
				...routes,
			},
		});
	};

	it('an owner can rename, leave and delete (when there is another workspace to land in)', async () => {
		await settings('owner', [FELLOWSHIP, LEXGO]);
		expect(await screen.findByLabelText('Workspace name')).toHaveValue('Fellowship');
		expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled(); // unchanged name
		expect(screen.getByRole('button', { name: 'Leave workspace' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Delete workspace' })).toBeInTheDocument();
	});

	it('a member or admin sees the name only: no rename, no delete (admins and members may still leave)', async () => {
		await settings('admin', [{ ...FELLOWSHIP, role: 'admin' }, LEXGO]);
		expect(await screen.findByRole('button', { name: 'Leave workspace' })).toBeInTheDocument();
		expect(screen.queryByLabelText('Workspace name')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Delete workspace' })).not.toBeInTheDocument();
	});

	it('your only workspace cannot be left or deleted, and the page says why', async () => {
		await settings('owner', [FELLOWSHIP]);
		expect(await screen.findByText(/only workspace, so it cannot be left or deleted/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Leave workspace' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Delete workspace' })).not.toBeInTheDocument();
	});

	it('deleting a workspace with domains needs its name typed, and sends it as confirm', async () => {
		const dom = Array.from({ length: 2 }, (_, i) => ({ id: i + 1, domain: `d${i}.com` }));
		const { calls } = await settings('owner', [FELLOWSHIP, LEXGO], { 'GET /api/domains': { domains: dom }, 'DELETE /api/workspaces/ws_default?confirm=Fellowship': { ok: true } });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Delete workspace' }));
		const dialog = await screen.findByRole('dialog');
		const go = within(dialog).getByRole('button', { name: 'Delete workspace' });
		expect(go).toBeDisabled();
		await user.type(within(dialog).getByLabelText(/Type "Fellowship" to confirm/), 'Fellowship');
		await user.click(go);
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/workspaces/ws_default?confirm=Fellowship')).toBe(true));
	});
});
