import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { organization } from "./auth";

// Domain-naming bridge: the rest of this schema (and the whole app) talks
// about "workspaces" and "users" — that's the CRM's own vocabulary and
// what every other schema file's foreign keys reference. Better Auth's
// organization plugin owns the actual tables under its own names
// (organization/user, see ./auth.ts) since Better Auth's adapter matches
// against those names specifically. Re-exporting under our names here
// means every other file in this package never has to know Better Auth is
// what's behind "a workspace" or "a user".
export { organization as workspaces, user as users } from "./auth";

// CRM-specific, not part of Better Auth's own schema.
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // SHA-256 hex of the live key. The raw key is shown exactly once, at
    // creation time (see createApiKey in apps/web) and never stored.
    keyHash: text("key_hash").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  // The engine authenticates every external API-key request by hashing the
  // bearer token and looking it up by key_hash.
  (t) => [
    index("api_keys_workspace_idx").on(t.workspaceId),
    index("api_keys_hash_idx").on(t.keyHash),
  ],
);

// Single-row-per-key token bucket for the auth endpoints. Backed by shared
// D1 (both workers already point at it) so no extra KV wiring is needed.
export const authRateLimits = sqliteTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: integer("reset_at", { mode: "timestamp" }).notNull(),
});
