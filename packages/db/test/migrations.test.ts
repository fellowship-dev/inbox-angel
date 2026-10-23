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
