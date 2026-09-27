CREATE TABLE `auth_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_idx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `invitation_org_email_idx` ON `invitation` (`organization_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_idx` ON `session` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_idx` ON `user` (`email`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE INDEX `api_keys_workspace_idx` ON `api_keys` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `wa_sessions_workspace_idx` ON `wa_sessions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `contacts_session_phone_idx` ON `contacts` (`wa_session_id`,`phone_number`);--> statement-breakpoint
CREATE INDEX `contacts_session_lid_idx` ON `contacts` (`wa_session_id`,`lid`);--> statement-breakpoint
CREATE INDEX `access_rules_scope_idx` ON `access_rules` (`scope`,`wa_session_id`);--> statement-breakpoint
CREATE INDEX `broadcast_campaigns_due_idx` ON `broadcast_campaigns` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_status_idx` ON `webhook_deliveries` (`status`);--> statement-breakpoint
CREATE INDEX `webhooks_workspace_idx` ON `webhooks` (`workspace_id`);