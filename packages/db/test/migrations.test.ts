import { describe, it, expect } from 'vitest';
import { createTestD1, applyMigrations, appliedMigrations, migrationFiles } from '../src/testing';
import { IMPLICIT_ACCOUNT_ID, ACCOUNT_OWNED_TABLES } from '../src/schema';
import { F, applyHistorical, freshDb, renameApplied, runLegacyRuntime, schemaSnapshot, tableExists } from './helpers';
import type { DatabaseSync } from 'node:sqlite';

const fresh = schemaSnapshot(freshDb().sqlite);

/** Insert one of everything that exists, using only columns present in every historical schema. */
function seed(db: DatabaseSync) {
	const ins = (sql: string, ...a: any[]) => db.prepare(sql).run(...a);
	ins("INSERT INTO domains (domain, rua_address) VALUES ('acme.com', 'a@r.test'), ('mail.acme.com', 'b@r.test')");
	ins("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count) VALUES (1, 'g', 'r1', 100, 200, 5), (1, 'g', 'r2', 300, 400, 7)");
	ins("INSERT INTO report_records (report_id, source_ip, count, disposition) VALUES (1, '1.1.1.1', 5, 'none'), (2, '2.2.2.2', 7, 'none')");
	ins("INSERT INTO check_results (from_email, from_domain, overall_status) VALUES ('x@y.z', 'y.z', 'exposed')");
	const has = (t: string) => tableExists(db, t);
	if (has('monitor_subscriptions')) ins("INSERT INTO monitor_subscriptions (email, domain) VALUES ('m@x.test', 'acme.com')");
	if (has('users')) {
		ins("INSERT INTO users (id, email, name, role, created_at) VALUES ('u2', 'second@x.test', 'Second', 'admin', 20), ('u1', 'first@x.test', 'First', 'admin', 10), ('u3', 'm@x.test', 'Mem', 'member', 30)");
	}
	if (has('settings')) ins("INSERT INTO settings (key, value) VALUES ('reports_domain', 'reports.acme.com'), ('brand_color', '#fff')");
	if (has('invites')) ins("INSERT INTO invites (token, email, invited_by, expires_at) VALUES ('t1', 'i@x.test', 'u1', 999)");
	if (has('audit_log')) ins("INSERT INTO audit_log (action) VALUES ('domain.add'), ('domain.delete')");
	if (has('tls_reports')) ins("INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end) VALUES (1, 'g', 1, 2)");
	if (has('spf_flatten_config')) ins("INSERT INTO spf_flatten_config (domain_id, canonical_record) VALUES (1, 'v=spf1 -all')");
	if (has('mta_sts_config')) ins("INSERT INTO mta_sts_config (domain_id, policy_id) VALUES (1, 'p1')");
}

function counts(db: DatabaseSync) {
	const out: Record<string, number> = {};
	for (const t of ['domains', 'aggregate_reports', 'report_records', 'check_results', 'monitor_subscriptions', 'users', 'settings', 'invites', 'audit_log', 'tls_reports', 'spf_flatten_config', 'mta_sts_config']) {
		if (tableExists(db, t)) out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n;
	}
	return out;
}

function expectUpgraded(db: DatabaseSync, before: Record<string, number>) {
	// 1. Same schema as a fresh install.
	expect(schemaSnapshot(db)).toEqual(fresh);
	// 2. No data lost (a cascade on a rebuilt parent table would show up here).
	for (const [t, n] of Object.entries(before)) expect(counts(db)[t], t).toBe(n);
	// 3. Everything landed in the implicit account.
	for (const t of ACCOUNT_OWNED_TABLES.filter((t) => t !== 'memberships')) {
		const bad = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id IS NOT ?`).get(IMPLICIT_ACCOUNT_ID) as any;
		expect(bad.n, `${t} rows outside implicit account`).toBe(0);
	}
	expect(db.prepare('SELECT id FROM accounts').all()).toEqual([{ id: IMPLICIT_ACCOUNT_ID }]);
	expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
	// 4. Idempotent.
	expect(applyMigrations(db)).toEqual([]);
}

// ── Historical states ─────────────────────────────────────────

const rollout = [F.rollout], sub = [F.subdomain];
const fileStates: Array<[string, () => (db: DatabaseSync) => void]> = [
	['0001 only', () => (db) => applyHistorical(db, [F.initial])],
	['through 0002', () => (db) => applyHistorical(db, [F.initial, F.dnsRecord])],
	['through 0003', () => (db) => applyHistorical(db, [F.initial, F.dnsRecord, F.token])],
	['through 0004', () => (db) => applyHistorical(db, [F.initial, F.dnsRecord, F.token, F.monitor])],
];
const base4 = [F.initial, F.dnsRecord, F.token, F.monitor];
const variants: Array<[string, string[]]> = [
	['0005_rollout_stage only', rollout],
	['0005_subdomain_parent only', sub],
	['both 0005 variants', [...rollout, ...sub]],
	['rollout + 0006', [...rollout, F.isDefault]],
	['subdomain + 0006', [...sub, F.isDefault]],
	['both 0005 + 0006 (current main)', [...rollout, ...sub, F.isDefault]],
	['0006 only', [F.isDefault]],
];
for (const [name, files] of variants) fileStates.push([name, () => (db) => applyHistorical(db, [...base4, ...files])]);
fileStates.push([
	'is_default applied under its pre-rename name 0005_add_is_default',
	() => (db) => {
		applyHistorical(db, [...base4, ...rollout, ...sub, F.isDefault]);
		renameApplied(db, F.isDefault, F.isDefaultOldName);
	},
]);

const runtimeLevels: Array<[string, number | null]> = [
	['wrangler files only (Worker never served a request)', null],
	['+ runtime migrations v1-v8', 8],
	['+ runtime migrations v1-v16 (a normal v1.x install)', 16],
];

describe('upgrade from every historical state', () => {
	for (const [fname, mk] of fileStates) {
		for (const [rname, level] of runtimeLevels) {
			it(`${fname} / ${rname}`, () => {
				const d = createTestD1();
				mk()(d.sqlite);
				if (level) runLegacyRuntime(d.sqlite, level);
				seed(d.sqlite);
				const before = counts(d.sqlite);
				applyMigrations(d.sqlite);
				expectUpgraded(d.sqlite, before);
			});
		}
	}

	it('runtime-only install (never ran `wrangler d1 migrations apply`)', () => {
		const d = createTestD1();
		runLegacyRuntime(d.sqlite, 16);
		seed(d.sqlite);
		const before = counts(d.sqlite);
		applyMigrations(d.sqlite);
		// Lacked parent_id / rollout / is_default: the file migrations supply them.
		expectUpgraded(d.sqlite, before);
	});

	it('empty-but-initialised legacy database (no rows) upgrades', () => {
		const d = createTestD1();
		applyHistorical(d.sqlite, [F.initial]);
		runLegacyRuntime(d.sqlite, 16);
		applyMigrations(d.sqlite);
		expect(schemaSnapshot(d.sqlite)).toEqual(fresh);
	});

	it('keeps data values, not just row counts', () => {
		const d = createTestD1();
		applyHistorical(d.sqlite, [...base4, ...rollout, ...sub, F.isDefault]);
		runLegacyRuntime(d.sqlite, 16);
		seed(d.sqlite);
		d.sqlite.exec("UPDATE domains SET is_default = 1, alerts_enabled = 0, dns_record_id = 'cf1' WHERE id = 1; UPDATE domains SET parent_id = 1 WHERE id = 2");
		applyMigrations(d.sqlite);
		const row = d.sqlite.prepare('SELECT * FROM domains WHERE id = 1').get() as any;
		expect(row).toMatchObject({ domain: 'acme.com', is_default: 1, alerts_enabled: 0, dns_record_id: 'cf1', account_id: IMPLICIT_ACCOUNT_ID });
		expect((d.sqlite.prepare('SELECT parent_id FROM domains WHERE id = 2').get() as any).parent_id).toBe(1);
		expect(d.sqlite.prepare("SELECT key, value, account_id FROM settings ORDER BY key").all()).toEqual([
			{ key: 'brand_color', value: '#fff', account_id: IMPLICIT_ACCOUNT_ID },
			{ key: 'reports_domain', value: 'reports.acme.com', account_id: IMPLICIT_ACCOUNT_ID },
		]);
		expect(d.sqlite.prepare('SELECT COUNT(*) n FROM aggregate_reports WHERE domain_id = 1').get()).toEqual({ n: 2 });
	});

	it('memberships: earliest admin is owner, other admins admin, rest member', () => {
		const d = createTestD1();
		applyMigrations(d.sqlite, { through: '0011_report_records_enrichment.sql' });
		seed(d.sqlite);
		applyMigrations(d.sqlite);
		expect(d.sqlite.prepare('SELECT user_id, role FROM memberships ORDER BY user_id').all()).toEqual([
			{ user_id: 'u1', role: 'owner' },
			{ user_id: 'u2', role: 'admin' },
			{ user_id: 'u3', role: 'member' },
		]);
	});
});

describe('why the adoption step exists', () => {
	it('plain `wrangler d1 migrations apply` re-runs a renamed migration and fails', () => {
		const d = createTestD1();
		applyHistorical(d.sqlite, [...base4, ...rollout, ...sub, F.isDefault]);
		renameApplied(d.sqlite, F.isDefault, F.isDefaultOldName);
		expect(() => applyMigrations(d.sqlite, { adopt: false })).toThrow(/0006_add_is_default.*duplicate column name: is_default/);
	});

	it('plain apply fails on columns the Worker created at runtime', () => {
		const d = createTestD1();
		runLegacyRuntime(d.sqlite, 16);
		expect(() => applyMigrations(d.sqlite, { adopt: false })).toThrow(/duplicate column name/);
	});

	it('0012 refuses to run (and rolls back) when the baseline is missing', () => {
		const d = createTestD1();
		applyHistorical(d.sqlite, [F.initial, '0007_runtime_tables.sql']);
		expect(() => applyMigrations(d.sqlite, { only: ['0012_accounts.sql'], adopt: false })).toThrow(/CHECK constraint failed|baseline_ok/);
		expect(tableExists(d.sqlite, 'accounts')).toBe(false);
	});

	it('adoption on a fresh database records nothing', () => {
		const d = createTestD1();
		expect(applyMigrations(d.sqlite)).toEqual(migrationFiles());
		expect(appliedMigrations(d.sqlite)).toEqual(migrationFiles());
	});

	it('repairs a half-applied multi-column migration (0011 with only some columns)', () => {
		const d = createTestD1();
		applyHistorical(d.sqlite, [...base4, ...rollout, ...sub, F.isDefault]);
		d.sqlite.exec('ALTER TABLE report_records ADD COLUMN org TEXT');
		runLegacyRuntime(d.sqlite, 9); // up to alerts_enabled
		applyMigrations(d.sqlite);
		expect(schemaSnapshot(d.sqlite)).toEqual(fresh);
	});
});
