PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_broadcast_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`contact_id` text,
	`group_jid` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`sent_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `broadcast_campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_broadcast_recipients`("id", "campaign_id", "contact_id", "group_jid", "status", "sent_at", "attempts") SELECT "id", "campaign_id", "contact_id", "group_jid", "status", "sent_at", "attempts" FROM `broadcast_recipients`;--> statement-breakpoint
DROP TABLE `broadcast_recipients`;--> statement-breakpoint
ALTER TABLE `__new_broadcast_recipients` RENAME TO `broadcast_recipients`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `broadcast_recipients_campaign_status_idx` ON `broadcast_recipients` (`campaign_id`,`status`);