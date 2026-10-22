/**
 * Drizzle schema for InboxAngel on Cloudflare D1 — the single source of truth.
 *
 * Keep this file byte-for-byte aligned with what `migrations/*.sql` produce:
 * `test/schema-drift.test.ts` applies every migration to an empty database and
 * compares the result with the tables declared here.
 *
 * Tenancy: every row that belongs to a tenant carries `account_id`. Self-hosted
 * installs have exactly one account, IMPLICIT_ACCOUNT_ID. Tables that are
 * deliberately global are listed in GLOBAL_TABLES.
 */
import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
	unique,
} from 'drizzle-orm/sqlite-core';

/** Id of the one account every self-hosted install has. */
export const IMPLICIT_ACCOUNT_ID = 'acct_default';

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

const now = sql`(unixepoch())`;

/**
 * `account_id` on tables added to in 0012. SQLite cannot add a NOT NULL column
 * with a REFERENCES clause unless its default is NULL, and rebuilding a table
 * that other tables cascade from would delete their rows — so these columns are
 * `NOT NULL DEFAULT 'acct_default'` without an FK. Query helpers always set the
 * value explicitly; the default exists so the backfill is a metadata-only change.
 */
const accountId = () => text('account_id').notNull().default(IMPLICIT_ACCOUNT_ID);

// ── Accounts ────────────────────────────────────────────────

export const accounts = sqliteTable('accounts', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	created_at: integer('created_at').notNull().default(now),
});

export const memberships = sqliteTable(
	'memberships',
	{
		account_id: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
		user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
		role: text('role', { enum: MEMBERSHIP_ROLES }).notNull().default('member'),
		created_at: integer('created_at').notNull().default(now),
	},
	(t) => [
		primaryKey({ columns: [t.account_id, t.user_id] }),
		index('idx_memberships_user').on(t.user_id),
		check('memberships_role_check', sql`${t.role} IN ('owner', 'admin', 'member')`),
	],
);

// ── Users (global: one person can belong to several accounts) ──

export const users = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull().unique(),
		name: text('name').notNull(),
		password_hash: text('password_hash'),
		role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
		session_token: text('session_token'),
		last_login_at: integer('last_login_at'),
		created_at: integer('created_at').notNull().default(now),
	},
	(t) => [index('idx_users_email').on(t.email), index('idx_users_session').on(t.session_token)],
);

// ── Domains ─────────────────────────────────────────────────

export const domains = sqliteTable(
	'domains',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		// Globally unique: a hostname can only be monitored by one account.
		domain: text('domain').notNull().unique(),
		rua_address: text('rua_address').notNull(),
		dmarc_policy: text('dmarc_policy'),
		dmarc_pct: integer('dmarc_pct'),
		spf_record: text('spf_record'),
		auth_record_provisioned: integer('auth_record_provisioned').notNull().default(0),
		created_at: integer('created_at').notNull().default(now),
		updated_at: integer('updated_at').notNull().default(now),
		dns_record_id: text('dns_record_id'),
		rollout_rec_policy: text('rollout_rec_policy'),
		rollout_rec_pct: integer('rollout_rec_pct'),
		parent_id: integer('parent_id').references((): any => domains.id, { onDelete: 'set null' }),
		is_default: integer('is_default').notNull().default(0),
		alerts_enabled: integer('alerts_enabled').notNull().default(1),
		spf_lookup_count: integer('spf_lookup_count'),
		account_id: accountId(),
	},
	(t) => [
		index('idx_domains_domain').on(t.domain),
		index('idx_domains_parent').on(t.parent_id),
		index('idx_domains_account').on(t.account_id),
		// At most one default domain per account.
		uniqueIndex('idx_domains_is_default').on(t.account_id).where(sql`${t.is_default} = 1`),
	],
);

// ── DMARC aggregate reports ─────────────────────────────────

export const aggregateReports = sqliteTable(
	'aggregate_reports',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		domain_id: integer('domain_id').notNull().references(() => domains.id, { onDelete: 'cascade' }),
		org_name: text('org_name').notNull(),
		report_id: text('report_id').notNull(),
		date_begin: integer('date_begin').notNull(),
		date_end: integer('date_end').notNull(),
		total_count: integer('total_count').notNull().default(0),
		pass_count: integer('pass_count').notNull().default(0),
		fail_count: integer('fail_count').notNull().default(0),
		raw_xml: text('raw_xml'),
		created_at: integer('created_at').notNull().default(now),
		account_id: accountId(),
	},
	(t) => [
		unique().on(t.domain_id, t.report_id),
		index('idx_agg_reports_domain').on(t.domain_id),
		index('idx_agg_reports_date').on(t.date_begin),
		index('idx_agg_reports_account').on(t.account_id, t.date_begin),
	],
);

export const reportRecords = sqliteTable(
	'report_records',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		report_id: integer('report_id').notNull().references(() => aggregateReports.id, { onDelete: 'cascade' }),
		source_ip: text('source_ip').notNull(),
		count: integer('count').notNull().default(1),
		disposition: text('disposition').notNull(),
		dkim_result: text('dkim_result'),
		dkim_domain: text('dkim_domain'),
		spf_result: text('spf_result'),
		spf_domain: text('spf_domain'),
		header_from: text('header_from'),
		created_at: integer('created_at').notNull().default(now),
		reverse_dns: text('reverse_dns'),
		base_domain: text('base_domain'),
		country_code: text('country_code'),
		org: text('org'),
		account_id: accountId(),
	},
	(t) => [
		index('idx_records_report').on(t.report_id),
		index('idx_records_ip').on(t.source_ip),
		index('idx_records_account').on(t.account_id),
	],
);

// ── TLS-RPT reports ─────────────────────────────────────────

export const tlsReports = sqliteTable(
	'tls_reports',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		domain_id: integer('domain_id').notNull().references(() => domains.id, { onDelete: 'cascade' }),
		org_name: text('org_name').notNull(),
		date_begin: integer('date_begin').notNull(),
		date_end: integer('date_end').notNull(),
		total_success: integer('total_success').notNull().default(0),
		total_failure: integer('total_failure').notNull().default(0),
		failure_details: text('failure_details'),
		raw_json: text('raw_json'),
		created_at: integer('created_at').notNull().default(now),
		account_id: accountId(),
	},
	(t) => [
		unique().on(t.domain_id, t.org_name, t.date_begin),
		index('idx_tls_reports_domain').on(t.domain_id, t.date_begin),
		index('idx_tls_reports_account').on(t.account_id),
	],
);

// ── Per-domain config ───────────────────────────────────────

export const spfFlattenConfig = sqliteTable(
	'spf_flatten_config',
	{
		domain_id: integer('domain_id').primaryKey().references(() => domains.id, { onDelete: 'cascade' }),
		enabled: integer('enabled').notNull().default(1),
		cf_record_id: text('cf_record_id'),
		canonical_record: text('canonical_record').notNull(),
		flattened_record: text('flattened_record'),
		ip_count: integer('ip_count'),
		lookup_count: integer('lookup_count'),
		last_flattened_at: integer('last_flattened_at'),
		last_error: text('last_error'),
		created_at: integer('created_at').notNull().default(now),
		updated_at: integer('updated_at').notNull().default(now),
		account_id: accountId(),
	},
	(t) => [index('idx_spf_flatten_account').on(t.account_id)],
);

export const mtaStsConfig = sqliteTable(
	'mta_sts_config',
	{
		domain_id: integer('domain_id').primaryKey().references(() => domains.id, { onDelete: 'cascade' }),
		enabled: integer('enabled').notNull().default(1),
		mode: text('mode', { enum: ['testing', 'enforce'] }).notNull().default('testing'),
		mx_hosts: text('mx_hosts').notNull().default('[]'),
		max_age: integer('max_age').notNull().default(86400),
		policy_id: text('policy_id').notNull(),
		mta_sts_record_id: text('mta_sts_record_id'),
		tls_rpt_record_id: text('tls_rpt_record_id'),
		cname_record_id: text('cname_record_id'),
		last_error: text('last_error'),
		created_at: integer('created_at').notNull().default(now),
		updated_at: integer('updated_at').notNull().default(now),
		account_id: accountId(),
	},
	(t) => [index('idx_mta_sts_account').on(t.account_id)],
);

// ── Monitoring subscriptions (free-check "watch my domain") ──

export const monitorSubscriptions = sqliteTable(
	'monitor_subscriptions',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		email: text('email').notNull(),
		domain: text('domain').notNull(),
		session_token: text('session_token'),
		spf_record: text('spf_record'),
		dmarc_policy: text('dmarc_policy'),
		dmarc_pct: integer('dmarc_pct'),
		dmarc_record: text('dmarc_record'),
		active: integer('active').$type<0 | 1>().notNull().default(1),
		last_checked_at: integer('last_checked_at'),
		created_at: integer('created_at').notNull().default(now),
		account_id: text('account_id').notNull().default(IMPLICIT_ACCOUNT_ID).references(() => accounts.id, { onDelete: 'cascade' }),
	},
	(t) => [
		unique().on(t.account_id, t.email, t.domain),
		index('idx_monitor_active').on(t.active, t.last_checked_at),
		index('idx_monitor_domain').on(t.domain),
	],
);

// ── Settings, invites, audit ────────────────────────────────

export const settings = sqliteTable(
	'settings',
	{
		account_id: text('account_id').notNull().default(IMPLICIT_ACCOUNT_ID).references(() => accounts.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		value: text('value').notNull(),
		updated_at: integer('updated_at').notNull().default(now),
	},
	(t) => [primaryKey({ columns: [t.account_id, t.key] })],
);

export const invites = sqliteTable(
	'invites',
	{
		token: text('token').primaryKey(),
		email: text('email').notNull(),
		role: text('role').notNull().default('member'),
		invited_by: text('invited_by').notNull(),
		created_at: integer('created_at').notNull().default(now),
		expires_at: integer('expires_at').notNull(),
		used_at: integer('used_at'),
		account_id: accountId(),
	},
	(t) => [index('idx_invites_account').on(t.account_id)],
);

export const auditLog = sqliteTable(
	'audit_log',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		actor_id: text('actor_id'),
		actor_email: text('actor_email'),
		actor_type: text('actor_type').notNull().default('user'),
		action: text('action').notNull(),
		resource_type: text('resource_type'),
		resource_id: text('resource_id'),
		resource_name: text('resource_name'),
		before_value: text('before_value'),
		after_value: text('after_value'),
		meta: text('meta'),
		created_at: integer('created_at').notNull().default(now),
		account_id: accountId(),
	},
	(t) => [
		index('idx_audit_created').on(sql`${t.created_at} DESC`),
		index('idx_audit_actor').on(t.actor_id),
		index('idx_audit_resource').on(t.resource_type, t.resource_id),
		index('idx_audit_account').on(t.account_id, sql`${t.created_at} DESC`),
	],
);

// ── Global tables (intentionally NOT account-scoped) ────────

/** Anonymous free-check results: not tied to any account. */
export const checkResults = sqliteTable(
	'check_results',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		from_email: text('from_email').notNull(),
		from_domain: text('from_domain').notNull(),
		spf_result: text('spf_result'),
		spf_domain: text('spf_domain'),
		spf_record: text('spf_record'),
		dkim_result: text('dkim_result'),
		dkim_domain: text('dkim_domain'),
		dmarc_result: text('dmarc_result'),
		dmarc_policy: text('dmarc_policy'),
		dmarc_record: text('dmarc_record'),
		overall_status: text('overall_status').notNull(),
		report_sent: integer('report_sent').notNull().default(0),
		created_at: integer('created_at').notNull().default(now),
		session_token: text('session_token'),
		spf_lookup_count: integer('spf_lookup_count'),
	},
	(t) => [index('idx_check_results_domain').on(t.from_domain), index('idx_check_results_token').on(t.session_token)],
);

/** Public IP metadata cache shared by everyone. */
export const ipInfo = sqliteTable('ip_info', {
	ip: text('ip').primaryKey(),
	reverse_dns: text('reverse_dns'),
	base_domain: text('base_domain'),
	country_code: text('country_code'),
	org: text('org'),
	asn: text('asn'),
	fetched_at: integer('fetched_at').notNull().default(now),
});

/** Keyed by user, which is itself global. */
export const passwordResetTokens = sqliteTable(
	'password_reset_tokens',
	{
		token: text('token').primaryKey(),
		user_id: text('user_id').notNull(),
		expires_at: integer('expires_at').notNull(),
		used_at: integer('used_at'),
	},
	(t) => [index('idx_prt_user').on(t.user_id)],
);

/**
 * Tables with no account_id, and why. `test/account-predicates.test.ts` uses
 * this list: anything else that is tenant data must be scoped.
 */
export const GLOBAL_TABLES = {
	accounts: 'the tenant registry itself',
	users: 'a user can belong to several accounts; membership carries the role',
	check_results: 'anonymous public free-check results, not tenant data',
	ip_info: 'shared public IP-metadata cache',
	password_reset_tokens: 'keyed by user_id, which is global',
} as const;

/** Tables that must carry an `account_id` column. */
export const ACCOUNT_OWNED_TABLES = [
	'memberships',
	'domains',
	'aggregate_reports',
	'report_records',
	'tls_reports',
	'spf_flatten_config',
	'mta_sts_config',
	'monitor_subscriptions',
	'settings',
	'invites',
	'audit_log',
] as const;
