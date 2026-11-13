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
	it('adds a nullable column and leaves existing domains unchecked, keeping their stored values', () => {
		const d = createTestD1();
		applyMigrations(d.sqlite, { through: '0007_metrics.sql' });
		d.sqlite.prepare("INSERT INTO domains (domain, rua_address, spf_record, dmarc_policy) VALUES ('acme.com', 'r@x', 'v=spf1 -all', 'none')").run();
		expect(applyMigrations(d.sqlite)).toEqual(['0008_dns_checked_at.sql']);
		expect(d.sqlite.prepare("SELECT spf_record, dmarc_policy, dns_checked_at FROM domains").all()).toEqual([{ spf_record: 'v=spf1 -all', dmarc_policy: 'none', dns_checked_at: null }]);
		const col = d.sqlite.prepare("SELECT \"notnull\" AS nn FROM pragma_table_info('domains') WHERE name = 'dns_checked_at'").get() as any;
		expect(col.nn).toBe(0);
	});
});
