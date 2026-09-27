CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`shortcut` text,
	`body` text,
	`media_key` text,
	`media_mime` text,
	`media_type` text,
	`category` text DEFAULT 'both' NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `templates_workspace_category_idx` ON `templates` (`workspace_id`,`category`);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_workspace_shortcut_idx` ON `templates` (`workspace_id`,`shortcut`);
