import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./tenancy";

// Per-user notification preferences (desktop alerts, sound). This is a
// personal browser/device setting, not something a workspace admin
// configures for the team, so one row per user is enough even though the
// rest of the schema is workspace-scoped.
export const notificationPreferences = sqliteTable("notification_preferences", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  desktopEnabled: integer("desktop_enabled", { mode: "boolean" }).notNull().default(false),
  soundEnabled: integer("sound_enabled", { mode: "boolean" }).notNull().default(true),
  // Reserved for a future digest email (Resend is already wired for
  // invites) -- stored now so the preference sticks once that ships.
  emailDigestEnabled: integer("email_digest_enabled", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
