// Hosted (MODE=saas) never derives a reports domain or report address, the email check says plainly when it cannot work,
// and onboarding-status reports the DMARC policy that applies (own or inherited) so the dashboard never offers a weaker one.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { HOSTED_ENV } from './world';
import { planHelpUrl } from '../../src/hosted/plan-limits';

const json = async (r: Response) => (await r.json()) as any;
afterEach(() => vi.restoreAllMocks());

async function hosted(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const token = await signupVerified(env, 'owner@agency.test');
  const ws = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', 'owner@agency.test')[0].workspace_id as string;
  const cf = stubCloudflare(new FakeCloudflare({}));
  return { db, env, rows, token, ws, cf };
}

describe('hosted: no reports domain and no report address, ever', () => {
  it('after the wizard domain step, a re-submit and /add, no domain has an rua_address and no reports settings exist', async () => {
    const w = await hosted();
    // Wizard domain step: a claim, proven by TXT.
    const first = await json(await call(w.env, 'POST', '/api/settings/base-domain', { key: w.token, body: { domain: 'acme-agency.com' } }));
    expect(first.pending).toBe(true);
    w.cf.doh['_readysetmail.acme-agency.com'] = [first.claim.txt_value];
    expect((await call(w.env, 'POST', `/api/domains/claims/${first.claim.id}/verify`, { key: w.token, body: {} })).status).toBe(201);

    // Submitting the same (now verified) domain again in the wizard must not set up report addresses either.
    const again = await call(w.env, 'POST', '/api/settings/base-domain', { key: w.token, body: { domain: 'acme-agency.com' } });
    expect(again.status).toBe(201);
    expect((await json(again)).reports_domain).toBeNull();

    // A later domain through /add.
    const second = await json(await call(w.env, 'POST', '/api/domains', { key: w.token, body: { domain: 'client-shop.com' } }));
    w.cf.doh['_readysetmail.client-shop.com'] = [second.claim.txt_value];
    const verified = await json(await call(w.env, 'POST', `/api/domains/claims/${second.claim.id}/verify`, { key: w.token, body: {} }));
    expect(verified.domain.rua_address).toBe('');

    const domains = w.rows('SELECT domain, rua_address FROM domains WHERE workspace_id = ? ORDER BY domain', w.ws);
    expect(domains).toEqual([{ domain: 'acme-agency.com', rua_address: '' }, { domain: 'client-shop.com', rua_address: '' }]);
    expect(w.rows("SELECT key FROM settings WHERE workspace_id = ? AND key IN ('reports_domain', 'base_domain', 'from_email')", w.ws)).toEqual([]);

    const id = domains.length && w.rows("SELECT id FROM domains WHERE domain = 'client-shop.com'")[0].id;
    const status = await json(await call(w.env, 'GET', `/api/domains/${id}/onboarding-status`, { key: w.token }));
    expect(status.rua_address).toBe('');
    expect(status.routing.reports_domain).toBeNull();
  });
});

describe('hosted: the one exception is an explicit Connect reports', () => {
  it('only POST /api/domains/:id/report-address sets an address (the fixed one), and DELETE clears it again', async () => {
    const w = await hosted({ HOSTED_CONNECT_REPORTS: 'all' });
    const added = await json(await call(w.env, 'POST', '/api/domains', { key: w.token, body: { domain: 'client-shop.com' } }));
    w.cf.doh['_readysetmail.client-shop.com'] = [added.claim.txt_value];
    const verified = await json(await call(w.env, 'POST', `/api/domains/claims/${added.claim.id}/verify`, { key: w.token, body: {} }));
    expect(verified.domain.rua_address).toBe('');
    const id = verified.domain.id as number;
    expect((await call(w.env, 'POST', `/api/domains/${id}/report-address`, { key: w.token, body: {} })).status).toBe(201);
    expect(w.rows('SELECT rua_address FROM domains WHERE id = ?', id)).toEqual([{ rua_address: `rua@${HOSTED_ENV.INTAKE_DOMAIN}` }]);
    expect(w.rows("SELECT key FROM settings WHERE workspace_id = ? AND key IN ('reports_domain', 'base_domain', 'from_email')", w.ws)).toEqual([]);
    expect((await call(w.env, 'DELETE', `/api/domains/${id}/report-address`, { key: w.token })).status).toBe(200);
    expect(w.rows('SELECT rua_address FROM domains WHERE id = ?', id)).toEqual([{ rua_address: '' }]);
  });
});

describe('onboarding-status: the DMARC policy that applies', () => {
  const domainRow = (w: Awaited<ReturnType<typeof hosted>>, name: string) => {
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES (?, '', ?, 'txt')").run(name, w.ws);
    return w.rows('SELECT id FROM domains WHERE domain = ?', name)[0].id as number;
  };

  it('a subdomain with no record of its own carries its parent\'s effective policy and where it comes from', async () => {
    const w = await hosted();
    const id = domainRow(w, 'developer.example.org');
    w.cf.doh['developer.example.org'] = ['v=spf1 -all'];
    w.cf.doh['_dmarc.example.org'] = ['v=DMARC1; p=reject'];
    const s = await json(await call(w.env, 'GET', `/api/domains/${id}/onboarding-status`, { key: w.token }));
    expect(s.dmarc.found).toBe(false);
    expect(s.dmarc.effective).toEqual({ policy: 'reject', inherited_from: 'example.org', issue: null, record: 'v=DMARC1; p=reject' });
    expect(s.nxdomain).toBe(false);
  });

  it('no policy anywhere: effective policy null, not inherited', async () => {
    const w = await hosted();
    const id = domainRow(w, 'plain.example.net');
    w.cf.doh['plain.example.net'] = ['v=spf1 -all'];
    const s = await json(await call(w.env, 'GET', `/api/domains/${id}/onboarding-status`, { key: w.token }));
    expect(s.dmarc.effective).toEqual({ policy: null, inherited_from: null, issue: null, record: null });
  });

  it('a name that does not exist says nxdomain', async () => {
    const w = await hosted();
    const id = domainRow(w, 'no-such-name.example.com');
    const s = await json(await call(w.env, 'GET', `/api/domains/${id}/onboarding-status`, { key: w.token }));
    expect(s.nxdomain).toBe(true);
  });
});

describe('free email check availability', () => {
  it('hosted without a canary domain: 503 with a plain message, and the status says it is unavailable', async () => {
    const w = await hosted({ CANARY_DOMAIN: undefined });
    const res = await call(w.env, 'POST', '/api/check-sessions');
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe('The email check is not available here: no address is set up to receive the test email.');
    expect((await json(await call(w.env, 'GET', '/api/auth/status'))).email_check).toBe(false);
  });

  it('hosted with a canary domain, and self-host: available', async () => {
    const w = await hosted();
    expect((await json(await call(w.env, 'GET', '/api/auth/status'))).email_check).toBe(true);
    expect((await json(await call(makeEnv(), 'GET', '/api/auth/status'))).email_check).toBe(true);
  });
});

describe('planHelpUrl uses the shared https-only helpUrl', () => {
  it.each(['https://a b', 'https://', 'http://cal.example.com', 'javascript:alert(1)', ''])('rejects %j', (BOOKING_URL) => {
    expect(planHelpUrl({ MODE: 'saas', BOOKING_URL })).toBeNull();
  });
  it('accepts an https link', () => {
    expect(planHelpUrl({ MODE: 'saas', BOOKING_URL: 'https://cal.example.com/max' })).toBe('https://cal.example.com/max');
  });
});

describe('plan-limit sentences', () => {
  it('singular and plural', async () => {
    const { planLimitBody } = await import('../../src/hosted/plan-limits');
    expect(planLimitBody({}, 'domains_per_workspace', 1).error).toBe('This workspace has reached its limit of 1 domain.');
    expect(planLimitBody({}, 'domains_per_workspace', 10).error).toBe('This workspace has reached its limit of 10 domains.');
    expect(planLimitBody({}, 'workspaces_per_user', 1).error).toBe('You have reached the limit of 1 workspace you can own.');
    expect(planLimitBody({}, 'workspaces_per_user', 5).error).toBe('You have reached the limit of 5 workspaces you can own.');
  });
});
