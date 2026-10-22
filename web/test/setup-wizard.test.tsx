import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { OnboardingStatus, WizardState } from '../src/lib/types';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { fail, renderApp, type Handler } from './render';

function Where() {
	return <p data-testid="where">{useLocation().pathname}</p>;
}

function Wizard() {
	return (
		<>
			<Routes>
				<Route path="/setup" element={<SetupWizardPage />} />
				<Route path="/domains/:id/setup" element={<SetupWizardPage />} />
				<Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} />
				<Route path="/domains/:id" element={<p>Domain page</p>} />
			</Routes>
			<Where />
		</>
	);
}

const domain = { id: 7, domain: 'example.com', dmarc_policy: 'none', rua_address: 'r@reports.example.com', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 1 };

const status = (over: Partial<OnboardingStatus> = {}): OnboardingStatus => ({
	domain_id: 7,
	domain: 'example.com',
	rua_address: 'r@reports.example.com',
	cf_available: true,
	dmarc: { found: true, has_our_rua: true, current_record: 'v=DMARC1; p=none; rua=mailto:r@reports.example.com', rua_address: 'r@reports.example.com' },
	spf: { record: 'v=spf1 include:_spf.google.com ~all', lookup_count: 2, flattening_active: false },
	dkim: { selectors: [], source: 'doh' },
	routing: { mx_found: true, destination_verified: true, reports_domain: 'reports.example.com', admin_email: 'owner@example.com', null_sender_spf: true, null_sender_dmarc: true },
	...over,
});

const wizard = (over: Partial<WizardState> = {}): WizardState => ({ domain: 'complete', spf: 'not_started', dkim: 'not_started', dmarc: 'not_started', routing: 'not_started', ...over });

function routes(opts: { status?: OnboardingStatus | Handler; wizard?: WizardState; domains?: unknown[]; extra?: Record<string, unknown | Handler> } = {}) {
	return {
		'GET /api/domains': { domains: opts.domains ?? [domain] },
		'GET /api/domains/7/onboarding-status': opts.status ?? status(),
		'GET /api/domains/7/wizard-state': opts.wizard ?? wizard(),
		'PUT /api/domains/7/wizard-state': {},
		'GET /api/zones': { zones: [] },
		...opts.extra,
	};
}

const where = () => screen.getByTestId('where').textContent;
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });

describe('setup wizard entry and resume', () => {
	it('shows the domain step when the instance has no domain', async () => {
		renderApp(<Wizard />, { route: '/setup', routes: routes({ domains: [] }) });
		expect(await heading("What's your main domain?")).toBeInTheDocument();
		expect(screen.getByText(/Step 1 of 5/)).toBeInTheDocument();
		expect(where()).toBe('/setup');
	});

	it('redirects to the first domain when one exists, then to the SPF step', async () => {
		renderApp(<Wizard />, { route: '/setup' + '', routes: routes({ domains: [{ ...domain, id: 7 }, { ...domain, id: 8, domain: 'b.com' }] }) });
		expect(await heading('SPF record')).toBeInTheDocument();
		expect(where()).toBe('/domains/7/setup/2');
	});

	it('resumes at the first step that is still not started', async () => {
		renderApp(<Wizard />, { route: '/domains/7/setup', routes: routes({ wizard: wizard({ spf: 'complete', dkim: 'skipped' }) }) });
		expect(await heading('DMARC policy')).toBeInTheDocument();
		expect(where()).toBe('/domains/7/setup/4');
	});

	it('clamps step 1 to a later step because the domain already exists', async () => {
		renderApp(<Wizard />, { route: '/domains/7/setup/1', routes: routes() });
		expect(await heading('SPF record')).toBeInTheDocument();
		expect(where()).toBe('/domains/7/setup/2');
	});

	it('keeps an explicit step and marks the domain step complete', async () => {
		const { calls } = renderApp(<Wizard />, { route: '/domains/7/setup/3', routes: routes({ wizard: wizard({ domain: 'not_started' }) }) });
		expect(await heading('DKIM signing')).toBeInTheDocument();
		expect(where()).toBe('/domains/7/setup/3');
		expect(screen.getByText(/Step 3 of 5/)).toBeInTheDocument();
		expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('DKIM');
		await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ domain: 'complete' }));
	});

	it('Continue saves the step and moves on; Skip saves it as skipped', async () => {
		const { calls } = renderApp(<Wizard />, { route: '/domains/7/setup/3', routes: routes() });
		await heading('DKIM signing');
		await waitFor(() => expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled());
		await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
		expect(await heading('DMARC policy')).toBeInTheDocument();
		expect(where()).toBe('/domains/7/setup/4');
		expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toContainEqual({ dkim: 'skipped' });
	});

	it('finishes on the last step by going to the domain', async () => {
		const { calls } = renderApp(<Wizard />, { route: '/domains/7/setup/5', routes: routes() });
		await heading('Reports routing');
		await userEvent.click(await screen.findByRole('button', { name: 'Go to dashboard' }));
		expect(await screen.findByText('Domain page')).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'PUT' && (c.body as { routing?: string }).routing === 'complete')).toBe(true);
		expect(localStorage.getItem('ia_onboarding_done')).toBeNull();
	});

	it('shows a retryable error when the status cannot be loaded', async () => {
		renderApp(<Wizard />, { route: '/domains/7/setup/2', routes: routes({ status: () => fail(403, 'nope') }) });
		expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Go to dashboard' })).toBeInTheDocument();
	});
});

describe('DNS lookup failures are not missing records', () => {
	it('SPF: shows "Lookup failed", no editor and no apply nudge, and retry refetches', async () => {
		const { calls } = renderApp(<Wizard />, {
			route: '/domains/7/setup/2',
			routes: routes({ status: status({ spf: { record: null, lookup_count: null, flattening_active: false }, dns_errors: ['spf: SERVFAIL'] }) }),
		});
		const row = (await screen.findAllByText('Lookup failed', { selector: 'span' }))[1]?.closest('li') as HTMLElement;
		expect(row).toHaveAttribute('data-status', 'error');
		expect(within(row).getByText(/SERVFAIL/)).toBeInTheDocument();
		expect(screen.queryByText(/No SPF record found/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Apply via Cloudflare/ })).not.toBeInTheDocument();
		expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

		const before = calls.filter((c) => c.path.endsWith('onboarding-status')).length;
		await userEvent.click(within(row).getByRole('button', { name: 'Try again' }));
		await waitFor(() => expect(calls.filter((c) => c.path.endsWith('onboarding-status')).length).toBe(before + 1));
	});

	it('SPF: a successful lookup that finds nothing is "no record" and offers the editor', async () => {
		renderApp(<Wizard />, { route: '/domains/7/setup/2', routes: routes({ status: status({ spf: { record: null, lookup_count: null, flattening_active: false } }) }) });
		expect(await screen.findByText(/No SPF record found/)).toBeInTheDocument();
		expect(screen.getByRole('combobox')).toBeInTheDocument();
	});

	it('DMARC: a failed lookup is not "No DMARC record found"', async () => {
		renderApp(<Wizard />, {
			route: '/domains/7/setup/4',
			routes: routes({ status: status({ dmarc: { found: false, has_our_rua: false, current_record: null, rua_address: 'r@x.com' }, dns_errors: ['dmarc: timeout'] }) }),
		});
		await heading('DMARC policy');
		expect((await screen.findAllByText('Lookup failed')).length).toBeGreaterThan(0);
		expect(document.querySelector('li[data-status="error"]')).not.toBeNull();
		expect(screen.queryByText(/No DMARC record found/)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Apply via Cloudflare/ })).not.toBeInTheDocument();
	});

	it('DMARC: a missing record is shown as missing with the recommended record', async () => {
		renderApp(<Wizard />, {
			route: '/domains/7/setup/4',
			routes: routes({ status: status({ dmarc: { found: false, has_our_rua: false, current_record: null, rua_address: 'r@reports.example.com' } }) }),
		});
		expect(await screen.findByText(/No DMARC record found/)).toBeInTheDocument();
		expect(screen.getByText('v=DMARC1; p=none; rua=mailto:r@reports.example.com')).toBeInTheDocument();
	});

	it('DMARC: an existing p=reject stays p=reject when only our rua is added', async () => {
		const current = 'v=DMARC1; p=reject; sp=none; rua=mailto:other@x.com';
		const { calls } = renderApp(<Wizard />, {
			route: '/domains/7/setup/4',
			routes: routes({
				status: status({ dmarc: { found: true, has_our_rua: false, current_record: current, rua_address: 'r@reports.example.com' } }),
				extra: { 'POST /api/domains/7/apply-dmarc': { ok: true, record: 'x', created: false } },
			}),
		});
		await heading('DMARC policy');
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: /Apply via Cloudflare/ }));
		await waitFor(() => expect(calls.some((c) => c.path === '/api/domains/7/apply-dmarc')).toBe(true));
		const record = calls.find((c) => c.path === '/api/domains/7/apply-dmarc')?.body.record as string;
		expect(record).toContain('p=reject');
		expect(record).toContain('sp=none');
		expect(record).not.toMatch(/(^|;\s*)p=none/);
		expect(record).toContain('mailto:other@x.com,mailto:r@reports.example.com');
	});

	it('Routing: failed MX lookup is an error row without the "set up" nudge', async () => {
		renderApp(<Wizard />, {
			route: '/domains/7/setup/5',
			routes: routes({
				status: status({
					routing: { mx_found: false, destination_verified: true, reports_domain: 'reports.example.com', admin_email: 'o@x.com', null_sender_spf: false, null_sender_dmarc: false },
					dns_errors: ['mx: timeout', 'null-sender spf: timeout', 'null-sender dmarc: timeout'],
				}),
			}),
		});
		await heading('Reports routing');
		const mx = (await screen.findByText('MX records')).closest('li') as HTMLElement;
		expect(mx).toHaveAttribute('data-status', 'error');
		expect(screen.queryByRole('button', { name: 'Set up email routing' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Add null-sender protection' })).not.toBeInTheDocument();
		expect(screen.queryByText(/No MX records found/)).not.toBeInTheDocument();
	});

	it('DKIM: failed selector lookups never read as "No DKIM selectors found"', async () => {
		renderApp(<Wizard />, { route: '/domains/7/setup/3', routes: routes({ status: status({ dns_errors: ['dkim google: SERVFAIL'], spf: { record: null, lookup_count: null, flattening_active: false } }) }) });
		await heading('DKIM signing');
		expect(await screen.findByText('DKIM selector lookups')).toBeInTheDocument();
		expect(screen.queryByText(/No DKIM selectors found/)).not.toBeInTheDocument();
	});
});

describe('SPF apply and the overwrite dialog', () => {
	const applyRoutes = (handler: Handler) =>
		routes({
			status: status({ spf: { record: 'v=spf1 include:_spf.google.com ~all', lookup_count: 2, flattening_active: false } }),
			extra: { 'POST /api/domains/7/apply-spf': handler, 'POST /api/spf-lookup-count': { lookup_count: 3 } },
		});

	async function addSendGrid() {
		const box = await screen.findByRole('combobox');
		await userEvent.type(box, 'sendg');
		await userEvent.click(await screen.findByRole('option', { name: /SendGrid/ }));
	}

	it('asks for confirmation in a dialog (not window.confirm) and only re-posts with confirm_overwrite on yes', async () => {
		const existing = 'v=spf1 include:_spf.google.com ~all';
		const { calls } = renderApp(<Wizard />, {
			route: '/domains/7/setup/2',
			routes: applyRoutes(({ body }) =>
				body.confirm_overwrite ? { ok: true } : { ok: false, needs_confirmation: true, existing_record: existing, proposed_record: body.record },
			),
		});
		await addSendGrid();
		const apply = screen.getByRole('button', { name: 'Apply via Cloudflare' });
		await waitFor(() => expect(apply).toBeEnabled());
		await userEvent.click(apply);

		const dialog = await screen.findByRole('dialog', { name: 'Replace the existing SPF record?' });
		expect(within(dialog).getByText('Existing record in DNS')).toBeInTheDocument();
		expect(within(dialog).getByText(existing)).toBeInTheDocument();
		expect(within(dialog).getByText('v=spf1 include:_spf.google.com include:sendgrid.net ~all')).toBeInTheDocument();
		expect(calls.filter((c) => c.path.endsWith('apply-spf'))).toHaveLength(1);

		// Cancelling is silent: no second request, no success message.
		await userEvent.click(within(dialog).getByRole('button', { name: 'Keep the existing record' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		expect(calls.filter((c) => c.path.endsWith('apply-spf'))).toHaveLength(1);
		expect(screen.queryByText('SPF record applied')).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole('button', { name: 'Apply via Cloudflare' }));
		const again = await screen.findByRole('dialog');
		await userEvent.click(within(again).getByRole('button', { name: 'Replace with the proposed record' }));
		expect(await screen.findByText('SPF record applied', { selector: 'p' })).toBeInTheDocument();
		const posts = calls.filter((c) => c.path.endsWith('apply-spf'));
		expect(posts.map((c) => c.body.confirm_overwrite)).toEqual([false, false, true]);
		expect(posts[2]?.body.record).toBe('v=spf1 include:_spf.google.com include:sendgrid.net ~all');
	});

	it('shows an apply failure inline', async () => {
		renderApp(<Wizard />, { route: '/domains/7/setup/2', routes: applyRoutes(() => fail(502, 'Cloudflare said no')) });
		await addSendGrid();
		const apply = screen.getByRole('button', { name: 'Apply via Cloudflare' });
		await waitFor(() => expect(apply).toBeEnabled());
		await userEvent.click(apply);
		expect(await screen.findByText('Cloudflare said no')).toBeInTheDocument();
		expect(screen.getByText('Could not apply the record')).toBeInTheDocument();
	});

	it('previews the proposed record side by side with the current one, with a real lookup count', async () => {
		renderApp(<Wizard />, { route: '/domains/7/setup/2', routes: applyRoutes(() => ({ ok: true })) });
		await addSendGrid();
		expect(screen.getByText('Current DNS record')).toBeInTheDocument();
		expect(screen.getByText('Proposed record')).toBeInTheDocument();
		expect(await screen.findByText(/3 \/ 10 lookups/, {}, { timeout: 3000 })).toBeInTheDocument();
	});
});

describe('members', () => {
	it('see the read-only notice, cannot apply, but can walk through the steps without saving', async () => {
		const { calls } = renderApp(<Wizard />, {
			role: 'member',
			route: '/domains/7/setup/2',
			routes: routes({
				wizard: wizard({ domain: 'not_started' }),
				status: status({ spf: { record: null, lookup_count: null, flattening_active: false } }),
			}),
		});
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		await userEvent.type(await screen.findByRole('combobox'), 'goog');
		await userEvent.click(await screen.findByRole('option', { name: /Google Workspace/ }));
		const apply = screen.getByRole('button', { name: /Apply via Cloudflare/ });
		expect(apply).toBeDisabled();

		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await heading('DKIM signing')).toBeInTheDocument();
		expect(where()).toBe('/domains/7/setup/3');
		expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
	});

	it('cannot create the domain on the first step', async () => {
		renderApp(<Wizard />, { role: 'member', route: '/setup', routes: routes({ domains: [] }) });
		await heading("What's your main domain?");
		await userEvent.type(screen.getByRole('textbox', { name: 'Main domain' }), 'example.com');
		expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
	});
});

describe('domain step', () => {
	it('validates, posts the base domain and continues at step 2', async () => {
		const { calls } = renderApp(<Wizard />, {
			route: '/setup',
			routes: routes({
				domains: [],
				extra: {
					'POST /api/settings/base-domain': { ok: true, domain: 'example.com', domain_id: 7, reports_domain: 'reports.example.com' },
				},
			}),
		});
		const input = await screen.findByRole('textbox', { name: 'Main domain' });
		await userEvent.type(input, 'not a domain');
		await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('Enter a valid domain like yourdomain.com')).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'POST')).toBe(false);

		await userEvent.clear(input);
		await userEvent.type(input, ' Example.COM ');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await heading('SPF record')).toBeInTheDocument();
		expect(where()).toBe('/domains/7/setup/2');
		expect(calls.find((c) => c.path === '/api/settings/base-domain')?.body).toEqual({ domain: 'example.com' });
	});
});
