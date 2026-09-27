import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./tenancy";

// One row per connected WhatsApp number. The Durable Object id used by
// apps/worker for the live socket is this row's `id` — keeps engine and
// CRM data pointing at the same identity.
export const waSessions = sqliteTable(
  "wa_sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    phoneNumber: text("phone_number"),
    connectedJid: text("connected_jid"),
    status: text("status", { enum: ["idle", "connecting", "qr", "authenticated", "connected", "disconnected", "close"] }).notNull().default("idle"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),

    // --- Anti-ban broadcast throttling (see apps/worker/src/broadcast.ts) ---
    // Rolling daily send counter for outbound broadcast messages on this
    // number, reset once dailyBroadcastResetAt has passed.
    dailyBroadcastCount: integer("daily_broadcast_count").notNull().default(0),
    dailyBroadcastResetAt: integer("daily_broadcast_reset_at", { mode: "timestamp" }),
    // Consecutive send failures in a row (resets to 0 on any success) — once
    // this crosses the circuit-breaker threshold we pause new sends on this
    // session for a cooldown window instead of hammering a number WhatsApp
    // may already be flagging.
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    broadcastPausedUntil: integer("broadcast_paused_until", { mode: "timestamp" }),
  },
  (t) => [index("wa_sessions_workspace_idx").on(t.workspaceId)],
);
