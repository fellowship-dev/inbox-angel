// Review fixes for hosted self-serve (PR 142): inherited DMARC is never undercut, no report promises without reports,
// one contextual "Talk to Max" per screen, the email check hidden where it cannot work, and a name that does not
// resolve says so on its page.
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { DnsRecords } from '../src/components/domain/DnsRecords';
import { ImportResults } from '../src/components/domain/ImportResults';
import { EmailCheckPage } from '../src/pages/check/EmailCheckPage';
import { TalkToMax, TalkToMaxScope } from '../src/components/TalkToMax';
import { dmarcCoverage, inheritedSentence as sentence, keptEnforcement, offerEnforcement, recordFor } from '../src/lib/dmarc-coverage';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { wizardProgress } from '../src/lib/dmarc';
import { assessDomain } from '../src/lib/levels';
import { createQueryClient } from '../src/lib/query';
import type { AuthStatus, OnboardingStatus, WizardState } from '../src/lib/types';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import { DmarcWizardPage } from '../src/pages/wizards/DmarcWizardPage';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { fail, me, mockApi, renderApp, STATUS } from './render';

const BOOKING = 'https://cal.example.com/max/30min';
const HOSTED: Partial<AuthStatus> = { mode: 'saas', signup_open: true, configured: true, base_domain: null, help_url: BOOKING };
const talkLinks = () => screen.queryAllByRole('link', { name: /Talk to Max/ });

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

type Effective = NonNullable<OnboardingStatus['dmarc']['effective']>;
const none: Effective = { policy: null, inherited_from: null, issue: null };
const inherits = (policy: string | null, issue: string | null = null): Effective => ({ policy, inherited_from: 'mozilla.test', issue });

const onboarding = (over: Partial<OnboardingStatus> = {}, effective: Effective | null = none): OnboardingStatus => ({
	domain_id: 7,
	domain: 'developer.mozilla.test',
	rua_address: '',
	cf_available: false,
	dmarc: { found: false, has_our_rua: false, current_record: null, auth_record: { found: false, record_name: null }, effective },
	spf: { record: 'v=spf1 -all', lookup_count: 0, flattening_active: false },
	dkim: { selectors: [], source: 'doh' },
	routing: { mx_found: false, destination_verified: false, reports_domain: null, admin_email: 'o@x.test', null_sender_spf: false, null_sender_dmarc: false },
	...over,
});
const domain = { id: 7, domain: 'developer.mozilla.test', dmarc_policy: null, rua_address: '', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 0 };
const wizard: WizardState = { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'not_started', routing: 'not_started' };

describe('dmarcCoverage', () => {
	it('own record, inherited, none, unknown', () => {
		expect(dmarcCoverage(onboarding({ dmarc: { found: true, has_our_rua: false, current_record: 'v=DMARC1; p=none' } }))).toEqual({ kind: 'own' });
		expect(dmarcCoverage(onboarding({}, inherits('reject')))).toMatchObject({ kind: 'inherited', parent: 'mozilla.test', policy: 'reject', issue: null, pct: 100 });
		expect(dmarcCoverage(onboarding({}, none))).toEqual({ kind: 'none' });
		expect(dmarcCoverage(onboarding({}, null))).toEqual({ kind: 'unknown' });
		expect(dmarcCoverage(onboarding({}, none), true)).toEqual({ kind: 'unknown' });
	});
});

function dmarcStep(ob: OnboardingStatus) {
	return renderApp(
		<Routes>
			<Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} />
		</Routes>,
		{
			route: '/domains/7/setup/4',
			status: HOSTED,
			routes: { 'GET /api/domains': { domains: [domain] }, 'GET /api/domains/7/onboarding-status': ob, 'GET /api/domains/7/wizard-state': wizard, 'PUT /api/domains/7/wizard-state': {} },
		},
	);
}

const offered = () => screen.queryAllByText('v=DMARC1; p=none').length > 0;

describe('hosted wizard DMARC step: never weaker than the policy that applies', () => {
	it.each(['reject', 'quarantine'])('inherited p=%s: explains it and offers no record', async (policy) => {
		dmarcStep(onboarding({}, inherits(policy)));
		expect(await screen.findByText(new RegExp(`inherits p=${policy} from mozilla\\.test`))).toBeInTheDocument();
		expect(screen.getByText(/would replace that policy/)).toBeInTheDocument();
		expect(screen.queryByText(/No DMARC record found/)).not.toBeInTheDocument();
		expect(offered()).toBe(false);
		expect(screen.queryByText('Recommended record')).not.toBeInTheDocument();
	});

	it('inherited p=none: says so, offers no record of its own', async () => {
		dmarcStep(onboarding({}, inherits('none')));
		expect(await screen.findByText(/inherits p=none from mozilla\.test/)).toBeInTheDocument();
		expect(offered()).toBe(false);
	});

	it('no policy at all: offers p=none', async () => {
		dmarcStep(onboarding({}, none));
		expect(await screen.findByText(/No DMARC policy applies to this name/)).toBeInTheDocument();
		expect(offered()).toBe(true);
	});

	it('lookup failed: no offer', async () => {
		dmarcStep(onboarding({ dns_errors: ['dmarc: timeout'] }, null));
		expect(await screen.findByText(/The DNS lookup failed \(timeout\)/)).toBeInTheDocument();
		expect(offered()).toBe(false);
	});

	it('the parent could not be read: no offer, says why', async () => {
		dmarcStep(onboarding({}, null));
		expect(await screen.findByText(/could not tell which DMARC policy applies/)).toBeInTheDocument();
		expect(offered()).toBe(false);
	});
});

function records(ob: OnboardingStatus | ReturnType<typeof fail>, dns: unknown = { found: false, has_rua: false, current_record: null, cf_managed: false }) {
	return renderApp(<DnsRecords domain={domain as never} />, { status: HOSTED, routes: { 'GET /api/domains/7/dns-check': dns, 'GET /api/domains/7/onboarding-status': ob } });
}

describe('hosted domain page DMARC row', () => {
	it.each(['reject', 'quarantine'])('inherited p=%s: "Inherited", nothing to add', async (policy) => {
		records(onboarding({}, inherits(policy)));
		expect(await screen.findByText(`Inherited (p=${policy})`)).toBeInTheDocument();
		expect(screen.queryByText('Add this record')).not.toBeInTheDocument();
		expect(offered()).toBe(false);
	});

	it('inherited p=none: worth fixing at the parent, nothing to add here', async () => {
		records(onboarding({}, inherits('none')));
		expect(await screen.findByText('Inherited (p=none)')).toBeInTheDocument();
		expect(offered()).toBe(false);
	});

	it('no policy at all: offers p=none', async () => {
		records(onboarding({}, none));
		expect(await screen.findByText('Add this record')).toBeInTheDocument();
		expect(offered()).toBe(true);
	});

	it('lookup failed: no offer', async () => {
		records(onboarding({ dns_errors: ['dmarc: timeout'] }, null));
		expect(await screen.findByText(/could not tell whether a parent domain's policy covers this name/)).toBeInTheDocument();
		expect(offered()).toBe(false);
	});

	it('own p=none record: "Worth fixing", not a green "Published"', async () => {
		records(onboarding({ dmarc: { found: true, has_our_rua: false, current_record: 'v=DMARC1; p=none' } }), { found: true, has_rua: false, current_record: 'v=DMARC1; p=none', cf_managed: false });
		expect(await screen.findByText('Worth fixing')).toBeInTheDocument();
		expect(screen.queryByText('Published')).not.toBeInTheDocument();
	});

	it('a name that does not resolve: one verdict that matches the card, no "No SPF record"', async () => {
		records(onboarding({ nxdomain: true, spf: { record: null, lookup_count: null, flattening_active: false } }, none));
		expect(await screen.findByText('This domain does not resolve')).toBeInTheDocument();
		expect(screen.queryByText(/No SPF record found|No DMARC policy applies/)).not.toBeInTheDocument();
		expect(screen.getByText(/Sure this is the right name\?/)).toBeInTheDocument();
	});
});

describe('levels without reports (hosted)', () => {
	const base = { spf_record: 'v=spf1 -all', dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, dns_checked_at: 1 };
	it('never promises or leans on reports', () => {
		const monitoring = assessDomain({ ...base, dmarc_policy: 'none' }, { reports: false });
		const missing = assessDomain({ ...base, dmarc_policy: null }, { reports: false });
		const text = JSON.stringify([monitoring, missing]);
		expect(text).not.toMatch(/reports look clean|start receiving reports|Review your reports/);
		expect(missing.next).toBe('Publish a DMARC record with p=none.');
		expect(monitoring.next).toBe('Confirm every service that sends as this domain passes SPF or DKIM, then move DMARC to quarantine.');
	});
	it('self-host wording unchanged', () => {
		expect(assessDomain({ ...base, dmarc_policy: null }).next).toBe('Publish a DMARC record with p=none to start receiving reports.');
	});
});

describe('wizard progress, hosted', () => {
	it('the Reports step is not counted', () => {
		const all = { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' } as const;
		expect(wizardProgress(all, { hosted: true })).toMatchObject({ done: 4, total: 4 });
		expect(wizardProgress(all)).toMatchObject({ done: 5, total: 5 });
	});
});

describe('one contextual Talk to Max per screen', () => {
	it('a scope shows only the most specific line', () => {
		renderApp(
			<TalkToMaxScope>
				<TalkToMax priority={10} lead="Generic?" />
				<TalkToMax priority={50} lead="Specific?" />
				<TalkToMax priority={50} lead="Also specific?" />
			</TalkToMaxScope>,
			{ status: HOSTED },
		);
		return screen.findByText(/Specific\?/).then(() => {
			expect(talkLinks()).toHaveLength(1);
			expect(screen.queryByText(/Generic\?|Also specific\?/)).not.toBeInTheDocument();
		});
	});

	it('a plan limit on Add domain shows one link, not two', async () => {
		renderApp(<AddDomainPage />, {
			status: HOSTED,
			routes: {
				'GET /api/zones': fail(400),
				'POST /api/domains': { __status: 403, body: { error: 'This workspace has reached its limit of 10 domains.', code: 'plan_limit', limit: { kind: 'domains_per_workspace', max: 10 }, help_url: BOOKING } },
			},
		});
		const user = (await import('@testing-library/user-event')).default.setup();
		await user.type(await screen.findByLabelText('Your domain'), 'acme-agency.com');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('This workspace has reached its limit of 10 domains.')).toBeInTheDocument();
		expect(talkLinks()).toHaveLength(1);
	});

	it('the top-bar link is named "Talk to Max", without a duplicate of its title', async () => {
		const at = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={['/keys']}>{children}</MemoryRouter>;
		mockApi({
			'GET /api/auth/status': { ...STATUS, ...HOSTED, email_check: false },
			'GET /api/me': me('owner'),
			'GET /api/keys': { keys: [] },
			'GET /api/version': { current: '1.2.0', latest: '1.2.0', update_available: false, release_url: '' },
			'GET /api/mcp/connections': { connections: [] },
			'GET /api/access': { products: [], principals: [], credentials: [], grants: [] },
			'GET /api/resources': { domains: [] },
			'GET /api/metrics/google/connections': { configured: false, connections: [] },
			'GET /api/workspaces': { workspaces: [] },
		});
		render(<App queryClient={createQueryClient()} Router={at} />);
		const nav = await screen.findByRole('navigation', { name: 'Main' });
		expect(screen.getAllByRole('link', { name: 'Talk to Max' }).length).toBeGreaterThan(0);
		// email_check false: the Email check item is hidden.
		expect(nav.textContent).not.toContain('Email check');
	});
});

describe('hosted DMARC graduation wizard', () => {
	it('says what DNS alone can and cannot confirm, with no pass-rate advice', async () => {
		renderApp(
			<Routes>
				<Route path="/domains/:id/dmarc-wizard" element={<DmarcWizardPage />} />
			</Routes>,
			{
				route: '/domains/7/dmarc-wizard',
				status: HOSTED,
				routes: { 'GET /api/domains': { domains: [domain] }, 'GET /api/domains/7/dns-check': { found: true, has_rua: false, current_record: 'v=DMARC1; p=none', cf_managed: false }, 'GET /api/domains/7/onboarding-status': onboarding({ dmarc: { found: true, has_our_rua: false, current_record: 'v=DMARC1; p=none' } }) },
			},
		);
		expect(await screen.findByText(/DNS shows that this domain publishes an SPF record and a DMARC record/)).toBeInTheDocument();
		expect(screen.queryByText(/pass rate/i)).not.toBeInTheDocument();
		expect(screen.getByText(/Not sure every sender passes\?/)).toBeInTheDocument();
	});
});

// ── Second review: before sign-up ─────────────────────────────────────────────────────────

const stepAt = (step: number, ob: OnboardingStatus, status: Partial<AuthStatus> = HOSTED, dom: Record<string, unknown> = domain) =>
	renderApp(
		<Routes>
			<Route path="/domains/:id/setup/:step" element={<SetupWizardPage />} />
		</Routes>,
		{
			route: `/domains/7/setup/${step}`,
			status,
			routes: { 'GET /api/domains': { domains: [dom] }, 'GET /api/domains/7/onboarding-status': ob, 'GET /api/domains/7/wizard-state': wizard, 'PUT /api/domains/7/wizard-state': {} },
		},
	);

describe('wizard for a name that does not resolve', () => {
	it.each([2, 3, 4])('step %i gives the page\'s verdict and offers nothing', async (step) => {
		stepAt(step, onboarding({ nxdomain: true, spf: { record: null, lookup_count: null, flattening_active: false } }, none));
		expect(await screen.findByRole('heading', { name: 'This domain does not resolve' })).toBeInTheDocument();
		expect(screen.queryByText(/No SPF record found|No DMARC record found|No DMARC policy applies/)).not.toBeInTheDocument();
		expect(offered()).toBe(false);
		expect(screen.getByText(/Sure this is the right name\?/)).toBeInTheDocument();
	});
});

describe('inherited policy with pct below 100', () => {
	it('says only that share is affected, never "already reject"', async () => {
		dmarcStep(onboarding({}, { policy: 'reject', inherited_from: 'mozilla.test', issue: null, record: 'v=DMARC1; p=reject; pct=25' }));
		expect(await screen.findByText(/receivers reject 25% of the mail from this name that fails SPF and DKIM \(pct=25\)/)).toBeInTheDocument();
		expect(screen.queryByText(/already reject/)).not.toBeInTheDocument();
	});
});

describe('hosted DMARC graduation wizard: nothing to tighten without SPF and DMARC', () => {
	const wiz = (dns: unknown, ob: OnboardingStatus, status: Partial<AuthStatus> = HOSTED, dom: Record<string, unknown> = domain) =>
		renderApp(
			<Routes>
				<Route path="/domains/:id/dmarc-wizard" element={<DmarcWizardPage />} />
			</Routes>,
			{ route: '/domains/7/dmarc-wizard', status, routes: { 'GET /api/domains': { domains: [dom] }, 'GET /api/domains/7/dns-check': dns, 'GET /api/domains/7/onboarding-status': ob } },
		);

	it('no SPF and no DMARC: says what DNS shows, offers no record', async () => {
		wiz({ found: false, has_rua: false, current_record: null, cf_managed: false }, onboarding({ spf: { record: null, lookup_count: null, flattening_active: false } }, none));
		expect(await screen.findByRole('heading', { name: 'Not ready to change the policy' })).toBeInTheDocument();
		expect(screen.getByText('No DMARC record at _dmarc.developer.mozilla.test.')).toBeInTheDocument();
		expect(screen.getByText('No SPF record at developer.mozilla.test.')).toBeInTheDocument();
		expect(screen.queryByText('New record')).not.toBeInTheDocument();
		expect(screen.queryByText(/we can confirm/)).not.toBeInTheDocument();
	});

	it('DMARC published but no SPF: still nothing offered', async () => {
		wiz({ found: true, has_rua: false, current_record: 'v=DMARC1; p=none', cf_managed: false }, onboarding({ dmarc: { found: true, has_our_rua: false, current_record: 'v=DMARC1; p=none' }, spf: { record: null, lookup_count: null, flattening_active: false } }));
		expect(await screen.findByText(`No SPF record at developer.mozilla.test.`)).toBeInTheDocument();
		expect(screen.queryByText('New record')).not.toBeInTheDocument();
	});

	it('self-host: a subdomain inheriting reject gets no weaker step', async () => {
		const selfDomain = { ...domain, rua_address: 'rua@reports.mozilla.test' };
		wiz({ found: false, has_rua: false, current_record: null, cf_managed: false }, onboarding({ rua_address: 'rua@reports.mozilla.test' }, inherits('reject')), {}, selfDomain);
		expect(await screen.findByText(/inherits p=reject from mozilla\.test/)).toBeInTheDocument();
		expect(screen.queryByText(/p=quarantine|p=none/)).not.toBeInTheDocument();
	});
});

describe('self-host: never weaker than an inherited policy', () => {
	const selfDomain = { ...domain, rua_address: 'rua@reports.mozilla.test' };
	const selfOb = (effective: Effective | null) => onboarding({ rua_address: 'rua@reports.mozilla.test' }, effective);

	it('wizard step 4: a record at the inherited level with the report address, and why', async () => {
		stepAt(4, selfOb(inherits('reject')), {}, selfDomain);
		expect(await screen.findAllByText('v=DMARC1; p=reject; rua=mailto:rua@reports.mozilla.test')).not.toHaveLength(0);
		expect(screen.queryByText(/p=none/)).not.toBeInTheDocument();
		expect(screen.getByText(/would replace that policy/)).toBeInTheDocument();
	});

	it('wizard step 4: inherited p=none keeps offering p=none with the report address', async () => {
		stepAt(4, selfOb(inherits('none')), {}, selfDomain);
		expect(await screen.findAllByText('v=DMARC1; p=none; rua=mailto:rua@reports.mozilla.test')).not.toHaveLength(0);
	});

	it('wizard step 4: unknown policy, nothing offered', async () => {
		stepAt(4, selfOb(null), {}, selfDomain);
		expect(await screen.findByText(/could not tell which DMARC policy applies/)).toBeInTheDocument();
		expect(screen.queryByText(/rua=mailto/)).not.toBeInTheDocument();
	});

	it('domain page: a record at the inherited level', async () => {
		renderApp(<DnsRecords domain={selfDomain as never} />, { routes: { 'GET /api/domains/7/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false }, 'GET /api/domains/7/onboarding-status': selfOb(inherits('quarantine')) } });
		expect(await screen.findAllByText('v=DMARC1; p=quarantine; rua=mailto:rua@reports.mozilla.test')).not.toHaveLength(0);
		expect(screen.queryByText(/p=none/)).not.toBeInTheDocument();
	});

	it('add flow: a record at the inherited level', async () => {
		renderApp(<AddDomainPage />, {
			routes: {
				'GET /api/zones': fail(400),
				'POST /api/domains': { domain: selfDomain, rua_hint: '' },
				'GET /api/domains': { domains: [selfDomain] },
				'GET /api/domains/7/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
				'GET /api/domains/7/onboarding-status': selfOb(inherits('reject')),
			},
		});
		const user = (await import('@testing-library/user-event')).default.setup();
		await user.type(await screen.findByLabelText('Your domain'), 'developer.mozilla.org');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('v=DMARC1; p=reject; rua=mailto:rua@reports.mozilla.test')).toBeInTheDocument();
		expect(screen.queryByText(/p=none means/)).not.toBeInTheDocument();
	});
});

describe('email check page, hosted without a canary domain', () => {
	it('opened by URL, it says it is unavailable and offers no button that can only fail', async () => {
		const { calls } = renderApp(<EmailCheckPage />, { status: { ...HOSTED, email_check: false } });
		expect(await screen.findByText("The email check isn't available here")).toBeInTheDocument();
		expect(screen.queryByRole('button')).toBeNull();
		expect(calls.some((c) => c.path.startsWith('/api/check'))).toBe(false);
	});
});

describe('hosted bulk-import results', () => {
	it('a plain sentence, not "DNS provisioning: manual required"', async () => {
		renderApp(<ImportResults result={{ total: 1, imported: 1, results: [{ domain: 'acme-agency.com', status: 'imported', manual_dns: true }] } as never} />, { status: HOSTED });
		expect(await screen.findByText('Added. Its SPF, DKIM and DMARC records are checked from live DNS')).toBeInTheDocument();
		expect(screen.queryByText(/provisioning/)).not.toBeInTheDocument();
	});
});

describe('names that do not resolve, beyond the setup wizard', () => {
	it('graduation wizard offers nothing, in self-host too', async () => {
		const selfDomain = { ...domain, rua_address: 'rua@reports.mozilla.test' };
		renderApp(
			<Routes>
				<Route path="/domains/:id/dmarc-wizard" element={<DmarcWizardPage />} />
			</Routes>,
			{
				route: '/domains/7/dmarc-wizard',
				routes: {
					'GET /api/domains': { domains: [selfDomain] },
					'GET /api/domains/7/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
					'GET /api/domains/7/onboarding-status': onboarding({ rua_address: 'rua@reports.mozilla.test', nxdomain: true }, none),
				},
			},
		);
		expect(await screen.findByText(/does not exist, so there are no records to change/)).toBeInTheDocument();
		expect(screen.queryByText(/p=quarantine|New record/)).not.toBeInTheDocument();
	});

	it('self-host add flow offers no record for it', async () => {
		const selfDomain = { ...domain, domain: 'no-such-name-ia-walk.com', rua_address: 'rua@reports.mozilla.test' };
		renderApp(<AddDomainPage />, {
			routes: {
				'GET /api/zones': fail(400),
				'POST /api/domains': { domain: selfDomain, rua_hint: '' },
				'GET /api/domains': { domains: [selfDomain] },
				'GET /api/domains/7/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
				'GET /api/domains/7/onboarding-status': onboarding({ domain: 'no-such-name-ia-walk.com', nxdomain: true }, none),
			},
		});
		const user = (await import('@testing-library/user-event')).default.setup();
		await user.type(await screen.findByLabelText('Your domain'), 'no-such-name-ia-walk.com');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByRole('heading', { name: 'This domain does not resolve' })).toBeInTheDocument();
		expect(screen.queryByText(/rua=mailto/)).not.toBeInTheDocument();
	});
});

describe('hosted wizard: one count', () => {
	it('step 2 says "Step 2 of 4" and the header counts out of 4', async () => {
		stepAt(2, onboarding({}, none));
		const nav = await screen.findByRole('navigation', { name: 'Setup progress' });
		expect(nav).toHaveTextContent('Step 2 of 4: SPF');
		expect(screen.getByText(/of 4 steps complete/)).toBeInTheDocument();
	});
});

// ── Third review: exactly the enforcement in force, never weaker or stricter ─────────────────


const inheritRecord = (record: string, policy: string) => onboarding({ rua_address: 'rua@reports.mozilla.test' }, { policy, inherited_from: 'npmjs.test', issue: null, record });

describe('offered record carries the inherited enforcement exactly', () => {
	const cases: Array<[string, string, string, string]> = [
		// [parent record, effective policy for the subdomain, offered record, kept phrase]
		['v=DMARC1; p=reject', 'reject', 'v=DMARC1; p=reject; rua=mailto:rua@reports.mozilla.test', 'p=reject'],
		['v=DMARC1; p=quarantine; pct=5', 'quarantine', 'v=DMARC1; p=quarantine; pct=5; rua=mailto:rua@reports.mozilla.test', 'p=quarantine at pct=5'],
		['v=DMARC1; p=reject; sp=quarantine', 'quarantine', 'v=DMARC1; p=quarantine; rua=mailto:rua@reports.mozilla.test', 'the inherited sp=quarantine as its p=quarantine'],
		['v=DMARC1; p=reject; sp=quarantine; pct=25', 'quarantine', 'v=DMARC1; p=quarantine; pct=25; rua=mailto:rua@reports.mozilla.test', 'the inherited sp=quarantine as its p=quarantine at pct=25'],
	];
	it.each(cases)('%s', (record, policy, offered, kept) => {
		const c = dmarcCoverage(inheritRecord(record, policy));
		const e = offerEnforcement(c);
		expect(e).not.toBeNull();
		expect(recordFor(e!, 'rua@reports.mozilla.test')).toBe(offered);
		expect(keptEnforcement(c, e!)).toBe(kept);
	});

	it('parent p=reject with sp=none: says the subdomain policy is sp=none, offers p=none', () => {
		const c = dmarcCoverage(inheritRecord('v=DMARC1; p=reject; sp=none', 'none'));
		if (c.kind !== 'inherited') throw new Error('expected inherited');
		expect(sentence('support.ibm.test', c)).toContain("npmjs.test's policy for its subdomains is sp=none (its own p=reject does not apply here)");
		expect(sentence('support.ibm.test', c)).not.toContain('inherits p=none');
		expect(recordFor(offerEnforcement(c)!, null)).toBe('v=DMARC1; p=none');
	});

	it('an absent effective field is unknown: nothing offered', () => {
		const ob = onboarding({}, none);
		delete (ob.dmarc as { effective?: unknown }).effective;
		expect(dmarcCoverage(ob)).toEqual({ kind: 'unknown' });
		expect(offerEnforcement(dmarcCoverage(ob))).toBeNull();
	});

	it('self-host domain page for docs.npmjs-style pct=5: p=quarantine at pct=5, and says so', async () => {
		const selfDomain = { ...domain, rua_address: 'rua@reports.mozilla.test' };
		renderApp(<DnsRecords domain={selfDomain as never} />, {
			routes: { 'GET /api/domains/7/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false }, 'GET /api/domains/7/onboarding-status': inheritRecord('v=DMARC1; p=quarantine; pct=5', 'quarantine') },
		});
		expect(await screen.findAllByText('v=DMARC1; p=quarantine; pct=5; rua=mailto:rua@reports.mozilla.test')).not.toHaveLength(0);
		expect(screen.getByText(/it keeps p=quarantine at pct=5 and adds/)).toBeInTheDocument();
		expect(screen.queryByText('v=DMARC1; p=quarantine; rua=mailto:rua@reports.mozilla.test')).not.toBeInTheDocument();
	});
});

describe('self-host failed lookup: no required authorization record when nothing is offered', () => {
	it('wizard step 4', async () => {
		const selfDomain = { ...domain, rua_address: 'rua@reports.mozilla.test' };
		stepAt(4, onboarding({ rua_address: 'rua@reports.mozilla.test', dmarc: { found: false, has_our_rua: false, current_record: null, auth_record: { found: false, record_name: 'developer.mozilla.test._report._dmarc.reports.mozilla.test' }, effective: null } }), {}, selfDomain);
		expect(await screen.findByText(/could not tell which DMARC policy applies/)).toBeInTheDocument();
		expect(screen.queryByText('Report authorization record')).not.toBeInTheDocument();
	});
});

describe('repeat verify', () => {
	it('says "Already verified", not "Ownership verified"', async () => {
		const claim = { id: 5, domain: 'acme-agency.com', status: 'pending', txt_name: '_readysetmail.acme-agency.com', txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null };
		renderApp(<AddDomainPage />, {
			status: HOSTED,
			routes: {
				'GET /api/zones': fail(400),
				'POST /api/domains': { __status: 202, body: { pending: true, claim, domain: null } },
				'POST /api/domains/claims/5/verify': { domain: { ...domain, id: 9, domain: 'acme-agency.com' }, resumed: true },
				'GET /api/domains': { domains: [] },
				'GET /api/domains/claims/5/preview': fail(404),
			},
		});
		const user = (await import('@testing-library/user-event')).default.setup();
		await user.type(await screen.findByLabelText('Your domain'), 'acme-agency.com');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		await user.click(await screen.findByRole('button', { name: 'Verify' }));
		expect(await screen.findByText('Already verified')).toBeInTheDocument();
		expect(screen.queryByText('Ownership verified')).not.toBeInTheDocument();
	});
});

describe('domain page for a name that does not resolve', () => {
	const page = (nxdomain: boolean) =>
		renderApp(
			<Routes>
				<Route path="/domains/:id" element={<DomainDetailPage />} />
			</Routes>,
			{
				route: '/domains/7',
				status: HOSTED,
				routes: {
					'GET /api/domains': { domains: [domain] },
					'GET /api/domains/7/onboarding-status': onboarding({ nxdomain }, none),
					'GET /api/domains/7/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: false },
					'GET /api/domains/7/wizard-state': wizard,
					// Stored facts as the live read left them: p=none (level 1, setup not finished), or a name that does not exist.
					'GET /api/domains/7/check-summary': {
						domain_id: 7, domain: domain.domain, dmarc_policy: nxdomain ? null : 'none', spf_record: nxdomain ? null : 'v=spf1 -all', dns_checked_at: 1_700_000_000, dns_check_attempted_at: 1_700_000_000,
						dns_check_status: nxdomain ? 'nxdomain' : 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: nxdomain ? 'nxdomain' : 'ok', total_messages: 0, pass_messages: 0, fail_messages: 0,
						dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 1, dmarc_pct: null, dmarc_sp: null,
					},
					'GET /api/hosted/config': { enabled: true, records: true },
					'GET /api/domains/7/hosted': { enabled: false },
				},
			},
		);

	it('no "Continue setup" and no "Enable hosted records"', async () => {
		page(true);
		expect(await screen.findByText('This domain does not resolve')).toBeInTheDocument();
		expect(screen.queryByText('Continue setup')).not.toBeInTheDocument();
		expect(screen.queryByText('Enable hosted records')).not.toBeInTheDocument();
	});

	it('a resolving name still shows them', async () => {
		page(false);
		expect(await screen.findByText('Continue setup')).toBeInTheDocument();
	});
});
