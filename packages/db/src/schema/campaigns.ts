import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./tenancy";
import { waSessions } from "./sessions";
import { conversations } from "./conversations";

export const broadcastCampaigns = sqliteTable(
  "broadcast_campaigns",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    waSessionId: text("wa_session_id").notNull().references(() => waSessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    messageText: text("message_text"),
    mediaKey: text("media_key"),
    // Campaigns target a contact list, never raw contact IDs -- the
    // anti-spam controls (ownership, cooldown, suppression) all live on
    // the list-eligibility resolution path. See schema/contact-lists.ts.
    contactListId: text("contact_list_id"),
    // Snapshotted once at campaign start so the UI and the hard-ceiling
    // check both read one number instead of re-counting recipients.
    resolvedRecipientCount: integer("resolved_recipient_count"),
    // Denormalized counters, bumped atomically by the queue consumer, so the
    // campaigns page and the failure-rate breaker never re-aggregate
    // broadcast_recipients (O(recipients) per read). pending = resolved - sent - failed.
    sentCount: integer("sent_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    status: text("status", { enum: ["draft", "scheduled", "running", "completed", "failed"] })
      .notNull()
      .default("draft"),
    scheduledAt: integer("scheduled_at", { mode: "timestamp" }),
    // Campaign-level circuit breaker (independent of the session-wide one
    // in wa_sessions) -- a spiking failure rate on THIS campaign's own
    // sends pauses it rather than burning through the whole list.
    failureRatePauseThreshold: integer("failure_rate_pause_threshold"),
    pausedForFailureRate: integer("paused_for_failure_rate", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  // Scheduler.earliestDueMs sweeps pending campaigns by (status, scheduled_at).
  (t) => [
    index("broadcast_campaigns_due_idx").on(t.status, t.scheduledAt),
    index("broadcast_campaigns_list_idx").on(t.contactListId),
    index("broadcast_campaigns_workspace_created_idx").on(t.workspaceId, sql`created_at DESC`, sql`id DESC`),
  ],
);

export const broadcastRecipients = sqliteTable(
  "broadcast_recipients",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    campaignId: text("campaign_id").notNull().references(() => broadcastCampaigns.id, { onDelete: "cascade" }),
    contactId: text("contact_id"),
    groupJid: text("group_jid"),
    status: text("status", { enum: ["pending", "sent", "failed"] }).notNull().default("pending"),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    // How many send attempts this recipient has had — caps our own
    // exponential-backoff retries (see handleBroadcastBatch) so a
    // persistently failing number doesn't retry forever.
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [index("broadcast_recipients_campaign_status_idx").on(t.campaignId, t.status)],
);

// Individually scheduled messages (DO alarm per row), independent of
// broadcast campaigns.
export const scheduledMessages = sqliteTable(
  "scheduled_messages",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    waSessionId: text("wa_session_id").notNull().references(() => waSessions.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    toJid: text("to_jid").notNull(),
    body: text("body"),
    mediaKey: text("media_key"),
    sendAt: integer("send_at", { mode: "timestamp" }).notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "cancelled"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("scheduled_messages_due_idx").on(t.status, t.sendAt),
    index("scheduled_messages_workspace_status_idx").on(t.workspaceId, t.status),
    index("scheduled_messages_workspace_send_idx").on(t.workspaceId, sql`send_at DESC`, sql`id DESC`),
  ],
);
