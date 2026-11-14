import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { ClaimCard } from '../src/components/domain/ClaimCard';
import { createQueryClient } from '../src/lib/query';
import { dmarcAdvice } from '../src/lib/reports';
import type { AuthStatus, OnboardingStatus, WizardState } from '../src/lib/types';
import { AuthPage } from '../src/pages/auth/AuthPage';
import { CheckEmail } from '../src/pages/auth/CheckEmail';
import { AnalyticsPage } from '../src/pages/analytics/AnalyticsPage';
import { OverviewPage } from '../src/pages/domains/OverviewPage';
import { AnomaliesPage } from '../src/pages/reports/AnomaliesPage';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { fail, me, mockApi, renderApp, STATUS } from './render';

const BOOKING = 'https://cal.example.com/max/30min';
const HOSTED: Partial<AuthStatus> = { mode: 'saas', signup_open: true, configured: true, base_domain: null, help_url: BOOKING };
const HOSTED_NO_LINK: Partial<AuthStatus> = { ...HOSTED, help_url: null };

const talkLinks = () => screen.queryAllByRole('link', { name: /Talk to Max/ });

function expectSafeTalkLink(link: HTMLElement) {
	expect(link).toHaveAttribute('href', BOOKING);
	expect(link).toHaveAttribute('target', '_blank');
	expect(link.getAttribute('rel')).toContain('noopener');
	expect(link.getAttribute('rel')).toContain('noreferrer');
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

describe('Talk to Max: always visible when the booking link is set, absent otherwise', () => {
	const at = (route: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
	function boot(status: Partial<AuthStatus>) {
		mockApi({
			'GET /api/auth/status': { ...STATUS, ...status },
			'GET /api/me': me('owner'),
			'GET /api/keys': { keys: [] },
			'GET /api/version': { current: '1.2.0', latest: '1.2.0', update_available: false, release_url: '' },
			'GET /api/mcp/connections': { connections: [] },
			'GET /api/access': { products: [], principals: [], credentials: [], grants: [] },
			'GET /api/resources': { domains: [] },
			'GET /api/metrics/google/connections': { configured: false, connections: [] },
			'GET /api/workspaces': { workspaces: [] },
		});
		render(<App queryClient={createQueryClient()} Router={at('/keys')} />);
	}

	it('hosted with a booking link: one link in the app top bar, opening in a new tab with a safe rel', async () => {
		boot(HOSTED);
		await screen.findByRole('navigation', { name: 'Main' });
		const banner = screen.getAllByRole('banner')[0]!;
		const link = await within(banner).findByRole('link', { name: /Talk to Max/ });
		expectSafeTalkLink(link);
	});

	it('hosted without a booking link: no link, no disabled control, no "coming soon"', async () => {
		boot(HOSTED_NO_LINK);
		await screen.findByRole('navigation', { name: 'Main' });
		await screen.findByRole('heading', { name: 'Settings', level: 1 });
		expect(talkLinks()).toHaveLength(0);
		expect(screen.queryByText(/Talk to Max|coming soon/i)).not.toBeInTheDocument();
	});

	it('self-host: no link (the server never sends one there)', async () => {
		boot({});
		await screen.findByRole('heading', { name: 'Settings', level: 1 });
		expect(talkLinks()).toHaveLength(0);
	});

	it('ignores a link that is not https', async () => {
		boot({ ...HOSTED, help_url: 'http://cal.example.com/max' });
		await screen.findByRole('heading', { name: 'Settings', level: 1 });
		expect(talkLinks()).toHaveLength(0);
	});
});

describe('hosted sign-in, sign-up and check-your-email', () => {
	it('sign-in has no contextual line; sign-up offers Talk to Max and says what works and what is not connected', async () => {
		renderApp(<AuthPage />, { role: null, status: HOSTED });
		await screen.findByRole('button', { name: 'Sign in' });
		expect(talkLinks()).toHaveLength(0);
		await userEvent.setup().click(screen.getByRole('button', { name: 'Create an account' }));
		expect(await screen.findByText(/checked from live DNS\. DMARC reports are not connected yet\./)).toBeInTheDocument();
		expect(screen.getByText('Used to sign in.')).toBeInTheDocument();
		expectSafeTalkLink(screen.getByRole('link', { name: /Talk to Max/ }));
	});

	it('never asks a hosted registrant for an installer proof, even if the status said "not configured"', async () => {
		renderApp(<AuthPage />, { role: null, status: { ...HOSTED, configured: false } });
		await screen.findByRole('button', { name: 'Sign in' });
		expect(screen.queryByLabelText('Installer proof')).not.toBeInTheDocument();
	});

	it('self-host first run still asks for the installer proof and shows no Talk to Max', async () => {
		renderApp(<AuthPage />, { role: null, status: { configured: false } });
		expect(await screen.findByLabelText('Installer proof')).toBeInTheDocument();
		expect(talkLinks()).toHaveLength(0);
	});

	it('check-your-email offers Talk to Max, and nothing without a link', async () => {
		const { unmount } = renderApp(<CheckEmail email="a@example.com" />, { role: null, status: HOSTED });
		expectSafeTalkLink(await screen.findByRole('link', { name: /Talk to Max/ }));
		unmount();
		renderApp(<CheckEmail email="a@example.com" />, { role: null, status: HOSTED_NO_LINK });
		await screen.findByRole('button', { name: 'Resend verification email' });
		expect(talkLinks()).toHaveLength(0);
	});
});

const claim = (over = {}) => ({ id: 5, domain: 'acme.com', status: 'pending' as const, txt_name: '_readysetmail.acme.com', txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null, ...over });

describe('domain claim card', () => {
	it('claimed elsewhere: Talk to Max replaces "contact support"', async () => {
		renderApp(<ClaimCard claim={claim({ status: 'lost' })} />, { status: HOSTED });
		expectSafeTalkLink(await screen.findByRole('link', { name: /Talk to Max/ }));
		expect(screen.queryByText(/contact support/)).not.toBeInTheDocument();
	});

	it('claimed elsewhere without a booking link: no dead link', async () => {
		renderApp(<ClaimCard claim={claim({ status: 'lost' })} />, { status: HOSTED_NO_LINK });
		expect(await screen.findByText(/Another workspace verified this domain first/)).toBeInTheDocument();
		expect(talkLinks()).toHaveLength(0);
	});

	it('offers a person after the second failed Verify, not the first', async () => {
		renderApp(<ClaimCard claim={claim()} />, { status: HOSTED, routes: { 'POST /api/domains/claims/5/verify': fail(422, 'TXT record not found yet.') } });
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Verify' }));
		expect(await screen.findByText('TXT record not found yet.')).toBeInTheDocument();
		expect(talkLinks()).toHaveLength(0);
		await user.click(screen.getByRole('button', { name: 'Verify' }));
		expectSafeTalkLink(await screen.findByRole('link', { name: /Talk to Max/ }));
	});
});

// ── D4: the hosted setup wizard ─────────────────────────────────────────────────────────

const onboarding = (over: Partial<OnboardingStatus> = {}): OnboardingStatus => ({
	domain_id: 7,
	domain: 'acme.com',
	rua_address: '',
	cf_available: false,
	dmarc: { found: false, has_our_rua: false, current_record: null, auth_record: { found: false, record_name: null }, effective: { policy: null, inherited_from: null, issue: null } },
	spf: { record: 'v=spf1 include:_spf.google.com ~all', lookup_count: 2, flattening_active: false },
	dkim: { selectors: [], source: 'doh' },
	routing: { mx_found: false, destination_verified: false, reports_domain: null, admin_email: 'owner@acme.com', null_sender_spf: false, null_sender_dmarc: false },
	...over,
});
const wizard = (over: Partial<WizardState> = {}): WizardState => ({ domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'not_started', ...over });
const hostedDomain = { id: 7, domain: 'acme.com', dmarc_policy: null, rua_address: '', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 0 };

function wizardAt(step: number, status: Partial<AuthStatus>, ob: OnboardingStatus = onboarding()) {
	return renderApp(
		<Routes>
			<Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} />
			<Route path="/domains/:id" element={<p>Domain page</p>} />
		</Routes>,
		{
			route: `/domains/7/setup/${step}`,
			status,
			routes: {
				'GET /api/domains': { domains: [hostedDomain] },
				'GET /api/domains/7/onboarding-status': ob,
				'GET /api/domains/7/wizard-state': wizard(),
				'PUT /api/domains/7/wizard-state': {},
			},
		},
	);
}

describe('hosted setup wizard', () => {
	it('step 5 is "Reports", says reports are not connected, and calls no self-host-only route', async () => {
		const { calls } = wizardAt(5, HOSTED);
		expect(await screen.findByRole('heading', { name: 'DMARC reports' })).toBeInTheDocument();
		expect(screen.getByText('Not connected')).toBeInTheDocument();
		expect(screen.getByText('Reports not connected yet')).toBeInTheDocument();
		// One count: hosted progress is out of four, and the Reports page carries no "Step 5 of 5" marker.
		expect(screen.queryByRole('navigation', { name: 'Setup progress' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Set up email routing|Register email destination/ })).not.toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/reports\.acme\.com|rua@reports/);
		expectSafeTalkLink(screen.getAllByRole('link', { name: /Talk to Max/ })[0]!);
		// Not counted and not ticked: progress is out of four, and leaving the step saves nothing.
		expect(screen.getByText('4 of 4 steps complete')).toBeInTheDocument();
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: 'Go to dashboard' }));
		expect(await screen.findByText('Domain page')).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/setup/email-routing' || c.path === '/api/settings/register-destination')).toBe(false);
		expect(calls.some((c) => c.method === 'PUT' && c.body && 'routing' in c.body)).toBe(false);
	});

	it('self-host step 5 is still Routing', async () => {
		wizardAt(5, {}, onboarding({ rua_address: 'rua@reports.acme.com', routing: { mx_found: true, destination_verified: true, reports_domain: 'reports.acme.com', admin_email: 'o@acme.com', null_sender_spf: true, null_sender_dmarc: true } }));
		expect(await screen.findByRole('heading', { name: 'Reports routing' })).toBeInTheDocument();
		expect(screen.getByRole('navigation', { name: 'Setup progress' })).toHaveTextContent('Step 5 of 5: Routing');
	});

	it('DMARC step, no record: offers a plain p=none record with no rua= and no reports-subdomain advice', async () => {
		wizardAt(4, HOSTED);
		expect(await screen.findByRole('heading', { name: 'DMARC policy' })).toBeInTheDocument();
		expect(screen.getAllByText('v=DMARC1; p=none').length).toBeGreaterThan(0);
		expect(screen.getByText('Reports not connected yet')).toBeInTheDocument();
		expect(screen.queryByText('Report address not configured yet')).not.toBeInTheDocument();
		expect(screen.queryByText(/Set one up in Routing/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Reports are configured|start arriving/)).not.toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/rua=mailto|reports\.acme\.com/);
	});

	it('DMARC step, record published: a note, never "Reports are configured"', async () => {
		wizardAt(4, HOSTED, onboarding({ dmarc: { found: true, has_our_rua: false, current_record: 'v=DMARC1; p=quarantine', auth_record: { found: false, record_name: null } } }));
		expect(await screen.findByText('Your DMARC record is published, read from public DNS.')).toBeInTheDocument();
		expect(screen.queryByText('Reports are configured')).not.toBeInTheDocument();
		expect(screen.queryByText('Recommended record')).not.toBeInTheDocument();
	});

	it('offers a person when a DNS lookup failed', async () => {
		wizardAt(2, HOSTED, onboarding({ dns_errors: ['spf: timeout'] }));
		expect(await screen.findByText(/DNS lookups still failing after a retry\?/)).toBeInTheDocument();
	});
});

// ── D4: report views say "Reports not connected yet" instead of empty data ─────────────

function hostedPage(el: ReactElement, path: string, route: string, routes: Record<string, unknown> = {}, status: Partial<AuthStatus> = HOSTED) {
	return renderApp(
		<Routes>
			<Route path={path} element={el} />
		</Routes>,
		{ route, status, routes: { 'GET /api/domains': { domains: [hostedDomain] }, ...routes } },
	);
}

describe('hosted report views', () => {
	it('anomalies: never "Nothing to fix" without reports', async () => {
		hostedPage(<AnomaliesPage />, '/domains/:id/anomalies', '/domains/7/anomalies', { 'GET /api/domains/7/anomalies': { days: 30, domain: 'acme.com', anomalies: [] } });
		expect(await screen.findByText('Reports not connected yet')).toBeInTheDocument();
		expect(screen.queryByText(/Nothing to fix|All sending sources are passing/)).not.toBeInTheDocument();
	});

	it('analytics: no zero stats, the reason instead', async () => {
		hostedPage(<AnalyticsPage />, '/analytics', '/analytics', { 'GET /api/analytics?days=30': fail(500) });
		expect(await screen.findByText('Reports not connected yet')).toBeInTheDocument();
		expect(screen.getByText(/Still checked from live DNS/)).toBeInTheDocument();
		expect(screen.queryByText('Pass rate')).not.toBeInTheDocument();
	});

	it('self-host anomalies with a report address keep the existing all-clear', async () => {
		hostedPage(<AnomaliesPage />, '/domains/:id/anomalies', '/domains/7/anomalies', { 'GET /api/domains': { domains: [{ ...hostedDomain, rua_address: 'rua@reports.acme.com' }] }, 'GET /api/domains/7/anomalies': { days: 30, domain: 'acme.com', anomalies: [] } }, {});
		expect(await screen.findByText('No anomalies in the last 30 days')).toBeInTheDocument();
		expect(screen.queryByText('Reports not connected yet')).not.toBeInTheDocument();
	});

	it('overview, empty hosted workspace: no "Connect Cloudflare", no report promise', async () => {
		renderApp(<OverviewPage />, { status: HOSTED, routes: { 'GET /api/domains': { domains: [] } } });
		expect(await screen.findByText('No domains yet')).toBeInTheDocument();
		expect(screen.getByText(/checked from live DNS/)).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: 'Connect Cloudflare' })).not.toBeInTheDocument();
		expect(screen.queryByText(/receiving DMARC reports/)).not.toBeInTheDocument();
	});

	it('overview, self-host empty: unchanged', async () => {
		renderApp(<OverviewPage />, { routes: { 'GET /api/domains': { domains: [] } } });
		expect(await screen.findByRole('link', { name: 'Connect Cloudflare' })).toBeInTheDocument();
	});
});

describe('dmarcAdvice', () => {
	it('hosted never suggests rua@reports.<domain>', () => {
		expect(dmarcAdvice(null, null, null, { hosted: true })).not.toMatch(/rua=|reports\./);
		expect(dmarcAdvice(null, null, null, { hosted: true })).toContain('v=DMARC1; p=none');
	});
	it('self-host keeps its example', () => {
		expect(dmarcAdvice(null, null, null)).toContain('rua=mailto:rua@reports.yourdomain.com');
	});
});


// ── Overview cards: the stuck states from the DNS refresh (a check that keeps failing, a name that does not resolve) ──

describe('overview level cards: Talk to Max at stuck states', () => {
	const hoursAgo = (h: number) => Math.floor(Date.now() / 1000) - h * 3600;
	const summary = (extra = {}) => ({ domain_id: 7, domain: 'acme.com', dmarc_policy: null, spf_record: null, total_messages: 0, pass_messages: 0, fail_messages: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, dns_checked_at: hoursAgo(3), dns_check_attempted_at: hoursAgo(3), dns_check_status: 'ok', ...extra });
	const overview = (sum: unknown, status: Partial<AuthStatus> = HOSTED) =>
		renderApp(<OverviewPage />, {
			status,
			routes: {
				'GET /api/domains': { domains: [hostedDomain] },
				'GET /api/domains/7/check-summary': sum,
				'GET /api/domains/7/stats': { domain: 'acme.com', days: 7, stats: [] },
				'GET /api/domains/7/wizard-state': wizard({ spf: 'not_started', dkim: 'not_started', dmarc: 'not_started' }),
				'GET /api/hosted/config': { enabled: false },
			},
		});

	it('a domain that does not resolve offers a person', async () => {
		overview(summary({ dns_check_status: 'nxdomain' }));
		const card = await screen.findByRole('group', { name: 'acme.com' });
		expect(within(card).getByText('This domain does not resolve')).toBeInTheDocument();
		expectSafeTalkLink(within(card).getByRole('link', { name: /Talk to Max/ }));
	});

	it('a check that keeps failing offers a person, and the card does not lean on reports', async () => {
		overview(summary({ dns_checked_at: hoursAgo(72), dns_check_attempted_at: hoursAgo(1), dns_check_status: 'failed', dns_last_good_status: 'ok' }));
		const card = await screen.findByRole('group', { name: /Level \d/ });
		expect(within(card).getByText(/Last check failed 1 hour ago/)).toBeInTheDocument();
		expect(within(card).getByText(/DNS checks keep failing\?/)).toBeInTheDocument();
		// The block above the cards says reports are not connected; the card does not repeat it or claim "no reports".
		expect(within(card).queryByText(/7-day results|No reports in the last 7 days/)).not.toBeInTheDocument();
		expect(within(card).queryByText(/reports look clean|start receiving reports|Review your reports/)).not.toBeInTheDocument();
	});

	it('a summary that cannot load offers a person', async () => {
		overview(fail(404, 'summary unavailable')); // 4xx: the query client does not retry, so the error card shows at once
		const card = await screen.findByRole('group', { name: 'acme.com' });
		expectSafeTalkLink(await within(card).findByRole('link', { name: /Talk to Max/ }));
	});

	it('no booking link: the same states show no link', async () => {
		overview(summary({ dns_check_status: 'nxdomain' }), HOSTED_NO_LINK);
		const card = await screen.findByRole('group', { name: 'acme.com' });
		expect(within(card).getByText('This domain does not resolve')).toBeInTheDocument();
		expect(talkLinks()).toHaveLength(0);
	});
});
