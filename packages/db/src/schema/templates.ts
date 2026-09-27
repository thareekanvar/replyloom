import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./tenancy";

// Message templates -- reusable text (with {{variable}} placeholders) plus
// an optional attachment, sent as a normal outbound message (no WhatsApp
// "template" approval flow, since we're on Baileys, not the Cloud API).
// Every template shows up in both the composer's template picker
// (quick-insert / send mid-conversation) and the broadcast campaign dialog
// (resolved per-recipient at send time, see apps/worker/src/broadcast.ts).
export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Optional "/shortcut" for quick-insert in the composer -- stored
    // without the leading slash, nullable (SQLite treats NULLs as
    // distinct in a unique index, same convention as elsewhere in this
    // schema), so most templates don't need one.
    shortcut: text("shortcut"),
    body: text("body"),
    mediaKey: text("media_key"), // R2 object key -- shared by every message sent from this template
    mediaMime: text("media_mime"),
    mediaType: text("media_type", { enum: ["image", "video", "audio", "document"] }),
    usageCount: integer("usage_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("templates_workspace_shortcut_idx").on(t.workspaceId, t.shortcut),
    // Templates screen: keyset by (updated_at, id) DESC.
    index("templates_workspace_updated_idx").on(t.workspaceId, sql`updated_at DESC`, sql`id DESC`),
  ],
);
