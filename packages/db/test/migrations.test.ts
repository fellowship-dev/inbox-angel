import { describe, it, expect } from 'vitest';
import { REQUIRED_MIGRATION } from '../src/ready';
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

	it('the runtime schema guard names the newest migration', () => {
		expect(REQUIRED_MIGRATION).toBe(migrationFiles().at(-1));
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

describe('0011 intake hardening', () => {
	it('is additive: existing reports keep their rows, new columns are NULL, new tables are empty', () => {
		const d = createTestD1();
		applyMigrations(d.sqlite, { through: '0008_dns_checked_at.sql' });
		d.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'r@x')").run();
		d.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, reporter_auth) VALUES (1, 'google.com', 'r1', 1, 2, 5, 5, 'pass')").run();
		d.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count) VALUES (1, 'old.example', 'r2', 1, 2, 5, 5)").run();
		expect(applyMigrations(d.sqlite)).toEqual(['0011_intake_hardening.sql']);
		expect(d.sqlite.prepare('SELECT report_id, reporter_auth, reporter_auth_reason, ingest_token, record_count FROM aggregate_reports ORDER BY report_id').all()).toEqual([
			{ report_id: 'r1', reporter_auth: 'pass', reporter_auth_reason: null, ingest_token: null, record_count: null },
			{ report_id: 'r2', reporter_auth: null, reporter_auth_reason: null, ingest_token: null, record_count: null },
		]);
		for (const t of ['intake_quota', 'workspace_storage', 'intake_failures']) expect(d.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
	});
});
