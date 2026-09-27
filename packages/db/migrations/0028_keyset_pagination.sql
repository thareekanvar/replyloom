DROP INDEX `contacts_workspace_sort_idx`;--> statement-breakpoint
CREATE INDEX `contacts_unpinned_idx` ON `contacts` (`workspace_id`,created_at DESC,id DESC) WHERE pinned_at IS NULL;--> statement-breakpoint
CREATE INDEX `contacts_pinned_idx` ON `contacts` (`workspace_id`,pinned_at DESC,id DESC) WHERE pinned_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `contacts_suppressed_idx` ON `contacts` (`workspace_id`,(CASE WHEN do_not_broadcast_at IS NULL THEN 0 ELSE do_not_broadcast_at END) DESC,id DESC) WHERE do_not_broadcast = 1;--> statement-breakpoint
DROP INDEX `conversations_workspace_last_msg_idx`;--> statement-breakpoint
DROP INDEX `conversations_workspace_sort_idx`;--> statement-breakpoint
CREATE INDEX `conversations_unpinned_idx` ON `conversations` (`workspace_id`,`archived`,(CASE WHEN last_message_at IS NULL THEN 0 ELSE last_message_at END) DESC,id DESC) WHERE pinned_at IS NULL;--> statement-breakpoint
CREATE INDEX `conversations_unread_idx` ON `conversations` (`workspace_id`,`archived`,(CASE WHEN last_message_at IS NULL THEN 0 ELSE last_message_at END) DESC,id DESC) WHERE pinned_at IS NULL AND unread_count > 0;--> statement-breakpoint
CREATE INDEX `conversations_groups_idx` ON `conversations` (`workspace_id`,`archived`,(CASE WHEN last_message_at IS NULL THEN 0 ELSE last_message_at END) DESC,id DESC) WHERE pinned_at IS NULL AND kind = 'group';--> statement-breakpoint
CREATE INDEX `conversations_pinned_idx` ON `conversations` (`workspace_id`,pinned_at DESC,id DESC) WHERE pinned_at IS NOT NULL;--> statement-breakpoint
DROP INDEX `messages_conversation_created_idx`;--> statement-breakpoint
CREATE INDEX `messages_conversation_keyset_idx` ON `messages` (`conversation_id`,created_at DESC,id DESC);--> statement-breakpoint
DROP INDEX `notes_contact_idx`;--> statement-breakpoint
CREATE INDEX `notes_contact_idx` ON `notes` (`contact_id`,created_at DESC,id DESC);--> statement-breakpoint
DROP INDEX `media_assets_workspace_created_idx`;--> statement-breakpoint
CREATE INDEX `media_assets_workspace_created_idx` ON `media_assets` (`workspace_id`,created_at DESC,id DESC);--> statement-breakpoint
DROP INDEX `broadcast_campaigns_workspace_created_idx`;--> statement-breakpoint
CREATE INDEX `broadcast_campaigns_workspace_created_idx` ON `broadcast_campaigns` (`workspace_id`,created_at DESC,id DESC);--> statement-breakpoint
DROP INDEX `contact_list_members_list_ownership_idx`;--> statement-breakpoint
CREATE INDEX `contact_list_members_list_ownership_idx` ON `contact_list_members` (`list_id`,`ownership`,added_at DESC,id DESC);--> statement-breakpoint
CREATE INDEX `groups_workspace_name_idx` ON `groups` (`workspace_id`,`name`,`id`);--> statement-breakpoint
CREATE INDEX `scheduled_messages_workspace_send_idx` ON `scheduled_messages` (`workspace_id`,send_at DESC,id DESC);--> statement-breakpoint
PRAGMA optimize;
