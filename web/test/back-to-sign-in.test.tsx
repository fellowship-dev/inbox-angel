// "Back to sign in" on "Check your email" opens the sign-in form, also when sign-up led there.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { renderApp } from './render';

describe('Back to sign in', () => {
	it('after sign-up, goes to sign-in, not back to "Create an account"', async () => {
		renderApp(<AuthPage initialMode="signup" />, {
			role: null,
			status: { mode: 'saas', signup_open: true, configured: true },
			routes: { 'POST /api/auth/signup': { __status: 201, body: { verification_required: true } } },
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Email'), 'new@example.com');
		await user.click(screen.getByRole('button', { name: 'Create account' }));
		await screen.findByRole('heading', { name: 'Check your email' });
		await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
		expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Create an account' })).toBeNull();
		expect(screen.getByLabelText('Password')).toBeInTheDocument();
	});
});
