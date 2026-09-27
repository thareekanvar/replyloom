DROP INDEX `conversations_workspace_pinned_idx`;--> statement-breakpoint
CREATE INDEX `conversations_workspace_sort_idx` ON `conversations` (`workspace_id`,(pinned_at IS NULL),pinned_at DESC,last_message_at DESC);--> statement-breakpoint
CREATE INDEX `conversations_contact_idx` ON `conversations` (`contact_id`);--> statement-breakpoint
CREATE INDEX `conversations_group_idx` ON `conversations` (`group_id`);--> statement-breakpoint
ALTER TABLE `broadcast_campaigns` ADD `sent_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `broadcast_campaigns` ADD `failed_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `broadcast_campaigns_workspace_created_idx` ON `broadcast_campaigns` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `contacts_workspace_sort_idx` ON `contacts` (`workspace_id`,(pinned_at IS NULL),pinned_at DESC,created_at DESC);--> statement-breakpoint
CREATE INDEX `contact_tags_tag_idx` ON `contact_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX `scheduled_messages_workspace_status_idx` ON `scheduled_messages` (`workspace_id`,`status`);--> statement-breakpoint
UPDATE `broadcast_campaigns` SET
  `sent_count` = (SELECT count(*) FROM `broadcast_recipients` r WHERE r.`campaign_id` = `broadcast_campaigns`.`id` AND r.`status` = 'sent'),
  `failed_count` = (SELECT count(*) FROM `broadcast_recipients` r WHERE r.`campaign_id` = `broadcast_campaigns`.`id` AND r.`status` = 'failed');--> statement-breakpoint
PRAGMA optimize;
