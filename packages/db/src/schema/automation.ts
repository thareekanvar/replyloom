import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./tenancy";
import { waSessions } from "./sessions";

export const autoReplyRules = sqliteTable(
  "auto_reply_rules",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    // null = applies to every session in the workspace
    waSessionId: text("wa_session_id").references(() => waSessions.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    matchType: text("match_type", { enum: ["exact", "contains", "regex"] }).notNull().default("contains"),
    context: text("context", { enum: ["group", "private", "all"] }).notNull().default("all"),
    replyText: text("reply_text"),
    mediaKey: text("media_key"),
    priority: integer("priority").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("auto_reply_session_enabled_idx").on(t.waSessionId, t.enabled, t.priority),
    index("auto_reply_workspace_enabled_idx").on(t.workspaceId, t.enabled, t.priority),
  ],
);

// Whitelist/blacklist for bot commands and auto-replies (per session or
// workspace-wide), keyed by jid.
export const accessRules = sqliteTable(
  "access_rules",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    waSessionId: text("wa_session_id").references(() => waSessions.id, { onDelete: "cascade" }),
    listType: text("list_type", { enum: ["whitelist", "blacklist"] }).notNull(),
    scope: text("scope", { enum: ["bot_commands", "auto_reply"] }).notNull(),
    jid: text("jid").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  // isBlocked queries WHERE scope = ? AND (wa_session_id = ? OR wa_session_id
  // IS NULL) — the existing index starts with wa_session_id and can't serve it.
  (t) => [
    index("access_rules_lookup_idx").on(t.waSessionId, t.scope, t.listType),
    index("access_rules_scope_idx").on(t.scope, t.waSessionId),
    index("access_rules_workspace_scope_idx").on(t.workspaceId, t.scope),
  ],
);
