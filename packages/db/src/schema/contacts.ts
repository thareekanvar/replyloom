import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces, users } from "./tenancy";
import { waSessions } from "./sessions";
import { teams } from "./teams";

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    waSessionId: text("wa_session_id").notNull().references(() => waSessions.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    lid: text("lid"),
    phoneNumber: text("phone_number"),
    name: text("name"),
    verifiedName: text("verified_name"),
    avatarUrl: text("avatar_url"),
    // WhatsApp "about" status text -- fetched on demand via Baileys'
    // fetchStatus, not eagerly for every contact (rate-limit/anti-ban, same
    // reasoning as the broadcast throttling in apps/worker/src/broadcast.ts).
    about: text("about"),
    avatarFetchedAt: integer("avatar_fetched_at", { mode: "timestamp" }),
    customFields: text("custom_fields", { mode: "json" }).$type<Record<string, unknown>>(),
    lifecycleStage: text("lifecycle_stage", { enum: ["lead", "active", "customer", "churned"] })
      .notNull()
      .default("lead"),
    assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
    assignedTeamId: text("assigned_team_id").references(() => teams.id, { onDelete: "set null" }),
    lastContactedAt: integer("last_contacted_at", { mode: "timestamp" }),
    // Non-null = pinned/starred (and when), null = not pinned — same
    // nullable-timestamp convention as everywhere else in this schema
    // instead of a separate boolean + separate sort column.
    pinnedAt: integer("pinned_at", { mode: "timestamp" }),
    // When true, incoming messages from this contact are silently dropped —
    // no conversation is created, no auto-reply fires, nothing is synced.
    blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),

    // --- Broadcast anti-spam (see schema/contact-lists.ts) ---
    // Which contact list currently "owns" this contact for broadcast
    // purposes -- "first list wins", set once and only changed by an
    // explicit reassignment action. Denormalized here (rather than
    // resolved by scanning contact_list_members) so reading ownership is
    // a single-row lookup, not a cross-list scan.
    broadcastListId: text("broadcast_list_id"),
    broadcastListSince: integer("broadcast_list_since", { mode: "timestamp" }),
    // Workspace-wide, permanent opt-out -- independent of any list.
    // Checked before any list/ownership/cooldown logic on every send.
    doNotBroadcast: integer("do_not_broadcast", { mode: "boolean" }).notNull().default(false),
    doNotBroadcastReason: text("do_not_broadcast_reason", { enum: ["opted_out", "admin_suppressed", "bounced"] }),
    doNotBroadcastAt: integer("do_not_broadcast_at", { mode: "timestamp" }),
    // Last time any campaign actually sent this contact a message -- drives
    // the per-contact cooldown, independent of list ownership.
    lastBroadcastAt: integer("last_broadcast_at", { mode: "timestamp" }),

    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  // resolveToPhoneJid / findOrCreateContact run on every inbound message and
  // look up by phone_number (and LID fallback) per session — both hot paths
  // were full table scans before these indexes existed.
  (t) => [
    uniqueIndex("contacts_session_jid_idx").on(t.waSessionId, t.jid),
    index("contacts_session_phone_idx").on(t.waSessionId, t.phoneNumber),
    index("contacts_session_lid_idx").on(t.waSessionId, t.lid),
    // Broadcast eligibility resolution: one indexed query filters by
    // workspace + suppression flag, then workspace + cooldown timestamp.
    index("contacts_workspace_do_not_broadcast_idx").on(t.workspaceId, t.doNotBroadcast),
    index("contacts_workspace_last_broadcast_idx").on(t.workspaceId, t.lastBroadcastAt),
    index("contacts_broadcast_list_idx").on(t.broadcastListId),
    // Contacts page keyset pagination: pinned contacts are a small segment
    // loaded with page 1; the rest page by (created_at, id) DESC on plain
    // columns, so `(created_at, id) < (?, ?)` is an index range seek.
    index("contacts_unpinned_idx")
      .on(t.workspaceId, sql`created_at DESC`, sql`id DESC`)
      .where(sql`pinned_at IS NULL`),
    index("contacts_pinned_idx")
      .on(t.workspaceId, sql`pinned_at DESC`, sql`id DESC`)
      .where(sql`pinned_at IS NOT NULL`),
    // "Do not contact" tab, paged newest-suppressed first.
    index("contacts_suppressed_idx")
      .on(t.workspaceId, sql`(CASE WHEN do_not_broadcast_at IS NULL THEN 0 ELSE do_not_broadcast_at END) DESC`, sql`id DESC`)
      .where(sql`do_not_broadcast = 1`),
  ],
);

export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    waSessionId: text("wa_session_id").notNull().references(() => waSessions.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    name: text("name"),
    participantCount: integer("participant_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("groups_session_jid_idx").on(t.waSessionId, t.jid),
    // Group picker: search + keyset by (name, id).
    index("groups_workspace_name_idx").on(t.workspaceId, t.name, t.id),
  ],
);

export const groupMembers = sqliteTable(
  "group_members",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    waSessionId: text("wa_session_id").notNull().references(() => waSessions.id, { onDelete: "cascade" }),
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    jid: text("jid").notNull(),
    role: text("role", { enum: ["admin", "superadmin", "member"] }).notNull().default("member"),
    joinedAt: integer("joined_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("group_members_session_group_jid_idx").on(t.waSessionId, t.groupId, t.jid),
    index("group_members_group_idx").on(t.groupId),
    index("group_members_contact_idx").on(t.contactId),
  ],
);
