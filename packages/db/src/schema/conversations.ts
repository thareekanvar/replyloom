import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces, users } from "./tenancy";
import { waSessions } from "./sessions";
import { contacts, groups } from "./contacts";
import { teams } from "./teams";

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    waSessionId: text("wa_session_id").notNull().references(() => waSessions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["direct", "group"] }).notNull(),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["open", "pending", "resolved"] }).notNull().default("open"),
    assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
    assignedTeamId: text("assigned_team_id").references(() => teams.id, { onDelete: "set null" }),
    unreadCount: integer("unread_count").notNull().default(0),
    lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
    // Denormalized last-message preview — avoids the N+1 query that
    // fetches the latest message row per conversation in getConversations.
    lastBody: text("last_body"),
    lastType: text("last_type", { enum: ["text", "image", "video", "audio", "document", "sticker", "poll", "location", "contact"] }),
    lastDirection: text("last_direction", { enum: ["in", "out"] }),
    // Non-null = pinned (and when it was pinned, so pinned rows can still
    // be ordered oldest/newest-pin-first); null = not pinned.
    pinnedAt: integer("pinned_at", { mode: "timestamp" }),
    // Chat-level flags synced from WhatsApp via chatModify
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    muted: integer("muted", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    // Inbox keyset pagination (getConversationsPage). Pinned chats are a
    // small separate segment (conversations_pinned_idx, loaded with page 1);
    // everything else pages by (last_message_at-or-0, id) DESC with a
    // cursor predicate `k <= :k AND (k < :k OR id < :id)` -- a true index
    // range seek at any depth, unlike OFFSET. One partial index per inbox tab
    // that filters on something selective (unread, groups) so those tabs
    // don't walk past thousands of non-matching rows either. Expressions
    // must be unqualified in an index; SQLite still matches Drizzle's
    // qualified column refs in WHERE/ORDER BY against them.
    index("conversations_unpinned_idx")
      .on(t.workspaceId, t.archived, sql`(CASE WHEN last_message_at IS NULL THEN 0 ELSE last_message_at END) DESC`, sql`id DESC`)
      .where(sql`pinned_at IS NULL`),
    index("conversations_unread_idx")
      .on(t.workspaceId, t.archived, sql`(CASE WHEN last_message_at IS NULL THEN 0 ELSE last_message_at END) DESC`, sql`id DESC`)
      .where(sql`pinned_at IS NULL AND unread_count > 0`),
    index("conversations_groups_idx")
      .on(t.workspaceId, t.archived, sql`(CASE WHEN last_message_at IS NULL THEN 0 ELSE last_message_at END) DESC`, sql`id DESC`)
      .where(sql`pinned_at IS NULL AND kind = 'group'`),
    index("conversations_pinned_idx")
      .on(t.workspaceId, sql`pinned_at DESC`, sql`id DESC`)
      .where(sql`pinned_at IS NOT NULL`),
    index("conversations_assigned_idx").on(t.assignedTo, t.status),
    index("conversations_assigned_team_idx").on(t.assignedTeamId, t.status),
    // FK lookups: contacts page / list sourcing join conversations by
    // contact_id alone. The unique (wa_session_id, contact_id) index can't
    // serve that without ANALYZE stats (D1 has none by default) -- the join
    // degraded to a full conversations scan per contact row.
    index("conversations_contact_idx").on(t.contactId),
    index("conversations_group_idx").on(t.groupId),
    // SQLite treats NULLs as distinct in a unique index, so these two
    // constraints don't collide with each other (direct rows have
    // groupId=NULL, group rows have contactId=NULL) — together they give
    // find-or-create on both kinds a real onConflictDoUpdate target.
    uniqueIndex("conversations_session_contact_idx").on(t.waSessionId, t.contactId),
    uniqueIndex("conversations_session_group_idx").on(t.waSessionId, t.groupId),
  ],
);

export interface MediaMeta {
  fileName?: string
  fileSizeBytes?: number
  durationSeconds?: number
  width?: number
  height?: number
  /** true = WhatsApp voice note (push-to-talk), false/undefined = regular audio file. */
  ptt?: boolean
  isAnimated?: boolean
}

export interface Reaction {
  emoji: string
  sender: string
  timestampMs: number
}

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    waMessageId: text("wa_message_id"),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    senderJid: text("sender_jid"),
    type: text("type", { enum: ["text", "image", "video", "audio", "document", "sticker", "poll", "location", "contact"] })
      .notNull()
      .default("text"),
    body: text("body"),
    mediaKey: text("media_key"), // R2 object key — never store blobs in D1
    mediaMime: text("media_mime"),
    // Per-type extras (dimensions, duration, filename, voice-note flag) --
    // a concrete interface rather than Record<string, unknown> so this
    // still passes TanStack Start's return-type serializability check
    // (see MediaMeta in this file / the createContact fix elsewhere).
    mediaMeta: text("media_meta", { mode: "json" }).$type<MediaMeta>(),
    status: text("status", { enum: ["queued", "sent", "delivered", "read", "failed"] })
      .notNull()
      .default("sent"),
    // Reactions on this message (emoji reactions from participants)
    reactions: text("reactions", { mode: "json" }).$type<Reaction[]>(),
    // When the message was edited (null = not edited)
    editedAt: integer("edited_at", { mode: "timestamp" }),
    // Soft delete: message was deleted on WhatsApp
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    // Primary read pattern: "thread for conversation X, newest first".
    // Thread keyset pagination: (created_at, id) DESC. created_at has
    // one-second resolution, so the id tie-breaker is what stops messages
    // sharing a second from being skipped at a page boundary.
    index("messages_conversation_keyset_idx").on(t.conversationId, sql`created_at DESC`, sql`id DESC`),
    // Real de-dupe target for syncIncomingMessage's onConflictDoNothing.
    // wa_message_id alone isn't guaranteed globally unique (Baileys IDs
    // aren't unique across sessions/chats), but paired with the
    // conversation it belongs to, a repeat delivery of the same WhatsApp
    // message (retries, reconnect replays, the same messages.upsert
    // batch processed twice) now actually gets rejected at the DB level
    // instead of silently inserting a duplicate row.
    uniqueIndex("messages_conversation_wa_message_idx").on(t.conversationId, t.waMessageId),
    // Status/reaction/edit/delete sync (updateMessageStatus, upsertMessageReaction,
    // markMessageEdited, markMessageDeleted in db/sync/messages.ts) all look a row
    // up by (workspace_id, wa_message_id) -- WhatsApp fires status receipts
    // (queued->sent->delivered->read) for every message, in every chat, constantly.
    // Without this index those lookups had no usable index prefix (the only other
    // index on this table starts with conversation_id) and fell back to a full
    // table scan of `messages` on every single status update -- this is what was
    // blowing through the D1 daily rows-read quota.
    index("messages_workspace_wa_message_idx").on(t.workspaceId, t.waMessageId),
    // Partial index for markConversationRead: only inbound messages not yet
    // marked read live here, so opening a thread reads just its unread rows
    // (usually 0) instead of walking the whole conversation through
    // the thread index on every open.
    index("messages_unread_inbound_idx")
      .on(t.conversationId, t.createdAt)
      .where(sql`${t.direction} = 'in' AND ${t.status} <> 'read'`),
  ],
);
