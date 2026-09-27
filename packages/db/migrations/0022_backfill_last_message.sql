-- 0021_last_message_denorm.sql added last_body/last_type/last_direction as
-- plain ALTER TABLE ADD columns, which start out NULL on every existing row.
-- syncIncomingMessage only fills them in when a *new* message comes through
-- (see db/sync/messages.ts) -- it has no reason to touch a conversation
-- that already had that exact wa_message_id before this migration ran. So
-- every conversation whose most recent message predates 0021 was stuck
-- showing "No messages yet" in the inbox list despite having real history,
-- until a fresh message happened to land on it. This one-time backfill
-- pulls the latest (non-deleted) message per conversation into the three
-- new columns so existing conversations get a preview immediately instead
-- of waiting on new traffic.
UPDATE `conversations`
SET
  `last_body` = (
    SELECT `body` FROM `messages`
    WHERE `messages`.`conversation_id` = `conversations`.`id` AND `messages`.`deleted` = 0
    ORDER BY `messages`.`created_at` DESC, `messages`.`id` DESC
    LIMIT 1
  ),
  `last_type` = (
    SELECT `type` FROM `messages`
    WHERE `messages`.`conversation_id` = `conversations`.`id` AND `messages`.`deleted` = 0
    ORDER BY `messages`.`created_at` DESC, `messages`.`id` DESC
    LIMIT 1
  ),
  `last_direction` = (
    SELECT `direction` FROM `messages`
    WHERE `messages`.`conversation_id` = `conversations`.`id` AND `messages`.`deleted` = 0
    ORDER BY `messages`.`created_at` DESC, `messages`.`id` DESC
    LIMIT 1
  )
WHERE `last_body` IS NULL
  AND `last_type` IS NULL
  AND EXISTS (
    SELECT 1 FROM `messages`
    WHERE `messages`.`conversation_id` = `conversations`.`id` AND `messages`.`deleted` = 0
  );

-- Belt-and-suspenders: last_message_at predates 0021 and should already be
-- correct for every conversation, but if any row somehow has real messages
-- and a NULL last_message_at, pick it up here too so the list sort/time
-- column isn't left blank alongside the new preview text.
UPDATE `conversations`
SET
  `last_message_at` = (
    SELECT `created_at` FROM `messages`
    WHERE `messages`.`conversation_id` = `conversations`.`id` AND `messages`.`deleted` = 0
    ORDER BY `messages`.`created_at` DESC, `messages`.`id` DESC
    LIMIT 1
  )
WHERE `last_message_at` IS NULL
  AND EXISTS (
    SELECT 1 FROM `messages`
    WHERE `messages`.`conversation_id` = `conversations`.`id` AND `messages`.`deleted` = 0
  );
