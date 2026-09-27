// Broadcast anti-spam: contact lists are the *only* thing a campaign can
// target (see broadcastCampaigns.contactListId in ./campaigns.ts) -- raw
// contact selection for broadcast is intentionally not supported here.
// Design doc: claude/broadcast-anti-spam-design-2026-09-23.md (project docs).
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces, users } from "./tenancy";
import { contacts } from "./contacts";

export const contactLists = sqliteTable(
  "contact_lists",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["static", "smart"] }).notNull().default("static"),
    // Smart lists only -- a small closed set of filters, compiled to one
    // indexed query when materializing membership (see lib/contact-lists.ts).
    // Never string-interpolated into raw SQL.
    rule: text("rule", { mode: "json" }).$type<{
      field: "organizationName" | "tag" | "lifecycleStage" | "lastContactedAt" | "customField" | "whatsappGroup";
      op: "contains" | "equals" | "before" | "after" | "has_tag" | "member_of";
      /** For whatsappGroup: the groups.id. */
      value: string;
      /** customField only -- the key inside contacts.customFields. */
      key?: string;
    } | null>(),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    // When this list becomes usable for a broadcast. Recomputed from the
    // earliest contact_list_members.addedAt in the list, NOT from
    // createdAt -- an empty list aged for 24h and then dumped full of
    // fresh numbers right before sending must not become immediately
    // usable (see design doc §2, "first list wins" loophole it closes).
    usableAfter: integer("usable_after", { mode: "timestamp" }),
    lastMaterializedAt: integer("last_materialized_at", { mode: "timestamp" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("contact_lists_workspace_idx").on(t.workspaceId, t.status)],
);

export const contactListMembers = sqliteTable(
  "contact_list_members",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    listId: text("list_id").notNull().references(() => contactLists.id, { onDelete: "cascade" }),
    contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    addedAt: integer("added_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    source: text("source", { enum: ["manual", "search", "rule", "import"] }).notNull().default("manual"),
    // Denormalized "first list wins" resolution -- this is what the
    // approved/disabled UI reads directly, no cross-list scan needed.
    // Kept in sync by lib/contact-lists.ts on every membership write.
    ownership: text("ownership", { enum: ["owned", "disabled"] }).notNull().default("owned"),
  },
  (t) => [
    uniqueIndex("contact_list_members_list_contact_idx").on(t.listId, t.contactId),
    index("contact_list_members_contact_idx").on(t.contactId),
    // Approved / disabled tabs page by (added_at, id) DESC; the (list_id,
    // ownership) prefix still serves eligibility + per-list counts.
    index("contact_list_members_list_ownership_idx").on(t.listId, t.ownership, sql`added_at DESC`, sql`id DESC`),
    index("contact_list_members_list_added_idx").on(t.listId, t.addedAt),
  ],
);

// One row per workspace -- anti-ban knobs the workspace can tune within
// hard-coded ceilings (see lib/contact-lists.ts ANTI_BAN_HARD_MAX) so a
// careless/compromised admin can't remove the safety rail entirely.
export const workspaceBroadcastSettings = sqliteTable("workspace_broadcast_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  // Max eligible recipients a single campaign may resolve to before it's
  // refused outright at start time. Workspace-configurable, capped server
  // side (see ANTI_BAN_HARD_MAX).
  recipientCeiling: integer("recipient_ceiling").notNull().default(500),
  // Days a contact must rest after being broadcast to before they're
  // eligible again. One of 2/3/7/14 in the UI; stored as plain days.
  cooldownDays: integer("cooldown_days").notNull().default(7),
  // How list membership sourcing is policed:
  //  - "warn": any contact can join a list; cold/imported ones are flagged.
  //  - "conversation_only": only contacts with an existing conversation.
  //  - "unrestricted": no extra check beyond the ceiling/cooldown.
  listSourcingMode: text("list_sourcing_mode", {
    enum: ["warn", "conversation_only", "unrestricted"],
  })
    .notNull()
    .default("warn"),
  // Minimum interval between two campaigns targeting the same list.
  listMinIntervalHours: integer("list_min_interval_hours").notNull().default(24),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
