import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { renderApp } from './render';

beforeEach(() => localStorage.clear());

const URL_SET = 'https://app.example.net/start';

describe('installer-proof screen and HOSTED_SERVICE_URL', () => {
	it('unset: the setup screen says nothing about a hosted service', async () => {
		renderApp(<AuthPage />, { role: null, status: { configured: false, has_domain: false } });
		expect(await screen.findByLabelText('Installer proof')).toBeInTheDocument();
		expect(screen.queryByText(/hosted/i)).toBeNull();
		expect(screen.queryByRole('link', { name: /hosted free tier/i })).toBeNull();
	});

	it('set: one line with a link opening in a new tab; setup itself is unchanged', async () => {
		renderApp(<AuthPage />, { role: null, status: { configured: false, has_domain: false, hosted_service_url: URL_SET } });
		expect(await screen.findByLabelText('Installer proof')).toBeInTheDocument();
		const link = screen.getByRole('link', { name: 'The hosted free tier' });
		expect(link).toHaveAttribute('href', URL_SET);
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
		expect(screen.getByText(/a self-hosted installation keeps every feature/)).toBeInTheDocument();
		expect(screen.getAllByRole('link', { name: /hosted/i })).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
	});

	it('set: never shown on the sign-in screen of a configured installation', async () => {
		renderApp(<AuthPage />, { role: null, status: { configured: true, hosted_service_url: URL_SET } });
		expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
		expect(screen.queryByText(/hosted/i)).toBeNull();
	});

	it('a non-https value renders nothing', async () => {
		renderApp(<AuthPage />, { role: null, status: { configured: false, has_domain: false, hosted_service_url: 'javascript:alert(1)' } });
		expect(await screen.findByLabelText('Installer proof')).toBeInTheDocument();
		expect(screen.queryByText(/hosted/i)).toBeNull();
	});
});
