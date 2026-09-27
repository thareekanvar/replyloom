import { sqliteTable, text, integer, primaryKey, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces, users } from "./tenancy";
import { contacts } from "./contacts";

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("tags_workspace_name_idx").on(t.workspaceId, t.name)],
);

export const contactTags = sqliteTable(
  "contact_tags",
  {
    contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  // tag_id index: "contacts with tag X" (smart lists) starts from the tag.
  (t) => [primaryKey({ columns: [t.contactId, t.tagId] }), index("contact_tags_tag_idx").on(t.tagId)],
);

export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("notes_contact_idx").on(t.contactId, sql`created_at DESC`, sql`id DESC`)],
);

export const pipelineStages = sqliteTable(
  "pipeline_stages",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    color: text("color").notNull().default("#6366f1"),
  },
  (t) => [index("pipeline_stages_workspace_idx").on(t.workspaceId, t.position)],
);

export const deals = sqliteTable(
  "deals",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: text("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    stageId: text("stage_id").notNull().references(() => pipelineStages.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    valueCents: integer("value_cents").notNull().default(0),
    currency: text("currency").notNull().default("INR"),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  // Per-column keyset pagination on the board: (stage_id, position, id).
  (t) => [
    index("deals_stage_position_idx").on(t.stageId, t.position, t.id),
    // Covering index for the board's per-stage count/value totals (and any
    // workspace-scoped deal read) -- deals had no workspace index at all.
    index("deals_workspace_stage_value_idx").on(t.workspaceId, t.stageId, t.valueCents),
  ],
);
