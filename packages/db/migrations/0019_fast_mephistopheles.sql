-- Before this fix, syncIncomingMessage's onConflictDoNothing() had no
-- matching unique index, so it silently allowed duplicate rows for the
-- same WhatsApp message (retries, reconnect replays, the same
-- messages.upsert batch processed twice all inserted separate rows).
-- De-dupe any duplicates already sitting in the table -- keeping the
-- earliest row (lowest rowid) per (conversation_id, wa_message_id) --
-- before adding the unique index below, otherwise CREATE UNIQUE INDEX
-- fails outright on a table that already has duplicates.
DELETE FROM `messages`
WHERE `wa_message_id` IS NOT NULL
  AND `rowid` NOT IN (
    SELECT MIN(`rowid`)
    FROM `messages`
    WHERE `wa_message_id` IS NOT NULL
    GROUP BY `conversation_id`, `wa_message_id`
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_wa_message_idx` ON `messages` (`conversation_id`,`wa_message_id`);
