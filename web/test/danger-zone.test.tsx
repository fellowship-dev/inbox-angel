import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MembersPage } from '../src/pages/members/MembersPage';
import { DangerZone } from '../src/pages/settings/DangerZone';
import { renderApp } from './render';

describe('Danger zone', () => {
	it('deletes the account only after the email is typed', async () => {
		const reload = vi.fn();
		vi.stubGlobal('location', { ...window.location, hash: '', reload });
		const { calls } = renderApp(<DangerZone />, { role: 'admin', routes: { 'DELETE /api/account': { ok: true } } });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Delete my account' }));
		const submit = screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!;
		expect(submit).toBeDisabled();
		await user.type(screen.getByLabelText(/Type your email/), 'wrong@example.com');
		expect(submit).toBeDisabled();
		await user.clear(screen.getByLabelText(/Type your email/));
		await user.type(screen.getByLabelText(/Type your email/), 'admin@example.com');
		await user.click(submit);
		await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ confirm: 'admin@example.com' }));
		await waitFor(() => expect(reload).toHaveBeenCalled());
		vi.unstubAllGlobals();
	});

	it('says which workspace must be handed over first', async () => {
		renderApp(<DangerZone />, {
			role: 'owner',
			routes: {
				'DELETE /api/account': () => ({
					__status: 409,
					body: { error: 'you are the only owner', code: 'transfer_required', workspaces: [{ id: 'ws_1', name: 'Lexgo', members: 3 }] },
				}),
			},
		});
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Delete my account' }));
		await user.type(screen.getByLabelText(/Type your email/), 'owner@example.com');
		await user.click(screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!);
		expect(await screen.findByRole('alert')).toHaveTextContent('"Lexgo"');
		expect(screen.getByRole('alert')).toHaveTextContent('Transfer ownership on the Members page');
	});

	it('offers the data export to owners only', async () => {
		const { unmount } = renderApp(<DangerZone />, { role: 'owner' });
		expect(await screen.findByRole('button', { name: /Download JSON/ })).toBeInTheDocument();
		unmount();
		renderApp(<DangerZone />, { role: 'admin' });
		await screen.findByRole('button', { name: 'Delete my account' });
		expect(screen.queryByRole('button', { name: /Download JSON/ })).toBeNull();
	});
});

describe('Make owner', () => {
	const team = {
		users: [
			{ id: 'u1', email: 'owner@example.com', name: 'Olive', role: 'owner', last_login_at: null, created_at: 1 },
			{ id: 'a1', email: 'adam@example.com', name: 'Adam', role: 'admin', last_login_at: null, created_at: 2 },
		],
		current_user_id: 'u1',
	};

	it('an owner can hand ownership to another member', async () => {
		const { calls } = renderApp(<MembersPage />, { role: 'owner', routes: { 'GET /api/team': team, 'POST /api/workspaces/ws_default/transfer-ownership': { ok: true } } });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Make adam@example.com the owner' }));
		await user.click(screen.getByRole('button', { name: 'Transfer ownership' }));
		await waitFor(() => expect(calls.find((c) => c.path.endsWith('/transfer-ownership'))?.body).toEqual({ user_id: 'a1' }));
		expect(screen.queryByRole('button', { name: 'Make owner@example.com the owner' })).toBeNull();
	});

	it('admins do not get the button', async () => {
		renderApp(<MembersPage />, { role: 'admin', routes: { 'GET /api/team': { ...team, current_user_id: 'a1' } } });
		await screen.findByText('Adam');
		expect(screen.queryByRole('button', { name: /the owner$/ })).toBeNull();
	});
});
