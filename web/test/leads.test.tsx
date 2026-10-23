import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeadsPage } from '../src/pages/leads/LeadsPage';
import { fail, renderApp } from './render';

const lead = (id: number, over: Record<string, unknown> = {}) => ({
	id, email: `lead${id}@acme.com`, domain: `acme${id}.com`, source: 'free_check', level: 'exposed', step: 2, steps_total: 5, status: 'active',
	next_send_at: 1_760_000_000, last_sent_at: null, created_at: 1_759_000_000, last_activity_at: 1_759_000_000, ...over,
});
const delivery = (over: Record<string, unknown> = {}) => ({ enabled: true, can_send: true, provider: 'resend', blockers: [], warnings: [], ...over });

describe('LeadsPage', () => {
	it('lists leads with domain, level and place in the sequence', async () => {
		renderApp(<LeadsPage />, { routes: { 'GET /api/leads': { leads: [lead(1), lead(2, { status: 'bounced', level: 'protected' })], counts: { active: 1, bounced: 1 }, delivery: delivery() } } });
		expect(await screen.findByText('acme1.com')).toBeInTheDocument();
		expect(screen.getByText('Step 2 of 5')).toBeInTheDocument();
		expect(screen.getByText('Exposed')).toBeInTheDocument();
		expect(screen.getByText('Bounced')).toBeInTheDocument();
		expect(screen.queryByText('Emails are queued, not sent')).not.toBeInTheDocument();
	});

	it('says why emails are queued instead of sent', async () => {
		renderApp(<LeadsPage />, { routes: { 'GET /api/leads': { leads: [lead(1)], counts: { active: 1 }, delivery: delivery({ can_send: false, provider: null, blockers: ['No mail provider is configured (set RESEND_API_KEY)'], warnings: ['BOOKING_URL is not set'] }) } } });
		expect(await screen.findByText('Emails are queued, not sent')).toBeInTheDocument();
		expect(screen.getByText(/No mail provider is configured/)).toBeInTheDocument();
		expect(screen.getByText(/BOOKING_URL is not set/)).toBeInTheDocument();
	});

	it('says when the sequence is off', async () => {
		renderApp(<LeadsPage />, { routes: { 'GET /api/leads': { leads: [], counts: {}, delivery: delivery({ enabled: false, can_send: false, blockers: ['The sequence is off (self-host: set ONBOARDING_SEQUENCE_ENABLED=1)'] }) } } });
		expect(await screen.findByText('The onboarding sequence is off')).toBeInTheDocument();
		expect(screen.getByText('No leads yet')).toBeInTheDocument();
	});

	it('explains a 403 for anyone but the instance owner', async () => {
		renderApp(<LeadsPage />, { role: 'admin', routes: { 'GET /api/leads': fail(403, 'instance owner only') } });
		expect(await screen.findByText('Only the instance owner can see leads')).toBeInTheDocument();
	});
});
