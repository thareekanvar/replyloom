CREATE TABLE `agent_configs` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`business_name` text,
	`scope_description` text,
	`classifier_model` text,
	`generator_model` text,
	`embedding_model` text,
	`max_context_chunks` integer DEFAULT 4 NOT NULL,
	`similarity_threshold` real DEFAULT 0.72 NOT NULL,
	`cache_ttl_seconds` integer DEFAULT 3600 NOT NULL,
	`reply_in_groups` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_escalations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text,
	`remote_jid` text,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_escalations_workspace_idx` ON `agent_escalations` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_webhook_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`parameters_json` text DEFAULT '{}' NOT NULL,
	`url` text NOT NULL,
	`method` text DEFAULT 'POST' NOT NULL,
	`auth_token` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_webhook_tools_workspace_idx` ON `agent_webhook_tools` (`workspace_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `agent_webhook_tools_name_idx` ON `agent_webhook_tools` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `doc_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`doc_id` text,
	`source` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `doc_chunks_workspace_idx` ON `doc_chunks` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `doc_chunks_doc_idx` ON `doc_chunks` (`workspace_id`,`doc_id`);