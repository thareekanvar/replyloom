ALTER TABLE `conversations` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `muted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `reactions` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `edited_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `deleted` integer DEFAULT false NOT NULL;