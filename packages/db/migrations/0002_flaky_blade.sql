ALTER TABLE `wa_sessions` ADD `daily_broadcast_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wa_sessions` ADD `daily_broadcast_reset_at` integer;--> statement-breakpoint
ALTER TABLE `wa_sessions` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wa_sessions` ADD `broadcast_paused_until` integer;--> statement-breakpoint
ALTER TABLE `broadcast_recipients` ADD `attempts` integer DEFAULT 0 NOT NULL;