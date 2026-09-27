DROP INDEX `deals_stage_position_idx`;--> statement-breakpoint
CREATE INDEX `deals_workspace_stage_value_idx` ON `deals` (`workspace_id`,`stage_id`,`value_cents`);--> statement-breakpoint
CREATE INDEX `deals_stage_position_idx` ON `deals` (`stage_id`,`position`,`id`);