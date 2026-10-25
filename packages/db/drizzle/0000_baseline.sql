CREATE TABLE `aggregate_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`org_name` text NOT NULL,
	`report_id` text NOT NULL,
	`date_begin` integer NOT NULL,
	`date_end` integer NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`pass_count` integer DEFAULT 0 NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`raw_xml` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`workspace_id` text DEFAULT 'ws_default' NOT NULL,
	`reporter_auth` text,
	`reporter_auth_domain` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agg_reports_domain` ON `aggregate_reports` (`domain_id`);--> statement-breakpoint
CREATE INDEX `idx_agg_reports_date` ON `aggregate_reports` (`date_begin`);--> statement-breakpoint
CREATE INDEX `idx_agg_reports_workspace` ON `aggregate_reports` (`workspace_id`,`date_begin`);--> statement-breakpoint
CREATE INDEX `idx_agg_reports_date_end` ON `aggregate_reports` (`date_end`);--> statement-breakpoint
CREATE INDEX `idx_agg_reports_created` ON `aggregate_reports` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agg_reports_raw_xml` ON `aggregate_reports` (`created_at`) WHERE "aggregate_reports"."raw_xml" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `aggregate_reports_domain_id_report_id_unique` ON `aggregate_reports` (`domain_id`,`report_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_workspace` ON `api_keys` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_user` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` text,
	`actor_email` text,
	`actor_type` text DEFAULT 'user' NOT NULL,
	`action` text NOT NULL,
	`resource_type` text,
	`resource_id` text,
	`resource_name` text,
	`before_value` text,
	`after_value` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`workspace_id` text DEFAULT 'ws_default' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_log` ("created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_audit_actor` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_resource` ON `audit_log` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_workspace` ON `audit_log` (`workspace_id`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_auth_accounts_user` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_accounts_provider` ON `auth_accounts` (`provider_id`,`provider_account_id`);--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_rate_limits_key_unique` ON `auth_rate_limits` (`key`);--> statement-breakpoint
CREATE TABLE `canary_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_canary_tokens_expires` ON `canary_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `check_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_email` text NOT NULL,
	`from_domain` text NOT NULL,
	`spf_result` text,
	`spf_domain` text,
	`spf_record` text,
	`dkim_result` text,
	`dkim_domain` text,
	`dmarc_result` text,
	`dmarc_policy` text,
	`dmarc_record` text,
	`overall_status` text NOT NULL,
	`report_sent` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`session_token` text,
	`spf_lookup_count` integer
);
--> statement-breakpoint
CREATE INDEX `idx_check_results_domain` ON `check_results` (`from_domain`);--> statement-breakpoint
CREATE INDEX `idx_check_results_token` ON `check_results` (`session_token`);--> statement-breakpoint
CREATE INDEX `idx_check_results_created` ON `check_results` (`created_at`);--> statement-breakpoint
CREATE TABLE `cloudflare_connection_blocked_zones` (
	`connection_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`zone_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`connection_id`, `zone_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `cloudflare_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cf_connection_blocked_workspace` ON `cloudflare_connection_blocked_zones` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `cloudflare_connection_zones` (
	`connection_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`zone_name` text NOT NULL,
	`cf_account_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`connection_id`, `zone_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `cloudflare_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cf_connection_zones_workspace` ON `cloudflare_connection_zones` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `cloudflare_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`label` text NOT NULL,
	`cf_account_id` text,
	`cf_account_name` text,
	`auth_type` text NOT NULL,
	`token_envelope` text NOT NULL,
	`scopes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`status_detail` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cf_connections_auth_type_check" CHECK("cloudflare_connections"."auth_type" IN ('oauth', 'token')),
	CONSTRAINT "cf_connections_status_check" CHECK("cloudflare_connections"."status" IN ('active', 'broken', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_cf_connections_workspace` ON `cloudflare_connections` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `domain_claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`domain` text NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_checked_at` integer,
	`last_error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "domain_claims_status_check" CHECK("domain_claims"."status" IN ('pending', 'lost'))
);
--> statement-breakpoint
CREATE INDEX `idx_domain_claims_domain` ON `domain_claims` (`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `domain_claims_workspace_id_domain_unique` ON `domain_claims` (`workspace_id`,`domain`);--> statement-breakpoint
CREATE TABLE `domains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`rua_address` text NOT NULL,
	`dmarc_policy` text,
	`dmarc_pct` integer,
	`spf_record` text,
	`auth_record_provisioned` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`dns_record_id` text,
	`rollout_rec_policy` text,
	`rollout_rec_pct` integer,
	`parent_id` integer,
	`is_default` integer DEFAULT 0 NOT NULL,
	`alerts_enabled` integer DEFAULT 1 NOT NULL,
	`spf_lookup_count` integer,
	`workspace_id` text DEFAULT 'ws_default' NOT NULL,
	`cf_connection_id` text,
	`verified_via` text DEFAULT 'legacy' NOT NULL,
	`evicted_at` integer,
	`evicted_name` text,
	FOREIGN KEY (`parent_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cf_connection_id`) REFERENCES `cloudflare_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_domain_unique` ON `domains` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_domains_domain` ON `domains` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_domains_cf_connection` ON `domains` (`cf_connection_id`);--> statement-breakpoint
CREATE INDEX `idx_domains_parent` ON `domains` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_domains_evicted` ON `domains` (`evicted_at`) WHERE "domains"."evicted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_domains_workspace` ON `domains` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_domains_is_default` ON `domains` (`workspace_id`) WHERE "domains"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `hosted_domains` (
	`domain_id` integer PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`hosted_id` text NOT NULL,
	`zone_key` text NOT NULL,
	`dmarc_record_id` text,
	`spf_record_id` text,
	`mta_sts_txt_record_id` text,
	`mta_sts_host_record_id` text,
	`tls_rpt_record_id` text,
	`spf_source` text,
	`dmarc_pointer` text,
	`spf_pointer` text,
	`mta_sts_pointer` text,
	`tls_rpt_pointer` text,
	`pointers_checked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_domains_hosted_id_unique` ON `hosted_domains` (`hosted_id`);--> statement-breakpoint
CREATE INDEX `idx_hosted_domains_workspace` ON `hosted_domains` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `hosted_zones` (
	`zone_key` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	`zone_name` text NOT NULL,
	`record_count` integer DEFAULT 0 NOT NULL,
	`rest_digest` text,
	`checked_at` integer
);
--> statement-breakpoint
CREATE TABLE `intake_tokens` (
	`domain_id` integer PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`prev_token_hash` text,
	`prev_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`rotated_at` integer,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intake_tokens_token_hash_unique` ON `intake_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_intake_tokens_workspace` ON `intake_tokens` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_intake_tokens_prev` ON `intake_tokens` (`prev_token_hash`);--> statement-breakpoint
CREATE TABLE `intake_usage` (
	`domain_id` integer NOT NULL,
	`workspace_id` text NOT NULL,
	`day` text NOT NULL,
	`reporter` text DEFAULT '' NOT NULL,
	`reports` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`domain_id`, `day`, `reporter`),
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`token` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`workspace_id` text DEFAULT 'ws_default' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_invites_workspace` ON `invites` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_invites_expires` ON `invites` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ip_info` (
	`ip` text PRIMARY KEY NOT NULL,
	`reverse_dns` text,
	`base_domain` text,
	`country_code` text,
	`org` text,
	`asn` text,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ip_info_fetched` ON `ip_info` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`domain` text NOT NULL,
	`source` text DEFAULT 'free_check' NOT NULL,
	`check_level` text,
	`check_summary` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_activity_at` integer DEFAULT (unixepoch()) NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`next_send_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`unsubscribed_at` integer,
	`last_sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_email_unique` ON `leads` (`email`);--> statement-breakpoint
CREATE INDEX `idx_leads_due` ON `leads` (`status`,`next_send_at`);--> statement-breakpoint
CREATE INDEX `idx_leads_activity` ON `leads` (`last_activity_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memberships_role_check" CHECK("memberships"."role" IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE INDEX `idx_memberships_user` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `monitor_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`domain` text NOT NULL,
	`session_token` text,
	`spf_record` text,
	`dmarc_policy` text,
	`dmarc_pct` integer,
	`dmarc_record` text,
	`active` integer DEFAULT 1 NOT NULL,
	`last_checked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`workspace_id` text DEFAULT 'ws_default' NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_monitor_active` ON `monitor_subscriptions` (`active`,`last_checked_at`);--> statement-breakpoint
CREATE INDEX `idx_monitor_domain` ON `monitor_subscriptions` (`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_subscriptions_workspace_id_email_domain_unique` ON `monitor_subscriptions` (`workspace_id`,`email`,`domain`);--> statement-breakpoint
CREATE TABLE `mta_sts_config` (
	`domain_id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`mode` text DEFAULT 'testing' NOT NULL,
	`mx_hosts` text DEFAULT '[]' NOT NULL,
	`max_age` integer DEFAULT 86400 NOT NULL,
	`policy_id` text NOT NULL,
	`mta_sts_record_id` text,
	`tls_rpt_record_id` text,
	`cname_record_id` text,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`workspace_id` text DEFAULT 'ws_default' NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mta_sts_workspace` ON `mta_sts_config` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_prt_user` ON `password_reset_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `report_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` integer NOT NULL,
	`source_ip` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`disposition` text NOT NULL,
	`dkim_result` text,
	`dkim_domain` text,
	`spf_result` text,
	`spf_domain` text,
	`header_from` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`reverse_dns` text,
	`base_domain` text,
	`country_code` text,
	`org` text,
	`workspace_id` text DEFAULT 'ws_default' NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `aggregate_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_records_report` ON `report_records` (`report_id`);--> statement-breakpoint
CREATE INDEX `idx_records_ip` ON `report_records` (`source_ip`);--> statement-breakpoint
CREATE INDEX `idx_records_workspace` ON `report_records` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `revocation_tombstones` (
	`id` text PRIMARY KEY NOT NULL,
	`deleted_workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`cf_account_id` text,
	`token_envelope` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_attempt_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_revocation_tombstones_created` ON `revocation_tombstones` (`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`workspace_id` text DEFAULT 'ws_default' NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`workspace_id`, `key`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_settings_reports_domain` ON `settings` (`value`) WHERE "settings"."key" = 'reports_domain' AND "settings"."value" <> '';--> statement-breakpoint
CREATE TABLE `spf_flatten_config` (
	`domain_id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`cf_record_id` text,
	`canonical_record` text NOT NULL,
	`flattened_record` text,
	`ip_count` integer,
	`lookup_count` integer,
	`last_flattened_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`workspace_id` text DEFAULT 'ws_default' NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_spf_flatten_workspace` ON `spf_flatten_config` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `suppression` (
	`email_hash` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tls_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`org_name` text NOT NULL,
	`date_begin` integer NOT NULL,
	`date_end` integer NOT NULL,
	`total_success` integer DEFAULT 0 NOT NULL,
	`total_failure` integer DEFAULT 0 NOT NULL,
	`failure_details` text,
	`raw_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`workspace_id` text DEFAULT 'ws_default' NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tls_reports_domain` ON `tls_reports` (`domain_id`,`date_begin`);--> statement-breakpoint
CREATE INDEX `idx_tls_reports_workspace` ON `tls_reports` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_tls_reports_date_end` ON `tls_reports` (`date_end`);--> statement-breakpoint
CREATE INDEX `idx_tls_reports_created` ON `tls_reports` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tls_reports_raw_json` ON `tls_reports` (`created_at`) WHERE "tls_reports"."raw_json" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tls_reports_domain_id_org_name_date_begin_unique` ON `tls_reports` (`domain_id`,`org_name`,`date_begin`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'member' NOT NULL,
	`session_token` text,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`image` text,
	`updated_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_session` ON `users` (`session_token`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_verifications_identifier` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);

--> statement-breakpoint
CREATE TABLE products (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL, archived_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE product_domains (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
 PRIMARY KEY(product_id, domain_id)
);
CREATE TABLE access_principals (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, disabled_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE access_grants (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 principal_id TEXT NOT NULL REFERENCES access_principals(id) ON DELETE CASCADE,
 product_id TEXT REFERENCES products(id) ON DELETE CASCADE, domain TEXT,
 actions TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
 created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE access_credentials (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 principal_id TEXT NOT NULL REFERENCES access_principals(id) ON DELETE CASCADE,
 name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
 expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER,
 created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

--> statement-breakpoint
CREATE TABLE google_postmaster_connections (
 id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
 token_envelope TEXT,
 status TEXT NOT NULL DEFAULT 'connected',
 last_attempt_at INTEGER,
 last_success_at INTEGER,
 UNIQUE(workspace_id, domain_id)
);
--> statement-breakpoint
CREATE TABLE metric_observations (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES google_postmaster_connections(id) ON DELETE CASCADE,
 domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
 metric TEXT NOT NULL,
 period_start TEXT NOT NULL,
 period_end TEXT NOT NULL,
 source_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY(connection_id, domain_id, metric, period_start, period_end, source_id)
);
--> statement-breakpoint
