-- Merges WhatsApp contacts (and their conversations/messages) that were
-- split into two rows because incoming messages arrived under a @lid JID
-- while outgoing messages / contact sync used the resolved phone-number
-- JID. Fixed going forward by findOrCreateContact() in
-- apps/worker/src/db/sync.ts (phone number is now the primary match key);
-- this script is the one-time cleanup for conversations that were ALREADY
-- split before that fix landed.
--
-- Safe to run more than once (idempotent — a second run finds nothing left
-- to merge). Groups only by phone_number, so group chats/participants are
-- untouched.
--
-- BACK UP FIRST, especially before --remote:
--   wrangler d1 export whatsapp-ai --remote --output=backup-before-merge.sql
--
-- Then run (from apps/worker, or anywhere with wrangler + this repo's
-- wrangler.jsonc):
--   wrangler d1 execute whatsapp-ai --local  --file=../../packages/db/scripts/merge-duplicate-contacts.sql
--   wrangler d1 execute whatsapp-ai --remote --file=../../packages/db/scripts/merge-duplicate-contacts.sql
--
-- Recommended: run --local first and check your inbox looks right before
-- touching --remote.

DROP TABLE IF EXISTS _contact_keep;
DROP TABLE IF EXISTS _contact_merge;

-- One "keep" row per (wa_session_id, phone_number): the oldest contact.
CREATE TEMP TABLE _contact_keep AS
SELECT wa_session_id, phone_number, MIN(id) AS keep_id
FROM (
  SELECT id, wa_session_id, phone_number,
         ROW_NUMBER() OVER (
           PARTITION BY wa_session_id, phone_number
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM contacts
  WHERE phone_number IS NOT NULL
)
WHERE rn = 1
GROUP BY wa_session_id, phone_number;

-- Every other contact row sharing that (session, phone_number) — the
-- duplicates to fold into the keeper.
CREATE TEMP TABLE _contact_merge AS
SELECT c.id AS dup_id, k.keep_id AS keep_id
FROM contacts c
JOIN _contact_keep k
  ON c.wa_session_id = k.wa_session_id AND c.phone_number = k.phone_number
WHERE c.id <> k.keep_id;

-- Backfill any field the keeper is missing from a duplicate before it's
-- deleted (e.g. keeper came from an @lid message with no name yet, the
-- duplicate came from contacts.upsert and does have one).
UPDATE contacts
SET
  lid = COALESCE(contacts.lid, (SELECT d.lid FROM contacts d WHERE d.id = (SELECT dup_id FROM _contact_merge WHERE keep_id = contacts.id LIMIT 1))),
  name = COALESCE(contacts.name, (SELECT d.name FROM contacts d WHERE d.id = (SELECT dup_id FROM _contact_merge WHERE keep_id = contacts.id LIMIT 1))),
  verified_name = COALESCE(contacts.verified_name, (SELECT d.verified_name FROM contacts d WHERE d.id = (SELECT dup_id FROM _contact_merge WHERE keep_id = contacts.id LIMIT 1))),
  avatar_url = COALESCE(contacts.avatar_url, (SELECT d.avatar_url FROM contacts d WHERE d.id = (SELECT dup_id FROM _contact_merge WHERE keep_id = contacts.id LIMIT 1))),
  updated_at = unixepoch()
WHERE id IN (SELECT keep_id FROM _contact_merge);

-- Move every message from a duplicate's conversation into the keeper's
-- conversation, where the keeper already has one of its own (the usual
-- case — that's the bug itself).
UPDATE messages
SET conversation_id = (
  SELECT keep_conv.id
  FROM conversations keep_conv, conversations dup_conv, _contact_merge m
  WHERE dup_conv.id = messages.conversation_id
    AND dup_conv.contact_id = m.dup_id
    AND keep_conv.contact_id = m.keep_id
    AND keep_conv.wa_session_id = dup_conv.wa_session_id
)
WHERE conversation_id IN (
  SELECT dup_conv.id
  FROM conversations dup_conv, _contact_merge m
  WHERE dup_conv.contact_id = m.dup_id
    AND EXISTS (
      SELECT 1 FROM conversations keep_conv
      WHERE keep_conv.contact_id = m.keep_id
        AND keep_conv.wa_session_id = dup_conv.wa_session_id
    )
);

-- Delete the now-empty duplicate conversations from step above.
DELETE FROM conversations
WHERE id IN (
  SELECT dup_conv.id
  FROM conversations dup_conv, _contact_merge m
  WHERE dup_conv.contact_id = m.dup_id
    AND EXISTS (
      SELECT 1 FROM conversations keep_conv
      WHERE keep_conv.contact_id = m.keep_id
        AND keep_conv.wa_session_id = dup_conv.wa_session_id
    )
);

-- Any remaining duplicate conversations (keeper had none yet) just get
-- repointed to the keeper contact instead of being deleted.
UPDATE conversations
SET contact_id = (SELECT keep_id FROM _contact_merge WHERE dup_id = conversations.contact_id)
WHERE contact_id IN (SELECT dup_id FROM _contact_merge);

-- Finally, delete the duplicate contact rows themselves.
DELETE FROM contacts WHERE id IN (SELECT dup_id FROM _contact_merge);

DROP TABLE _contact_keep;
DROP TABLE _contact_merge;
