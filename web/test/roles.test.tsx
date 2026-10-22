import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { WriteButton } from '../src/components/states';
import { READ_ONLY_REASON } from '../src/lib/session';
import { TeamPage } from '../src/pages/team/TeamPage';
import { fail, renderApp } from './render';

const team = (currentId: string) => ({
	users: [
		{ id: 'o1', email: 'owner@example.com', name: 'Olive', role: 'owner', last_login_at: 1_700_000_000, created_at: 1_690_000_000 },
		{ id: 'a1', email: 'admin@example.com', name: 'Adam', role: 'admin', last_login_at: null, created_at: 1_690_000_001 },
		{ id: 'm1', email: 'member@example.com', name: 'Mo', role: 'member', last_login_at: null, created_at: 1_690_000_002 },
	],
	current_user_id: currentId,
});

describe('WriteButton', () => {
	function Demo({ onClick }: { onClick: () => void }) {
		return <WriteButton onClick={onClick}>Apply record</WriteButton>;
	}

	it('is enabled for owners and admins', async () => {
		for (const role of ['owner', 'admin'] as const) {
			let clicked = 0;
			const { unmount } = renderApp(<Demo onClick={() => clicked++} />, { role });
			const button = await screen.findByRole('button', { name: 'Apply record' });
			await userEvent.click(button);
			expect(clicked).toBe(1);
			unmount();
		}
	});

	it('is disabled for members, with the reason as its description', async () => {
		let clicked = 0;
		renderApp(<Demo onClick={() => clicked++} />, { role: 'member' });
		const button = await screen.findByRole('button', { name: 'Apply record' });
		expect(button).toBeDisabled();
		expect(button).toHaveAccessibleDescription(READ_ONLY_REASON);
		await userEvent.click(button);
		expect(clicked).toBe(0);
	});
});

describe('Team page', () => {
	it('lets an owner invite and remove, but not remove themselves or the owner', async () => {
		renderApp(<TeamPage />, { role: 'owner', routes: { 'GET /api/team': team('o1') } });
		expect(await screen.findByText('Adam')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create invite link' })).toBeEnabled();
		expect(screen.getByRole('button', { name: 'Remove admin@example.com' })).toBeEnabled();
		expect(screen.getByRole('button', { name: 'Remove member@example.com' })).toBeEnabled();
		expect(screen.getByRole('button', { name: 'Remove owner@example.com' })).toBeDisabled(); // self and owner
	});

	it('lets an admin remove members but not other admins or the owner', async () => {
		renderApp(<TeamPage />, { role: 'admin', routes: { 'GET /api/team': team('a1') } });
		await screen.findByText('Mo');
		expect(screen.getByRole('button', { name: 'Remove member@example.com' })).toBeEnabled();
		expect(screen.getByRole('button', { name: 'Remove owner@example.com' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Remove admin@example.com' })).toBeDisabled(); // yourself
	});

	it('shows members an explanation and never asks the API for the list', async () => {
		const { calls } = renderApp(<TeamPage />, { role: 'member', routes: { 'GET /api/team': fail(403, 'admin required') } });
		expect(await screen.findByText('Only owners and admins can see the team')).toBeInTheDocument();
		expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/team')).toBe(false);
	});

	it('creates an invite link with the chosen role', async () => {
		const { calls } = renderApp(<TeamPage />, { role: 'owner', routes: { 'GET /api/team': team('o1'), 'POST /api/team/invite': { token: 'tok-abc' } } });
		const user = userEvent.setup();
		await screen.findByText('Adam');
		await user.type(screen.getByLabelText('Email'), 'new@example.com');
		await user.click(screen.getByRole('button', { name: 'Create invite link' }));
		expect(await screen.findByTestId('invite-link')).toHaveTextContent('/#/invite/tok-abc');
		expect(calls.find((c) => c.path === '/api/team/invite')?.body).toEqual({ email: 'new@example.com', role: 'member' });
	});

	it('names the conflict when the person already has an account', async () => {
		renderApp(<TeamPage />, { role: 'owner', routes: { 'GET /api/team': team('o1'), 'POST /api/team/invite': fail(409, 'a user with this email already exists') } });
		const user = userEvent.setup();
		await screen.findByText('Adam');
		await user.type(screen.getByLabelText('Email'), 'adam@example.com');
		await user.click(screen.getByRole('button', { name: 'Create invite link' }));
		expect(await screen.findByText('Someone with this email already has an account.')).toBeInTheDocument();
	});
});
