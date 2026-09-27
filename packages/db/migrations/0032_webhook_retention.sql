DROP INDEX `webhook_deliveries_status_idx`;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_status_idx` ON `webhook_deliveries` (`status`,`created_at`);