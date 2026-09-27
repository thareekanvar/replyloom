import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./tenancy";

// The media "gallery" -- assets uploaded once (via POST /media/upload)
// and reusable across templates/broadcasts without re-uploading. A
// template's own mediaKey/mediaMime/mediaType (see ./templates.ts) is
// still what a message send actually reads; this table exists purely so
// the workspace has a browsable, named catalog of what's already in R2
// instead of every upload being an opaque, template-only key.
export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    mediaKey: text("media_key").notNull(),
    mediaMime: text("media_mime").notNull(),
    mediaType: text("media_type", { enum: ["image", "video", "audio", "document"] }).notNull(),
    fileName: text("file_name"),
    fileSizeBytes: integer("file_size_bytes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("media_assets_workspace_created_idx").on(t.workspaceId, sql`created_at DESC`, sql`id DESC`)],
);
