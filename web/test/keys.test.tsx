import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiKeysPage } from '../src/pages/keys/ApiKeysPage';
import type { ApiKey } from '../src/lib/types';
import { fail, me, renderApp } from './render';

const SECRET = 'ia_Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA';
const now = Math.floor(Date.now() / 1000);
const key = (over: Partial<ApiKey> = {}): ApiKey => ({ id: 'k1', user_id: 'u1', name: 'CI deploy', prefix: 'ia_Zm9vY', created_at: now - 86400, last_used_at: null, expires_at: null, revoked_at: null, ...over });

beforeEach(() => localStorage.clear());

describe('API keys', () => {
	it('shows the secret once, and a refetched list never contains it', async () => {
		let keys: ApiKey[] = [];
		const { calls } = renderApp(<ApiKeysPage />, {
			routes: {
				'GET /api/keys': () => ({ keys }),
				'POST /api/keys': ({ body }: { body: any }) => {
					keys = [key({ name: body.name })];
					return { id: 'k1', name: body.name, key: SECRET, prefix: 'ia_Zm9vY' };
				},
			},
		});
		const user = userEvent.setup();
		expect(await screen.findByText('No API keys yet')).toBeInTheDocument();

		await user.type(screen.getByLabelText('Name'), 'CI deploy');
		await user.click(screen.getByRole('button', { name: 'Create key' }));

		// The secret is on screen, with a warning that it is the only time.
		const once = await screen.findByTestId('secret-once');
		expect(within(once).getByTestId('secret-value')).toHaveTextContent(SECRET);
		expect(once).toHaveTextContent(/only time/i);
		expect(calls.find((c) => c.method === 'POST' && c.path === '/api/keys')?.body).toEqual({ name: 'CI deploy' });

		// The list shows the prefix, not the secret.
		const table = await screen.findByRole('region', { name: 'API keys' });
		expect(within(table).getByText('ia_Zm9vY…')).toBeInTheDocument();
		expect(within(table).queryByText(SECRET)).not.toBeInTheDocument();

		// Dismissed: gone for good, and nothing re-renders it.
		await user.click(screen.getByRole('button', { name: 'I have saved it' }));
		expect(screen.queryByTestId('secret-once')).not.toBeInTheDocument();
		expect(document.body).not.toHaveTextContent(SECRET);
	});

	it('sends the expiry when one is chosen', async () => {
		const { calls } = renderApp(<ApiKeysPage />, {
			routes: { 'GET /api/keys': { keys: [] }, 'POST /api/keys': { id: 'k', name: 'x', key: SECRET, prefix: 'ia_Zm9vY' } },
		});
		const user = userEvent.setup();
		await screen.findByText('No API keys yet');
		await user.type(screen.getByLabelText('Name'), 'short lived');
		await user.click(screen.getByRole('combobox', { name: 'Expires' }));
		await user.click(await screen.findByRole('option', { name: '30 days' }));
		await user.click(screen.getByRole('button', { name: 'Create key' }));
		await screen.findByTestId('secret-once');
		expect(calls.find((c) => c.method === 'POST' && c.path === '/api/keys')?.body).toEqual({ name: 'short lived', expires_in_days: 30 });
	});

	it('lists prefix, last used and expiry', async () => {
		renderApp(<ApiKeysPage />, {
			routes: { 'GET /api/keys': { keys: [key({ last_used_at: now - 3 * 86400 }), key({ id: 'k2', name: 'old', prefix: 'ia_old12', expires_at: now - 100 })] } },
		});
		const table = await screen.findByRole('region', { name: 'API keys' });
		expect(within(table).getByText('3 days ago')).toBeInTheDocument();
		expect(within(table).getByText('Never used')).toBeInTheDocument();
		expect(within(table).getByText(/^Expired/)).toBeInTheDocument();
	});

	it('revokes one key after confirmation', async () => {
		let keys = [key(), key({ id: 'k2', name: 'other', prefix: 'ia_other' })];
		const { calls } = renderApp(<ApiKeysPage />, {
			routes: {
				'GET /api/keys': () => ({ keys }),
				'DELETE /api/keys/k1': () => ((keys = keys.filter((k) => k.id !== 'k1')), { ok: true }),
			},
		});
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Revoke CI deploy' }));
		const dialog = await screen.findByRole('dialog');
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await user.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
		await waitFor(() => expect(screen.queryByText('CI deploy')).not.toBeInTheDocument());
		expect(screen.getByText('other')).toBeInTheDocument();
	});

	it('revokes all of my keys, not teammates’', async () => {
		let keys = [key(), key({ id: 'k2', name: 'mine too' }), key({ id: 'k3', name: 'theirs', user_id: 'someone-else' })];
		renderApp(<ApiKeysPage />, {
			role: 'admin',
			routes: {
				'GET /api/me': { ...me('admin'), user: { id: 'u1', email: 'admin@example.com', name: 'admin' } },
				'GET /api/keys': () => ({ keys }),
				'POST /api/keys/revoke-all': () => ((keys = keys.filter((k) => k.user_id !== 'u1')), { ok: true, revoked: 2 }),
			},
		});
		const user = userEvent.setup();
		expect(await screen.findByText('theirs')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Revoke all my keys' }));
		const dialog = await screen.findByRole('dialog');
		expect(dialog).toHaveTextContent('Your 2 keys stop');
		await user.click(within(dialog).getByRole('button', { name: 'Revoke all' }));
		await waitFor(() => expect(screen.queryByText('mine too')).not.toBeInTheDocument());
		expect(screen.getByText('theirs')).toBeInTheDocument();
	});

	it('lets members manage their own keys (key routes are self-service)', async () => {
		renderApp(<ApiKeysPage />, { role: 'member', routes: { 'GET /api/keys': { keys: [key()] } } });
		await screen.findByText('CI deploy');
		expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled(); // empty name, not role
		expect(screen.getByLabelText('Name')).toBeEnabled();
		expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
	});

	it('cannot mint keys with another key, and says why', async () => {
		renderApp(<ApiKeysPage />, { routes: { 'GET /api/me': { ...me('owner'), kind: 'api_key' }, 'GET /api/keys': { keys: [] } } });
		await screen.findByText('No API keys yet');
		expect(screen.getByLabelText('Name')).toBeDisabled();
		expect(screen.getByText(/while signed in, not with another key/)).toBeInTheDocument();
	});

	it('explains the instance key instead of failing', async () => {
		renderApp(<ApiKeysPage />, {
			routes: { 'GET /api/me': { user: null, role: 'owner', account_id: 'acct_default', kind: 'instance' }, 'GET /api/keys': fail(403, 'API keys belong to a user') },
		});
		expect(await screen.findByText('API keys belong to a user')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Create key' })).not.toBeInTheDocument();
	});

	it('shows an error with retry when the list fails to load', async () => {
		renderApp(<ApiKeysPage />, { routes: { 'GET /api/keys': fail(500) } });
		expect(await screen.findByText('Could not load API keys')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});
});
