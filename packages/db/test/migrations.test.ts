import { describe, it, expect } from 'vitest';
import { REQUIRED_MIGRATIONS, assertSchemaReady, resetSchemaReadyCache, SchemaNotReadyError } from '../src/ready';
import { createTestD1, applyMigrations, appliedMigrations, migrationFiles } from '../src/testing';
import { IMPLICIT_WORKSPACE_ID } from '../src/schema';
import { freshDb } from './helpers';

describe('migrations', () => {
	it('apply to a fresh database, once, in order', () => {
		const d = createTestD1();
		expect(applyMigrations(d.sqlite)).toEqual(migrationFiles());
		expect(appliedMigrations(d.sqlite)).toEqual(migrationFiles());
		expect(applyMigrations(d.sqlite)).toEqual([]);
	});

	it('leave a consistent database with the implicit workspace', () => {
		const { sqlite } = freshDb();
		expect(sqlite.prepare('SELECT id FROM workspaces').all()).toEqual([{ id: IMPLICIT_WORKSPACE_ID }]);
		expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
	});

	it('0002 backfills monitor confirmation: dashboard subscriptions (no check session) are confirmed, anonymous ones are not', () => {
		const d = createTestD1();
		applyMigrations(d.sqlite, { through: '0001_baseline.sql' });
		const ins = d.sqlite.prepare("INSERT INTO monitor_subscriptions (email, domain, session_token, created_at) VALUES (?, ?, ?, 1234)");
		ins.run('member@acme.com', 'acme.com', null);
		ins.run('stranger@x.com', 'acme.com', 'tok');
		applyMigrations(d.sqlite);
		expect(d.sqlite.prepare('SELECT email, confirmed_at FROM monitor_subscriptions ORDER BY email').all()).toEqual([
			{ email: 'member@acme.com', confirmed_at: 1234 },
			{ email: 'stranger@x.com', confirmed_at: null },
		]);
	});

	it('the runtime schema guard names only migrations that exist, and the newest one', () => {
		for (const m of REQUIRED_MIGRATIONS) expect(migrationFiles()).toContain(m);
		expect(REQUIRED_MIGRATIONS.at(-1)).toBe(migrationFiles().at(-1));
	});
});

describe('the runtime schema guard requires every migration this code needs', () => {
	const drop = (d: ReturnType<typeof createTestD1>, name: string) => d.sqlite.prepare('DELETE FROM d1_migrations WHERE name = ?').run(name);
	const ready = async (d: ReturnType<typeof createTestD1>) => { resetSchemaReadyCache(); return assertSchemaReady(d as unknown as D1Database); };

	it('requires both 0010_intake_hardening and 0012_dmarc_enforcement', () => {
		expect(REQUIRED_MIGRATIONS).toEqual(['0010_intake_hardening.sql', '0012_dmarc_enforcement.sql']);
	});

	it('a fully migrated database is ready', async () => {
		const d = createTestD1();
		applyMigrations(d.sqlite);
		await expect(ready(d)).resolves.toBeUndefined();
	});

	it('a later migration from another branch (0011, 0013) changes nothing', async () => {
		const d = createTestD1();
		applyMigrations(d.sqlite);
		for (const n of ['0011_other.sql', '0013_other.sql']) d.sqlite.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
		await expect(ready(d)).resolves.toBeUndefined();
	});

	for (const missing of REQUIRED_MIGRATIONS) {
		it(`refuses when only ${missing} is missing, naming the required migrations`, async () => {
			const d = createTestD1();
			applyMigrations(d.sqlite);
			drop(d, missing);
			await expect(ready(d)).rejects.toBeInstanceOf(SchemaNotReadyError);
			await expect(ready(d)).rejects.toThrow(missing);
		});
	}

	it('no migration history at all is refused with the same error', async () => {
		await expect(ready(createTestD1())).rejects.toBeInstanceOf(SchemaNotReadyError);
	});
});

describe('0008 dns_checked_at', () => {
	const NEW = ['dns_checked_at', 'dns_check_attempted_at', 'dns_check_status', 'dmarc_issue', 'dmarc_inherited_from', 'dns_last_good_status'];
	it('adds nullable columns and leaves existing domains unchecked, keeping their stored values', () => {
		const d = createTestD1();
		applyMigrations(d.sqlite, { through: '0007_metrics.sql' });
		d.sqlite.prepare("INSERT INTO domains (domain, rua_address, spf_record, dmarc_policy) VALUES ('acme.com', 'r@x', 'v=spf1 -all', 'none')").run();
		expect(applyMigrations(d.sqlite, { through: '0008_dns_checked_at.sql' })).toEqual(['0008_dns_checked_at.sql']);
		expect(d.sqlite.prepare('SELECT spf_record, dmarc_policy, ' + NEW.join(', ') + ' FROM domains').all()).toEqual([
			{ spf_record: 'v=spf1 -all', dmarc_policy: 'none', dns_checked_at: null, dns_check_attempted_at: null, dns_check_status: null, dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: null },
		]);
		const cols = d.sqlite.prepare("SELECT name, \"notnull\" AS nn, dflt_value AS dv FROM pragma_table_info('domains') WHERE name IN (" + NEW.map((n) => `'${n}'`).join(',') + ')').all() as any[];
		expect(cols.map((c) => c.name).sort()).toEqual([...NEW].sort());
		expect(cols.every((c) => c.nn === 0 && c.dv === null)).toBe(true);
	});
});

describe('0009 claim_settled', () => {
	it('adds two nullable columns: existing claims stay open', () => {
		const d = createTestD1();
		applyMigrations(d.sqlite, { through: '0008_dns_checked_at.sql' });
		d.sqlite.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_x', 'X')").run();
		d.sqlite.prepare("INSERT INTO domain_claims (workspace_id, domain, token) VALUES ('ws_x', 'acme.com', 't')").run();
		expect(applyMigrations(d.sqlite, { through: '0009_claim_settled.sql' })).toEqual(['0009_claim_settled.sql']);
		expect(d.sqlite.prepare('SELECT domain, status, settled_at, settled_domain_id FROM domain_claims').all()).toEqual([{ domain: 'acme.com', status: 'pending', settled_at: null, settled_domain_id: null }]);
		const cols = d.sqlite.prepare("SELECT name, \"notnull\" AS nn, dflt_value AS dv FROM pragma_table_info('domain_claims') WHERE name IN ('settled_at', 'settled_domain_id')").all() as any[];
		expect(cols.map((c) => c.name).sort()).toEqual(['settled_at', 'settled_domain_id']);
		expect(cols.every((c) => c.nn === 0 && c.dv === null)).toBe(true);
	});
});

describe('0010 intake hardening', () => {
	it('is additive: existing reports keep their rows, new columns are NULL, new tables are empty', () => {
		const d = createTestD1();
		applyMigrations(d.sqlite, { through: '0009_claim_settled.sql' });
		d.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'r@x')").run();
		d.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, reporter_auth) VALUES (1, 'google.com', 'r1', 1, 2, 5, 5, 'pass')").run();
		d.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count) VALUES (1, 'old.example', 'r2', 1, 2, 5, 5)").run();
		expect(applyMigrations(d.sqlite, { through: '0010_intake_hardening.sql' })).toEqual(['0010_intake_hardening.sql']);
		expect(d.sqlite.prepare('SELECT report_id, reporter_auth, reporter_auth_reason, ingest_token, record_count FROM aggregate_reports ORDER BY report_id').all()).toEqual([
			{ report_id: 'r1', reporter_auth: 'pass', reporter_auth_reason: null, ingest_token: null, record_count: null },
			{ report_id: 'r2', reporter_auth: null, reporter_auth_reason: null, ingest_token: null, record_count: null },
		]);
		for (const t of ['intake_quota', 'workspace_storage', 'intake_failures']) expect(d.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
	});
});

describe('0012 dmarc_enforcement', () => {
	it('adds a nullable dmarc_sp column and leaves existing domains unread', () => {
		const d = createTestD1();
		applyMigrations(d.sqlite, { through: '0010_intake_hardening.sql' });
		d.sqlite.prepare("INSERT INTO domains (domain, rua_address, dmarc_policy) VALUES ('acme.com', 'r@x', 'reject')").run();
		expect(applyMigrations(d.sqlite, { through: '0012_dmarc_enforcement.sql' })).toEqual(['0012_dmarc_enforcement.sql']);
		expect(d.sqlite.prepare('SELECT dmarc_policy, dmarc_pct, dmarc_sp FROM domains').all()).toEqual([{ dmarc_policy: 'reject', dmarc_pct: null, dmarc_sp: null }]);
	});
});
