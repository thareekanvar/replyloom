import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { organization } from "./auth";

// Custom, per-workspace roles. Deliberately NOT wired into Better Auth's
// own organization-plugin role validation (which only accepts a static
// "owner" | "admin" | "member" set, or roles pre-registered in code via
// its access-control API) — a role here is just a name plus a set of
// permission strings that a workspace owner defines at runtime, and
// `member.role` (free text, see ./auth.ts) stores the chosen role's name
// directly. This app doesn't yet gate any UI/server action on
// `permissions` — it's captured now so enforcement can be added later
// without another schema change.
export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    permissions: text("permissions", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    // Owner/Admin/Agent/Viewer are seeded for every new workspace and
    // can't be deleted (though their permission set can still be edited).
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("roles_workspace_name_idx").on(t.workspaceId, t.name)],
);
