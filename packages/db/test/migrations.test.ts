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

describe('0011 reports_connected_at', () => {
	it('adds one nullable column: existing domains stay not connected', () => {
		const d = createTestD1();
		applyMigrations(d.sqlite, { through: '0009_claim_settled.sql' });
		d.sqlite.prepare("INSERT INTO domains (domain, rua_address) VALUES ('acme.com', '')").run();
		// Whatever lands between 0009 and this one (0010 is the intake-hardening migration), 0011 is applied last.
		expect(applyMigrations(d.sqlite).at(-1)).toBe('0011_reports_connected_at.sql');
		expect(d.sqlite.prepare('SELECT domain, reports_connected_at FROM domains').all()).toEqual([{ domain: 'acme.com', reports_connected_at: null }]);
		const cols = d.sqlite.prepare("SELECT \"notnull\" AS nn, dflt_value AS dv FROM pragma_table_info('domains') WHERE name = 'reports_connected_at'").all() as any[];
		expect(cols).toEqual([{ nn: 0, dv: null }]);
	});
});
