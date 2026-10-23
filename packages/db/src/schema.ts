/**
 * Drizzle schema for InboxAngel on Cloudflare D1 — the single source of truth.
 *
 * Keep this file byte-for-byte aligned with what `migrations/*.sql` produce:
 * `test/schema-drift.test.ts` applies every migration to an empty database and
 * compares the result with the tables declared here.
 *
 * Tenancy: every row that belongs to a tenant carries `workspace_id`. Self-hosted
 * installs have exactly one workspace, IMPLICIT_WORKSPACE_ID. Tables that are
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

/** Id of the one workspace every self-hosted install has. */
export const IMPLICIT_WORKSPACE_ID = 'ws_default';

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

const now = sql`(unixepoch())`;

/**
 * `workspace_id` on tables added to in 0012. SQLite cannot add a NOT NULL column
 * with a REFERENCES clause unless its default is NULL, and rebuilding a table
 * that other tables cascade from would delete their rows — so these columns are
 * `NOT NULL DEFAULT 'ws_default'` without an FK. Query helpers always set the
 * value explicitly; the default exists so the backfill is a metadata-only change.
 */
const workspaceId = () => text('workspace_id').notNull().default(IMPLICIT_WORKSPACE_ID);

// ── Workspaces ────────────────────────────────────────────────

export const workspaces = sqliteTable('workspaces', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	created_at: integer('created_at').notNull().default(now),
});

export const memberships = sqliteTable(
	'memberships',
	{
		workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
		user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
		role: text('role', { enum: MEMBERSHIP_ROLES }).notNull().default('member'),
		created_at: integer('created_at').notNull().default(now),
	},
	(t) => [
		primaryKey({ columns: [t.workspace_id, t.user_id] }),
		index('idx_memberships_user').on(t.user_id),
		check('memberships_role_check', sql`${t.role} IN ('owner', 'admin', 'member')`),
	],
);

// ── Users (global: one person can belong to several workspaces) ──

export const users = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull().unique(),
		name: text('name').notNull(),
		password_hash: text('password_hash'),
		role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
		/** Legacy single-session token. Unused since 0013 (sessions live in `sessions`). */
		session_token: text('session_token'),
		last_login_at: integer('last_login_at'),
		created_at: integer('created_at').notNull().default(now),
		// Better Auth columns (0013).
		email_verified: integer('email_verified').notNull().default(0),
		image: text('image'),
		updated_at: integer('updated_at').notNull().default(sql`0`),
	},
	(t) => [index('idx_users_email').on(t.email), index('idx_users_session').on(t.session_token)],
);

// ── Domains ─────────────────────────────────────────────────

export const domains = sqliteTable(
	'domains',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		// Globally unique: a hostname can only be monitored by one workspace.
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
		workspace_id: workspaceId(),
		/** The Cloudflare connection that manages this domain's zone (0015). Null: the self-host env token, or none. */
		cf_connection_id: text('cf_connection_id').references((): any => cloudflareConnections.id, { onDelete: 'set null' }),
	},
	(t) => [
		index('idx_domains_domain').on(t.domain),
		index('idx_domains_cf_connection').on(t.cf_connection_id),
		index('idx_domains_parent').on(t.parent_id),
		index('idx_domains_workspace').on(t.workspace_id),
		// At most one default domain per workspace.
		uniqueIndex('idx_domains_is_default').on(t.workspace_id).where(sql`${t.is_default} = 1`),
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
		workspace_id: workspaceId(),
	},
	(t) => [
		unique().on(t.domain_id, t.report_id),
		index('idx_agg_reports_domain').on(t.domain_id),
		index('idx_agg_reports_date').on(t.date_begin),
		index('idx_agg_reports_workspace').on(t.workspace_id, t.date_begin),
		index('idx_agg_reports_date_end').on(t.date_end),
		index('idx_agg_reports_raw_xml').on(t.created_at).where(sql`${t.raw_xml} IS NOT NULL`),
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
		workspace_id: workspaceId(),
	},
	(t) => [
		index('idx_records_report').on(t.report_id),
		index('idx_records_ip').on(t.source_ip),
		index('idx_records_workspace').on(t.workspace_id),
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
		workspace_id: workspaceId(),
	},
	(t) => [
		unique().on(t.domain_id, t.org_name, t.date_begin),
		index('idx_tls_reports_domain').on(t.domain_id, t.date_begin),
		index('idx_tls_reports_workspace').on(t.workspace_id),
		index('idx_tls_reports_date_end').on(t.date_end),
		index('idx_tls_reports_raw_json').on(t.created_at).where(sql`${t.raw_json} IS NOT NULL`),
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
		workspace_id: workspaceId(),
	},
	(t) => [index('idx_spf_flatten_workspace').on(t.workspace_id)],
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
		workspace_id: workspaceId(),
	},
	(t) => [index('idx_mta_sts_workspace').on(t.workspace_id)],
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
		workspace_id: text('workspace_id').notNull().default(IMPLICIT_WORKSPACE_ID).references(() => workspaces.id, { onDelete: 'cascade' }),
	},
	(t) => [
		unique().on(t.workspace_id, t.email, t.domain),
		index('idx_monitor_active').on(t.active, t.last_checked_at),
		index('idx_monitor_domain').on(t.domain),
	],
);

// ── Settings, invites, audit ────────────────────────────────

export const settings = sqliteTable(
	'settings',
	{
		workspace_id: text('workspace_id').notNull().default(IMPLICIT_WORKSPACE_ID).references(() => workspaces.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		value: text('value').notNull(),
		updated_at: integer('updated_at').notNull().default(now),
	},
	(t) => [
		primaryKey({ columns: [t.workspace_id, t.key] }),
		// A reports domain belongs to one workspace: inbound mail is routed by it (cleared values are empty strings and may repeat).
		uniqueIndex('idx_settings_reports_domain').on(t.value).where(sql`${t.key} = 'reports_domain' AND ${t.value} <> ''`),
	],
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
		workspace_id: workspaceId(),
	},
	(t) => [index('idx_invites_workspace').on(t.workspace_id), index('idx_invites_expires').on(t.expires_at)],
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
		workspace_id: workspaceId(),
	},
	(t) => [
		index('idx_audit_created').on(sql`${t.created_at} DESC`),
		index('idx_audit_actor').on(t.actor_id),
		index('idx_audit_resource').on(t.resource_type, t.resource_id),
		index('idx_audit_workspace').on(t.workspace_id, sql`${t.created_at} DESC`),
	],
);

// ── Global tables (intentionally NOT workspace-scoped) ────────

/** Anonymous free-check results: not tied to any workspace. */
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
	(t) => [index('idx_check_results_domain').on(t.from_domain), index('idx_check_results_token').on(t.session_token), index('idx_check_results_created').on(t.created_at)],
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
}, (t) => [index('idx_ip_info_fetched').on(t.fetched_at)]);

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

// ── Authentication (Better Auth) ────────────────────────────
//
// These tables are read and written by Better Auth's Drizzle adapter, which looks
// columns up by *its* field names (createdAt, userId, …), so unlike the rest of this
// file their properties are camelCase and their dates are `timestamp` columns (unix
// seconds in SQL, Date in JS). The SQL column names follow the usual snake_case.
// `users` is adapted separately in auth-schema.ts for the same reason.

const authTimestamps = () => ({
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(now),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(now),
});

export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
		token: text('token').notNull().unique(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		...authTimestamps(),
	},
	(t) => [index('idx_sessions_user').on(t.userId), index('idx_sessions_expires').on(t.expiresAt)],
);

/** One row per login method: the `credential` password, or an OAuth provider link. (Not the tenant `workspaces` table.) */
export const authAccounts = sqliteTable(
	'auth_accounts',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
		accountId: text('provider_account_id').notNull(),
		providerId: text('provider_id').notNull(),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
		refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
		scope: text('scope'),
		password: text('password'),
		...authTimestamps(),
	},
	(t) => [index('idx_auth_accounts_user').on(t.userId), uniqueIndex('idx_auth_accounts_provider').on(t.providerId, t.accountId)],
);

export const verifications = sqliteTable(
	'verifications',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		...authTimestamps(),
	},
	(t) => [index('idx_verifications_identifier').on(t.identifier)],
);

export const authRateLimits = sqliteTable('auth_rate_limits', {
	id: text('id').primaryKey(),
	key: text('key').notNull().unique(),
	count: integer('count').notNull(),
	lastRequest: integer('last_request').notNull(),
});

/**
 * Per-user API keys, scoped to one workspace. Only a SHA-256 of the key is stored;
 * `prefix` (the first characters of the key) is what the UI shows.
 */
export const apiKeys = sqliteTable(
	'api_keys',
	{
		id: text('id').primaryKey(),
		workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
		user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		prefix: text('prefix').notNull(),
		key_hash: text('key_hash').notNull().unique(),
		created_at: integer('created_at').notNull().default(now),
		last_used_at: integer('last_used_at'),
		expires_at: integer('expires_at'),
		revoked_at: integer('revoked_at'),
	},
	(t) => [index('idx_api_keys_workspace').on(t.workspace_id), index('idx_api_keys_user').on(t.user_id)],
);

// ── Hosted (SaaS) intake ────────────────────────────────────

/**
 * Per-domain intake token for the central report address (`rua+<token>@rua.<intake domain>`).
 * Only the SHA-256 of the token is stored. Rotation keeps the previous hash valid until
 * `prev_expires_at` so reports already in flight (receivers cache the rua address) still arrive.
 * Looked up by hash before the workspace is known (queries/intake.ts).
 */
export const intakeTokens = sqliteTable(
	'intake_tokens',
	{
		domain_id: integer('domain_id').primaryKey().references(() => domains.id, { onDelete: 'cascade' }),
		workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
		token_hash: text('token_hash').notNull().unique(),
		prev_token_hash: text('prev_token_hash'),
		prev_expires_at: integer('prev_expires_at'),
		created_at: integer('created_at').notNull().default(now),
		rotated_at: integer('rotated_at'),
	},
	(t) => [index('idx_intake_tokens_workspace').on(t.workspace_id), index('idx_intake_tokens_prev').on(t.prev_token_hash)],
);

/**
 * A domain's records in the operator's hosted-records zone (`<hosted_id>._dmarc.h.<zone>`, …).
 * `hosted_id` is opaque and never derived from the customer domain. The `*_pointer` columns hold the
 * last verification of the records the customer adds in their own DNS.
 */
export const hostedDomains = sqliteTable(
	'hosted_domains',
	{
		domain_id: integer('domain_id').primaryKey().references(() => domains.id, { onDelete: 'cascade' }),
		workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
		hosted_id: text('hosted_id').notNull().unique(),
		/** Which hosted zone holds the records (the shard seam; see src/hosted/zones.ts). */
		zone_key: text('zone_key').notNull(),
		dmarc_record_id: text('dmarc_record_id'),
		spf_record_id: text('spf_record_id'),
		mta_sts_txt_record_id: text('mta_sts_txt_record_id'),
		mta_sts_host_record_id: text('mta_sts_host_record_id'),
		tls_rpt_record_id: text('tls_rpt_record_id'),
		/** The customer's own SPF record at enable time: what the hosted (flattened) record is built from. */
		spf_source: text('spf_source'),
		dmarc_pointer: text('dmarc_pointer'),
		spf_pointer: text('spf_pointer'),
		mta_sts_pointer: text('mta_sts_pointer'),
		tls_rpt_pointer: text('tls_rpt_pointer'),
		pointers_checked_at: integer('pointers_checked_at'),
		created_at: integer('created_at').notNull().default(now),
	},
	(t) => [index('idx_hosted_domains_workspace').on(t.workspace_id)],
);

/** Record counts of the operator's hosted-records zone(s): quota tracking and the daily diff. */
export const hostedZones = sqliteTable('hosted_zones', {
	zone_key: text('zone_key').primaryKey(),
	zone_id: text('zone_id').notNull(),
	zone_name: text('zone_name').notNull(),
	/** Every record in the zone, ours or not: the plan limit counts them all. */
	record_count: integer('record_count').notNull().default(0),
	/** Digest of the records outside the hosted label, to notice changes we did not make. */
	rest_digest: text('rest_digest'),
	checked_at: integer('checked_at'),
});

/** Addresses handed out for the anonymous free check. Only the hash is kept; single use. */
export const canaryTokens = sqliteTable(
	'canary_tokens',
	{
		token_hash: text('token_hash').primaryKey(),
		created_at: integer('created_at').notNull().default(now),
		expires_at: integer('expires_at').notNull(),
		used_at: integer('used_at'),
	},
	(t) => [index('idx_canary_tokens_expires').on(t.expires_at)],
);

/**
 * A remote Cloudflare revoke that failed while its workspace was deleted. Global (the workspace is gone);
 * the cron retries until the grant is revoked or it gives up. See src/lifecycle/revoke.ts.
 */
export const revocationTombstones = sqliteTable(
	'revocation_tombstones',
	{
		id: text('id').primaryKey(),
		deleted_workspace_id: text('deleted_workspace_id').notNull(),
		connection_id: text('connection_id').notNull(),
		cf_account_id: text('cf_account_id'),
		token_envelope: text('token_envelope').notNull(),
		attempts: integer('attempts').notNull().default(0),
		last_error: text('last_error'),
		last_attempt_at: integer('last_attempt_at'),
		created_at: integer('created_at').notNull().default(now),
	},
	(t) => [index('idx_revocation_tombstones_created').on(t.created_at)],
);

// ── Cloudflare connections ──────────────────────────────────

export const CF_AUTH_TYPES = ['oauth', 'token'] as const;
export const CF_CONNECTION_STATUSES = ['active', 'broken', 'revoked'] as const;
export type CfAuthType = (typeof CF_AUTH_TYPES)[number];
export type CfConnectionStatus = (typeof CF_CONNECTION_STATUSES)[number];

/**
 * A Cloudflare account an Inbox Angel workspace has connected (OAuth, or a pasted API token). One workspace
 * can hold several. `token_envelope` is the AES-GCM envelope of {access, refresh, expires_at}
 * (src/connections/crypto.ts): the plaintext token is never stored, and list queries never select the column.
 */
export const cloudflareConnections = sqliteTable(
	'cloudflare_connections',
	{
		id: text('id').primaryKey(),
		workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
		label: text('label').notNull(),
		cf_account_id: text('cf_account_id'),
		cf_account_name: text('cf_account_name'),
		auth_type: text('auth_type', { enum: CF_AUTH_TYPES }).notNull(),
		token_envelope: text('token_envelope').notNull(),
		scopes: text('scopes'),
		status: text('status', { enum: CF_CONNECTION_STATUSES }).notNull().default('active'),
		status_detail: text('status_detail'),
		created_by: text('created_by'),
		created_at: integer('created_at').notNull().default(now),
		last_used_at: integer('last_used_at'),
	},
	(t) => [
		index('idx_cf_connections_workspace').on(t.workspace_id),
		check('cf_connections_auth_type_check', sql`${t.auth_type} IN ('oauth', 'token')`),
		check('cf_connections_status_check', sql`${t.status} IN ('active', 'broken', 'revoked')`),
	],
);

/**
 * The zones Inbox Angel may manage through a connection. Cloudflare consent is per Cloudflare account,
 * not per zone, so the owner picks the zones here and every call is checked against this list.
 * A connection with no rows may touch no zone.
 */
export const cloudflareConnectionZones = sqliteTable(
	'cloudflare_connection_zones',
	{
		connection_id: text('connection_id').notNull().references(() => cloudflareConnections.id, { onDelete: 'cascade' }),
		workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
		zone_id: text('zone_id').notNull(),
		zone_name: text('zone_name').notNull(),
		/** The Cloudflare account that owns the zone (from Cloudflare when the zone was allowed): what `/accounts/*` calls are checked against. */
		cf_account_id: text('cf_account_id'),
		created_at: integer('created_at').notNull().default(now),
	},
	(t) => [
		primaryKey({ columns: [t.connection_id, t.zone_id] }),
		index('idx_cf_connection_zones_workspace').on(t.workspace_id),
	],
);

/**
 * Zones that sit below an allowed zone but are NOT on the allow-list, as seen when the list was saved.
 * A child zone is delegated, so a record written for a name inside it in the parent zone is shadowed and
 * has no effect: such names are refused (with the blocking zone named) instead of written to the parent.
 */
export const cloudflareConnectionBlockedZones = sqliteTable(
	'cloudflare_connection_blocked_zones',
	{
		connection_id: text('connection_id').notNull().references(() => cloudflareConnections.id, { onDelete: 'cascade' }),
		workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
		zone_id: text('zone_id').notNull(),
		zone_name: text('zone_name').notNull(),
		created_at: integer('created_at').notNull().default(now),
	},
	(t) => [
		primaryKey({ columns: [t.connection_id, t.zone_id] }),
		index('idx_cf_connection_blocked_workspace').on(t.workspace_id),
	],
);

/**
 * Tables with no workspace_id, and why. `test/workspace-predicates.test.ts` uses
 * this list: anything else that is tenant data must be scoped.
 */
export const GLOBAL_TABLES = {
	workspaces: 'the tenant registry itself',
	users: 'a user can belong to several workspaces; membership carries the role',
	check_results: 'anonymous public free-check results, not tenant data',
	ip_info: 'shared public IP-metadata cache',
	password_reset_tokens: 'keyed by user_id, which is global (superseded by verifications)',
	sessions: 'keyed by user; a session is resolved to a workspace through memberships',
	auth_accounts: 'login methods of a user (password / OAuth link), keyed by user',
	verifications: 'one-time auth tokens (password reset), keyed by identifier',
	auth_rate_limits: 'auth endpoint rate-limit counters, keyed by IP and path',
	hosted_zones: 'operator-owned: record counts of the hosted-records zone(s), not tenant data',
	revocation_tombstones: 'failed Cloudflare revocations of deleted workspaces; the workspace row is gone by design',
	canary_tokens: 'anonymous free-check (canary) addresses, expiring, not tied to any workspace',
} as const;

/** Tables that must carry an `workspace_id` column. */
export const WORKSPACE_OWNED_TABLES = [
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
	'api_keys',
	'intake_tokens',
	'hosted_domains',
	'cloudflare_connections',
	'cloudflare_connection_zones',
	'cloudflare_connection_blocked_zones',
] as const;
