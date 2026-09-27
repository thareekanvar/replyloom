CREATE TABLE `group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`wa_session_id` text NOT NULL,
	`group_id` text NOT NULL,
	`contact_id` text,
	`jid` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wa_session_id`) REFERENCES `wa_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_members_session_group_jid_idx` ON `group_members` (`wa_session_id`,`group_id`,`jid`);--> statement-breakpoint
CREATE INDEX `group_members_group_idx` ON `group_members` (`group_id`);--> statement-breakpoint
CREATE INDEX `group_members_contact_idx` ON `group_members` (`contact_id`);