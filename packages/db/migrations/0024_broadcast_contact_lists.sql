CREATE TABLE `contact_list_members` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`ownership` text DEFAULT 'owned' NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `contact_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_list_members_list_contact_idx` ON `contact_list_members` (`list_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `contact_list_members_contact_idx` ON `contact_list_members` (`contact_id`);--> statement-breakpoint
CREATE INDEX `contact_list_members_list_ownership_idx` ON `contact_list_members` (`list_id`,`ownership`);--> statement-breakpoint
CREATE TABLE `contact_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`created_by` text,
	`kind` text DEFAULT 'static' NOT NULL,
	`rule` text,
	`status` text DEFAULT 'active' NOT NULL,
	`usable_after` integer,
	`last_materialized_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `contact_lists_workspace_idx` ON `contact_lists` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `workspace_broadcast_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`recipient_ceiling` integer DEFAULT 500 NOT NULL,
	`cooldown_days` integer DEFAULT 7 NOT NULL,
	`list_sourcing_mode` text DEFAULT 'warn' NOT NULL,
	`list_min_interval_hours` integer DEFAULT 24 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `contacts` ADD `broadcast_list_id` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `broadcast_list_since` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `do_not_broadcast` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `do_not_broadcast_reason` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `do_not_broadcast_at` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `last_broadcast_at` integer;--> statement-breakpoint
CREATE INDEX `contacts_workspace_do_not_broadcast_idx` ON `contacts` (`workspace_id`,`do_not_broadcast`);--> statement-breakpoint
CREATE INDEX `contacts_workspace_last_broadcast_idx` ON `contacts` (`workspace_id`,`last_broadcast_at`);--> statement-breakpoint
CREATE INDEX `contacts_broadcast_list_idx` ON `contacts` (`broadcast_list_id`);--> statement-breakpoint
ALTER TABLE `broadcast_campaigns` ADD `contact_list_id` text;--> statement-breakpoint
ALTER TABLE `broadcast_campaigns` ADD `resolved_recipient_count` integer;--> statement-breakpoint
ALTER TABLE `broadcast_campaigns` ADD `failure_rate_pause_threshold` integer;--> statement-breakpoint
ALTER TABLE `broadcast_campaigns` ADD `paused_for_failure_rate` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `broadcast_campaigns_list_idx` ON `broadcast_campaigns` (`contact_list_id`);