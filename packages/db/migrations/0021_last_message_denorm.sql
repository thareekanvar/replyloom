-- Add denormalized last-message columns to conversations.
-- Eliminates the N+1 query in getConversations/getConversationsPage
-- that fetches the latest message row per conversation.
ALTER TABLE `conversations` ADD `last_body` text;
ALTER TABLE `conversations` ADD `last_type` text;
ALTER TABLE `conversations` ADD `last_direction` text;
