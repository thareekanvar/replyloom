// wa_sessions row lookups/updates -- workspace resolution and connection
// status, independent of message/contact syncing.
import {  eq, waSessions } from "@workspace/db";
import type {Db} from "@workspace/db";

export async function getSessionWorkspaceId(db: Db, waSessionId: string): Promise<string | null> {
  const row = await db
    .select({ workspaceId: waSessions.workspaceId })
    .from(waSessions)
    .where(eq(waSessions.id, waSessionId))
    .get();
  return row?.workspaceId ?? null;
}

export async function markSessionStatus(
  db: Db,
  waSessionId: string,
  status: "idle" | "connecting" | "qr" | "authenticated" | "connected" | "disconnected" | "close",
  extra?: { connectedJid?: string; phoneNumber?: string }
) {
  await db
    .update(waSessions)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(eq(waSessions.id, waSessionId));
}
