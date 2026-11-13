import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CreateWorkspaceDialog } from '../src/components/CreateWorkspaceDialog';
import { ClaimCard } from '../src/components/domain/ClaimCard';
import { PlanLimitNotice, planLimitOf } from '../src/components/PlanLimitNotice';
import { ApiError } from '../src/lib/api';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import { BulkImportPage } from '../src/pages/domains/BulkImportPage';
import { DomainStep } from '../src/pages/wizards/setup/DomainStep';
import { fail, renderApp } from './render';

const BOOKING = 'https://cal.example.com/max';
const DOMAINS = 'This workspace has reached its limit of 10 domains.';
const WORKSPACES = 'You have reached the limit of 5 workspaces you can own.';

const limit = (kind: 'domains_per_workspace' | 'workspaces_per_user', help_url: string | null) => ({
	__status: 403,
	body: { error: kind === 'domains_per_workspace' ? DOMAINS : WORKSPACES, code: 'plan_limit', limit: { kind, max: kind === 'domains_per_workspace' ? 10 : 5 }, help_url },
});

describe('planLimitOf', () => {
	it('reads the server body of a plan_limit error', () => {
		const err = new ApiError(403, DOMAINS, { code: 'plan_limit', limit: { kind: 'domains_per_workspace', max: 10 }, help_url: BOOKING });
		expect(planLimitOf(err)).toEqual({ kind: 'domains_per_workspace', message: DOMAINS, help_url: BOOKING });
		expect(planLimitOf(new ApiError(403, WORKSPACES, { code: 'plan_limit', limit: { kind: 'workspaces_per_user', max: 5 }, help_url: null }))).toEqual({ kind: 'workspaces_per_user', message: WORKSPACES, help_url: null });
	});

	it('is null for everything else', () => {
		expect(planLimitOf(new ApiError(403, "You don't have permission to do that."))).toBeNull();
		expect(planLimitOf(new ApiError(403, 'x', { code: 'other' }))).toBeNull();
		expect(planLimitOf(new ApiError(429, 'x', { code: 'rate_limited' }))).toBeNull();
		expect(planLimitOf(new Error('plan_limit'))).toBeNull();
		expect(planLimitOf(null)).toBeNull();
		expect(planLimitOf(undefined)).toBeNull();
	});
});

describe('PlanLimitNotice', () => {
	it('domains with a help link: the sentence, then "Managing more domains? Talk to Max"', () => {
		render(<PlanLimitNotice limit={{ kind: 'domains_per_workspace', message: DOMAINS, help_url: BOOKING }} />);
		const notice = screen.getByRole('status');
		expect(notice).toHaveTextContent(DOMAINS);
		expect(notice).toHaveTextContent('Managing more domains? Talk to Max');
		const link = screen.getByRole('link', { name: 'Talk to Max' });
		expect(link).toHaveAttribute('href', BOOKING);
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', 'noopener noreferrer');
	});

	it('workspaces with a help link: "Need more workspaces? Talk to Max"', () => {
		render(<PlanLimitNotice limit={{ kind: 'workspaces_per_user', message: WORKSPACES, help_url: BOOKING }} />);
		expect(screen.getByRole('status')).toHaveTextContent('Need more workspaces? Talk to Max');
	});

	it('without a help link, says what to do instead', () => {
		const { unmount } = render(<PlanLimitNotice limit={{ kind: 'domains_per_workspace', message: DOMAINS, help_url: null }} />);
		expect(screen.getByText('Remove a domain you no longer need to add another.')).toBeInTheDocument();
		expect(screen.queryByRole('link')).toBeNull();
		unmount();
		render(<PlanLimitNotice limit={{ kind: 'workspaces_per_user', message: WORKSPACES, help_url: null }} />);
		expect(screen.getByText('Delete a workspace you no longer use to make room for a new one.')).toBeInTheDocument();
		expect(screen.queryByRole('link')).toBeNull();
	});

	it.each(['http://cal.example.com/max', 'javascript:alert(1)', 'HTTPS://cal.example.com', '//cal.example.com', '/relative', 'data:text/html,x'])('renders no link for %s', (url) => {
		render(<PlanLimitNotice limit={{ kind: 'domains_per_workspace', message: DOMAINS, help_url: url }} />);
		expect(screen.queryByRole('link')).toBeNull();
		expect(screen.getByText('Remove a domain you no longer need to add another.')).toBeInTheDocument();
	});

	it('is information, not an error alert', () => {
		render(<PlanLimitNotice limit={{ kind: 'domains_per_workspace', message: DOMAINS, help_url: null }} />);
		expect(screen.queryByRole('alert')).toBeNull();
	});
});

describe('where a plan limit can appear', () => {
	it('AddDomainPage: a notice, not a field error', async () => {
		renderApp(<AddDomainPage />, { routes: { 'GET /api/zones': fail(400), 'POST /api/domains': limit('domains_per_workspace', BOOKING) } });
		await userEvent.type(await screen.findByLabelText('Your domain'), 'new.example.org');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText(DOMAINS)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Talk to Max' })).toHaveAttribute('href', BOOKING);
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.getByLabelText('Your domain')).not.toHaveAttribute('aria-invalid', 'true');
	});

	it('AddDomainPage: other errors stay field errors', async () => {
		renderApp(<AddDomainPage />, { routes: { 'GET /api/zones': fail(400), 'POST /api/domains': fail(409) } });
		await userEvent.type(await screen.findByLabelText('Your domain'), 'dup.com');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('Already exists.')).toBeInTheDocument();
		expect(screen.queryByText('Talk to Max')).toBeNull();
	});

	it('DomainStep', async () => {
		renderApp(<DomainStep onDomainSet={() => {}} />, { routes: { 'GET /api/zones': fail(400), 'POST /api/settings/base-domain': limit('domains_per_workspace', null) } });
		await userEvent.type(await screen.findByLabelText('Main domain'), 'new.example.org');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText(DOMAINS)).toBeInTheDocument();
		expect(screen.getByText('Remove a domain you no longer need to add another.')).toBeInTheDocument();
	});

	it('ClaimCard: verifying at the limit', async () => {
		const claim = { id: 4, domain: 'acme.io', status: 'pending' as const, txt_name: '_inboxangel.acme.io', txt_value: 'inboxangel-verify=abc', created_at: 1, last_checked_at: null, last_error: null };
		renderApp(<ClaimCard claim={claim} />, { routes: { 'POST /api/domains/claims/4/verify': limit('domains_per_workspace', BOOKING) } });
		await userEvent.click(await screen.findByRole('button', { name: 'Verify' }));
		expect(await screen.findByText(DOMAINS)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Talk to Max' })).toHaveAttribute('href', BOOKING);
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('BulkImportPage: one notice above the results when any row hit the limit', async () => {
		renderApp(<BulkImportPage />, {
			routes: {
				'POST /api/domains/bulk-import': {
					imported: 1,
					total: 3,
					results: [
						{ domain: 'a.com', status: 'imported' },
						{ domain: 'b.com', status: 'error', code: 'plan_limit', error: DOMAINS, help_url: BOOKING },
						{ domain: 'c.com', status: 'error', code: 'plan_limit', error: DOMAINS, help_url: BOOKING },
					],
				},
			},
		});
		await userEvent.type(await screen.findByLabelText('Domains'), 'a.com\nb.com\nc.com');
		await userEvent.click(screen.getByRole('button', { name: 'Import domains' }));
		await screen.findByTestId('import-results');
		expect(screen.getAllByRole('link', { name: 'Talk to Max' })).toHaveLength(1);
		expect(screen.getByRole('status')).toHaveTextContent(DOMAINS);
	});

	it('BulkImportPage: no notice when no row hit the limit; a non-https help_url shows no link', async () => {
		renderApp(<BulkImportPage />, { routes: { 'POST /api/domains/bulk-import': { imported: 0, total: 1, results: [{ domain: 'b.com', status: 'error', error: 'boom' }] } } });
		await userEvent.type(await screen.findByLabelText('Domains'), 'b.com');
		await userEvent.click(screen.getByRole('button', { name: 'Import domains' }));
		await screen.findByTestId('import-results');
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('BulkImportPage: a non-https help_url renders no link', async () => {
		renderApp(<BulkImportPage />, { routes: { 'POST /api/domains/bulk-import': { imported: 0, total: 1, results: [{ domain: 'b.com', status: 'error', code: 'plan_limit', error: DOMAINS, help_url: 'http://cal.example.com' }] } } });
		await userEvent.type(await screen.findByLabelText('Domains'), 'b.com');
		await userEvent.click(screen.getByRole('button', { name: 'Import domains' }));
		await screen.findByTestId('import-results');
		expect(screen.queryByRole('link', { name: 'Talk to Max' })).toBeNull();
		expect(screen.getByText('Remove a domain you no longer need to add another.')).toBeInTheDocument();
	});

	it('CreateWorkspaceDialog: workspaces wording', async () => {
		renderApp(<CreateWorkspaceDialog open onOpenChange={() => {}} />, { routes: { 'POST /api/workspaces': limit('workspaces_per_user', BOOKING) } });
		await userEvent.type(await screen.findByLabelText('Workspace name'), 'Another');
		await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
		expect(await screen.findByText(WORKSPACES)).toBeInTheDocument();
		expect(screen.getByText(/Need more workspaces\?/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Talk to Max' })).toHaveAttribute('href', BOOKING);
	});

	it('CreateWorkspaceDialog: without a help link', async () => {
		renderApp(<CreateWorkspaceDialog open onOpenChange={() => {}} />, { routes: { 'POST /api/workspaces': limit('workspaces_per_user', null) } });
		await userEvent.type(await screen.findByLabelText('Workspace name'), 'Another');
		await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
		expect(await screen.findByText('Delete a workspace you no longer use to make room for a new one.')).toBeInTheDocument();
	});
});
