import { describe, it, expect, beforeEach } from 'vitest';
import { forAccount, globalQueries, IMPLICIT_ACCOUNT_ID } from '../src';
import { createMigratedD1, type TestD1 } from '../src/testing';

const A = IMPLICIT_ACCOUNT_ID;
const B = 'acct_b';
let d1: TestD1;
let a: ReturnType<typeof forAccount>;
let b: ReturnType<typeof forAccount>;

const report = (domain_id: number, report_id = 'r1', over = {}) => ({
	domain_id, org_name: 'google', report_id, date_begin: 1_000_000, date_end: 1_086_400, total_count: 10, pass_count: 8, fail_count: 2, raw_xml: null, ...over,
});
const rec = (report_id: number, ip = '1.1.1.1') => ({
	report_id, source_ip: ip, count: 10, disposition: 'none', dkim_result: 'fail', dkim_domain: null, spf_result: 'fail', spf_domain: null, header_from: 'acme.com',
});

beforeEach(() => {
	d1 = createMigratedD1();
	d1.sqlite.exec(`INSERT INTO accounts (id, name) VALUES ('${B}', 'Other')`);
	a = forAccount(d1, A);
	b = forAccount(d1, B);
});

describe('domains', () => {
	it('insert / get / list round-trip within an account', async () => {
		const r = await a.domains.insert({ domain: 'acme.com', rua_address: 'x@r.test' });
		const id = Number(r.meta.last_row_id);
		expect(await a.domains.getById(id)).toMatchObject({ domain: 'acme.com', account_id: A, is_default: 0, alerts_enabled: 1 });
		expect(await a.domains.getByName('acme.com')).toMatchObject({ id });
		expect(await a.domains.list()).toHaveLength(1);
	});

	it('detects the parent domain (same account only)', async () => {
		await a.domains.insert({ domain: 'acme.com', rua_address: 'x' });
		await a.domains.insert({ domain: 'mail.acme.com', rua_address: 'x' });
		const sub = await a.domains.getByName('mail.acme.com');
		const apex = await a.domains.getByName('acme.com');
		expect(sub!.parent_id).toBe(apex!.id);
		expect(await a.domains.subdomains(apex!.id)).toHaveLength(1);
		// B owns an apex that A does not: A's subdomain must not link to it.
		await b.domains.insert({ domain: 'other.org', rua_address: 'x' });
		await a.domains.insert({ domain: 'www.other.org', rua_address: 'x' });
		expect((await a.domains.getByName('www.other.org'))!.parent_id).toBeNull();
	});

	it('domain names are unique across accounts', async () => {
		await a.domains.insert({ domain: 'acme.com', rua_address: 'x' });
		await expect(b.domains.insert({ domain: 'acme.com', rua_address: 'x' })).rejects.toThrow(/UNIQUE constraint failed: domains.domain/);
	});

	it('one default domain per account, independently', async () => {
		const ida = Number((await a.domains.insert({ domain: 'a1.com', rua_address: 'x' })).meta.last_row_id);
		const ida2 = Number((await a.domains.insert({ domain: 'a2.com', rua_address: 'x' })).meta.last_row_id);
		const idb = Number((await b.domains.insert({ domain: 'b1.com', rua_address: 'x' })).meta.last_row_id);
		await a.domains.setDefault(ida);
		await b.domains.setDefault(idb);
		await a.domains.setDefault(ida2);
		expect((await a.domains.getDefault())!.id).toBe(ida2);
		expect((await b.domains.getDefault())!.id).toBe(idb);
		expect((await a.domains.getById(ida))!.is_default).toBe(0);
	});
});

describe('an account-scoped query cannot see or touch another account', () => {
	let domA: number, repA: number;
	beforeEach(async () => {
		domA = Number((await a.domains.insert({ domain: 'acme.com', rua_address: 'x' })).meta.last_row_id);
		repA = Number((await a.reports.insertAggregate(report(domA))).meta.last_row_id);
		await a.reports.insertRecords([rec(repA)]);
		await a.reports.insertTls({ domain_id: domA, org_name: 'g', date_begin: 1_000_000, date_end: 1_086_400, total_success: 5, total_failure: 1, failure_details: null, raw_json: null });
		await a.monitor.insert({ email: 'm@x.test', domain: 'acme.com' });
		await a.settings.set('brand_color', '#abc');
		await a.spf.upsert({ domain_id: domA, canonical_record: 'v=spf1 -all', lookup_count: 1, cf_record_id: null });
		await a.mtaSts.insert({ domain_id: domA, mode: 'testing', mx_hosts: '[]', policy_id: 'p', mta_sts_record_id: null, tls_rpt_record_id: null, cname_record_id: null });
		await a.audit.insert({ action: 'domain.add', resource_type: 'domain', resource_id: String(domA) });
		await a.team.insertInvite({ token: 'tok', email: 'i@x.test', role: 'member', invited_by: 'u', expires_at: 9_999_999_999 });
		await a.team.addUser({ id: 'u1', email: 'u1@x.test', name: 'U1', password_hash: 'h', role: 'admin' });
	});

	it('reads', async () => {
		const since = 0;
		expect(await b.domains.list()).toEqual([]);
		expect(await b.domains.getById(domA)).toBeNull();
		expect(await b.domains.getByName('acme.com')).toBeNull();
		expect(await b.domains.subdomains(domA)).toEqual([]);
		expect(await b.reports.recent()).toEqual([]);
		expect(await b.reports.getWithDomain(repA)).toBeNull();
		expect(await b.reports.records(repA)).toEqual([]);
		expect(await b.reports.countForDomain(domA)).toBe(0);
		expect(await b.reports.weeklyDomainStats(since)).toEqual([]);
		expect(await b.reports.topFailingSources(domA, since)).toEqual([]);
		expect(await b.reports.anomalySources(domA, since)).toEqual([]);
		expect(await b.reports.allSources(domA, since)).toEqual([]);
		expect(await b.reports.dailyStats(domA, since)).toEqual([]);
		expect(await b.reports.sourcesByDate(domA, '1970-01-12')).toEqual([]);
		expect(await b.reports.daySummary(domA, '1970-01-12')).toMatchObject({ total: 0 });
		expect(await b.reports.exportData(domA)).toEqual([]);
		expect(await b.reports.checkSummary(domA, since)).toBeNull();
		expect(await b.reports.tlsSummary(domA, since)).toMatchObject({ report_count: 0 });
		expect(await b.monitor.byDomain('acme.com')).toEqual([]);
		expect(await b.monitor.active()).toEqual([]);
		expect(await b.settings.get('brand_color')).toBeNull();
		expect([...(await b.settings.getMany(['brand_color']))]).toEqual([]);
		expect(await b.spf.get(domA)).toBeNull();
		expect(await b.spf.allEnabled()).toEqual([]);
		expect(await b.mtaSts.get(domA)).toBeNull();
		expect(await b.mtaSts.getEnabledByDomain('acme.com')).toBeNull();
		expect(await b.mtaSts.allEnabled()).toEqual([]);
		expect(await b.audit.list()).toEqual([]);
		expect(await b.team.getInvite('tok')).toBeNull();
		expect(await b.team.list()).toEqual([]);
		expect(await b.team.getMember('u1')).toBeNull();
		expect(await b.team.firstAdmin()).toBeNull();
		expect(await b.heartbeat()).toMatchObject({ domain_count: 0, team_member_count: 0, reports_30d: 0 });
		// …and A sees all of it.
		expect(await a.domains.list()).toHaveLength(1);
		expect(await a.reports.recent()).toHaveLength(1);
		expect(await a.team.list()).toHaveLength(1);
		expect(await a.heartbeat()).toMatchObject({ domain_count: 1, team_member_count: 1 });
	});

	it('writes', async () => {
		await b.domains.updateDmarcPolicy(domA, 'reject');
		await b.domains.updateRollout(domA, 'reject', 100);
		await b.domains.updateSpfLookupCount(domA, 99);
		await b.domains.setAlertsEnabled(domA, false);
		await b.domains.setDnsRecord(domA, 'cf-x', { provisioned: true });
		await b.domains.setDefault(domA);
		await b.spf.updateResult(domA, 'x', 1, 'cf');
		await b.spf.updateError(domA, 'boom');
		await b.spf.upsert({ domain_id: domA, canonical_record: 'HIJACK', lookup_count: 9, cf_record_id: 'zz' });
		await b.mtaSts.updateMode(domA, 'enforce', 'p2');
		await b.mtaSts.updateMxHosts(domA, '["x"]', 'p2');
		await b.mtaSts.updateError(domA, 'boom');
		await b.monitor.setActive(1, false);
		await b.monitor.updateBaseline(1, { spf_record: 'x', dmarc_policy: 'none', dmarc_pct: 1, dmarc_record: 'x' });
		await b.team.markInviteUsed('tok');
		await b.team.removeUser('u1');
		await b.spf.delete(domA);
		await b.mtaSts.delete(domA);
		await b.domains.delete(domA);

		expect(await a.domains.getById(domA)).toMatchObject({ dmarc_policy: null, rollout_rec_policy: null, spf_lookup_count: null, alerts_enabled: 1, dns_record_id: null, is_default: 0 });
		expect(await a.spf.get(domA)).toMatchObject({ canonical_record: 'v=spf1 -all', last_error: null, flattened_record: null });
		expect(await a.mtaSts.get(domA)).toMatchObject({ mode: 'testing', policy_id: 'p', last_error: null });
		expect((await a.monitor.byDomain('acme.com'))[0]).toMatchObject({ active: 1, last_checked_at: null });
		expect(await a.team.getInvite('tok')).toMatchObject({ used_at: null });
		expect(await a.team.list()).toHaveLength(1);
	});

	it('inserts are stamped with the caller’s account, never another', async () => {
		const idB = Number((await b.domains.insert({ domain: 'b.com', rua_address: 'x' })).meta.last_row_id);
		await b.reports.insertAggregate(report(idB));
		await b.settings.set('brand_color', '#bbb');
		await b.audit.insert({ action: 'x' });
		expect(await b.settings.get('brand_color')).toEqual({ value: '#bbb' });
		expect(await a.settings.get('brand_color')).toEqual({ value: '#abc' });
		expect(d1.sqlite.prepare("SELECT COUNT(*) n FROM audit_log WHERE account_id = ?").get(B)).toEqual({ n: 1 });
		expect(d1.sqlite.prepare("SELECT COUNT(*) n FROM aggregate_reports WHERE account_id = ?").get(B)).toEqual({ n: 1 });
	});
});

describe('behaviour carried over from the old queries.ts', () => {
	it('re-delivered aggregate reports are ignored', async () => {
		const d = Number((await a.domains.insert({ domain: 'acme.com', rua_address: 'x' })).meta.last_row_id);
		const first = await a.reports.insertAggregate(report(d));
		const again = await a.reports.insertAggregate(report(d));
		expect(first.meta.changes).toBe(1);
		expect(again.meta.changes).toBe(0);
	});

	it('TLS reports upsert on (domain, org, date_begin)', async () => {
		const d = Number((await a.domains.insert({ domain: 'acme.com', rua_address: 'x' })).meta.last_row_id);
		const t = { domain_id: d, org_name: 'g', date_begin: 5, date_end: 6, total_success: 1, total_failure: 0, failure_details: null, raw_json: null };
		await a.reports.insertTls(t);
		await a.reports.insertTls({ ...t, total_success: 7, total_failure: 3 });
		expect(await a.reports.tlsSummary(d, 0)).toEqual({ total_success: 7, total_failure: 3, report_count: 1 });
	});

	it('weekly stats include domains with no reports; failing sources aggregate by IP', async () => {
		const d = Number((await a.domains.insert({ domain: 'acme.com', rua_address: 'x' })).meta.last_row_id);
		await a.domains.insert({ domain: 'quiet.com', rua_address: 'x' });
		const rep = Number((await a.reports.insertAggregate(report(d))).meta.last_row_id);
		await a.reports.insertRecords([rec(rep, '1.1.1.1'), rec(rep, '1.1.1.1'), rec(rep, '2.2.2.2')]);
		const stats = await a.reports.weeklyDomainStats(0);
		expect(stats.map((s) => [s.domain, s.total_messages, s.report_count])).toEqual([['acme.com', 10, 1], ['quiet.com', 0, 0]]);
		const top = await a.reports.topFailingSources(d, 0);
		expect(top.map((s) => [s.source_ip, s.total])).toEqual([['1.1.1.1', 20], ['2.2.2.2', 10]]);
	});

	it('settings: upsert, getMany, setMany', async () => {
		await a.settings.set('k', '1');
		await a.settings.set('k', '2');
		await a.settings.setMany({ x: 'X', y: 'Y' });
		expect(await a.settings.get('k')).toEqual({ value: '2' });
		expect([...(await a.settings.getMany(['k', 'x', 'nope']))].sort()).toEqual([['k', '2'], ['x', 'X']]);
		await a.settings.setMany({});
	});

	it('the same setting key can exist in two accounts', async () => {
		await a.settings.set('reports_domain', 'a.test');
		await b.settings.set('reports_domain', 'b.test');
		expect(await a.settings.get('reports_domain')).toEqual({ value: 'a.test' });
		expect(await b.settings.get('reports_domain')).toEqual({ value: 'b.test' });
	});

	it('active monitor subscriptions: alerts on, never-checked first', async () => {
		await a.domains.insert({ domain: 'on.com', rua_address: 'x' });
		const off = Number((await a.domains.insert({ domain: 'off.com', rua_address: 'x' })).meta.last_row_id);
		await a.domains.setAlertsEnabled(off, false);
		await a.monitor.insert({ email: 'e@x.test', domain: 'on.com' });
		await a.monitor.insert({ email: 'e2@x.test', domain: 'on.com' });
		await a.monitor.insert({ email: 'e@x.test', domain: 'off.com' });
		await a.monitor.insert({ email: 'e@x.test', domain: 'on.com' }); // duplicate: ignored
		const rows = await a.monitor.active();
		expect(rows.map((r) => [r.email, r.domain])).toEqual([['e@x.test', 'on.com'], ['e2@x.test', 'on.com']]);
		await a.monitor.updateBaseline(rows[0].id, { spf_record: 's', dmarc_policy: 'none', dmarc_pct: 100, dmarc_record: 'r' });
		expect((await a.monitor.active())[0].email).toBe('e2@x.test'); // checked one moves to the back
	});

	it('audit list filters and paginates', async () => {
		for (let i = 0; i < 5; i++) await a.audit.insert({ action: i % 2 ? 'dns.delete' : 'domain.add', actor_id: 'u1', resource_type: 'domain', resource_id: '7' });
		expect(await a.audit.list({ action: 'domain' })).toHaveLength(3);
		expect(await a.audit.list({ action: 'do%' })).toHaveLength(3); // % is stripped, prefix match
		expect(await a.audit.list({ domain_id: '7' })).toHaveLength(5);
		expect(await a.audit.list({ actor_id: 'nobody' })).toHaveLength(0);
		expect(await a.audit.list({ limit: 2, page: 3 })).toHaveLength(1);
		expect(await a.audit.list({ limit: 9999 })).toHaveLength(5);
	});

	it('team: first admin becomes owner; removing a user deletes them when they have no other account', async () => {
		await a.team.addUser({ id: 'u1', email: 'one@x.test', name: 'One', password_hash: 'h', role: 'admin' });
		await a.team.addUser({ id: 'u2', email: 'two@x.test', name: 'Two', password_hash: 'h', role: 'admin' });
		await a.team.addUser({ id: 'u3', email: 'three@x.test', name: 'Three', password_hash: null, role: 'member' });
		const roles = d1.sqlite.prepare('SELECT user_id, role FROM memberships ORDER BY user_id').all();
		expect(roles).toEqual([{ user_id: 'u1', role: 'owner' }, { user_id: 'u2', role: 'admin' }, { user_id: 'u3', role: 'member' }]);
		expect((await a.team.firstAdmin())!.id).toBe('u1');
		// u2 also joins B, then is removed from A: the user survives.
		d1.sqlite.exec(`INSERT INTO memberships (account_id, user_id, role) VALUES ('${B}', 'u2', 'member')`);
		await a.team.removeUser('u2');
		expect(await b.team.getMember('u2')).toMatchObject({ id: 'u2' });
		await a.team.removeUser('u3');
		expect(await globalQueries(d1).users.byEmail('three@x.test')).toBeNull();
		expect((await a.team.list()).map((u) => u.id)).toEqual(['u1']);
	});

	it('heartbeat counts', async () => {
		const d = Number((await a.domains.insert({ domain: 'acme.com', rua_address: 'x' })).meta.last_row_id);
		await a.domains.setDnsRecord(d, 'cf', { provisioned: true });
		await a.spf.upsert({ domain_id: d, canonical_record: 'x', lookup_count: 1, cf_record_id: null });
		await a.mtaSts.insert({ domain_id: d, mode: 'enforce', mx_hosts: '[]', policy_id: 'p', mta_sts_record_id: null, tls_rpt_record_id: null, cname_record_id: null });
		expect(await a.heartbeat()).toMatchObject({ domain_count: 1, dns_verified_count: 1, spf_flatten_count: 1, mta_sts_enforce_count: 1, mta_sts_testing_count: 0 });
	});
});

describe('global queries', () => {
	it('users, reset tokens, free-check results, ip cache', async () => {
		const g = globalQueries(d1);
		await a.team.addUser({ id: 'u1', email: 'one@x.test', name: 'One', password_hash: 'h', role: 'admin' });
		expect(await g.users.byEmail('one@x.test')).toMatchObject({ id: 'u1' });
		await g.users.setSession('u1', 'sess');
		expect(await g.users.bySession('sess')).toMatchObject({ id: 'u1' });
		await g.users.setPasswordHash('u1', 'h2');
		expect((await g.users.byEmail('one@x.test'))!.password_hash).toBe('h2');

		await g.passwordResets.insert('t', 'u1', 123);
		await g.passwordResets.markUsed('t');
		expect((await g.passwordResets.get('t'))!.used_at).not.toBeNull();

		await g.checkResults.insert({ from_email: 'a@b.c', from_domain: 'b.c', overall_status: 'exposed', report_sent: 0, session_token: 'tk' });
		expect(await g.checkResults.byToken('tk')).toMatchObject({ from_domain: 'b.c', spf_lookup_count: null });
		expect(await g.checkResults.latestForDomains(['b.c'])).toHaveLength(1);
		expect(await g.checkResults.latestForDomains([])).toEqual([]);

		await g.ipInfo.upsert({ ip: '1.1.1.1', reverse_dns: 'one', base_domain: null, country_code: 'AU', org: null, asn: null });
		await g.ipInfo.upsert({ ip: '1.1.1.1', reverse_dns: 'uno', base_domain: null, country_code: 'AU', org: 'Cloudflare', asn: 'AS13335' });
		expect(await g.ipInfo.get('1.1.1.1')).toMatchObject({ reverse_dns: 'uno', org: 'Cloudflare' });
	});
});
