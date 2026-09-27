ALTER TABLE `contacts` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `pinned_at` integer;--> statement-breakpoint
CREATE INDEX `conversations_workspace_pinned_idx` ON `conversations` (`workspace_id`,`pinned_at`,`last_message_at`);