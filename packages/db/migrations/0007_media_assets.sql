CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`media_key` text NOT NULL,
	`media_mime` text NOT NULL,
	`media_type` text NOT NULL,
	`file_name` text,
	`file_size_bytes` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_assets_workspace_created_idx` ON `media_assets` (`workspace_id`,`created_at`);
