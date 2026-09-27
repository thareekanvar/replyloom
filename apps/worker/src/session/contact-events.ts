// Turns Baileys' contacts.upsert / messaging-history.set payloads
// (contacts + group chats) into D1 rows. Pulled out of
// whatsapp-session.ts alongside message-events.ts for the same reason.
import {  conversations } from "@workspace/db";
import type {Db} from "@workspace/db";
import { upsertContactMapping, upsertGroupMetadata, upsertGroupMembers, extractPhoneNumber, bulkUpsertContacts } from "../db/sync";

type LogFn = (level: "info" | "warn" | "error", msg: string) => void;

/** Baileys Chat.conversationTimestamp is seconds (same as messageTimestamp). */
function chatTimestampMs(chat: any): Date | null {
  const ts = chat?.conversationTimestamp ?? chat?.lastMessageTimestamp;
  if (!ts) return null;
  const ms = Number(ts) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

/**
 * Ensure a conversation row exists for a direct (1:1) chat from
 * `messaging-history.set`'s `hist.chats`, even when that batch carried no
 * messages for it. Without this, WhatsApp could send 100 chats but only a
 * couple of messages — and the inbox would only ever show the 2 chats that
 * had a message, which is exactly what users reported after connecting.
 */
export async function syncDirectChatsFromHistory(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  chats: any[],
  log: LogFn
): Promise<void> {
  const direct = chats.filter(
    (c) =>
      c?.id &&
      !c.id.endsWith("@g.us") &&
      !c.id.endsWith("@broadcast") &&
      !c.id.endsWith("@newsletter")
  );
  if (!direct.length) return;
  log("info", `Ensuring ${direct.length} direct conversations from history chats...`);
  // Bulk: one preload of the session's contacts, unchanged contacts
  // skipped, writes batched (was 2-5 sequential D1 round trips per chat).
  const stats = await bulkUpsertContacts(
    db,
    workspaceId,
    waSessionId,
    direct.map((chat) => ({
      jid: chat.id,
      lid: chat.lid || null,
      name: chat.name || chat.notify || null,
      notify: chat.notify,
      phoneNumber: extractPhoneNumber({ id: chat.id }),
      avatarUrl: chat.imgUrl || null,
      conversation: { lastMessageAt: chatTimestampMs(chat) },
    }))
  );
  log(
    "info",
    `Ensured ${direct.length - stats.failed}/${direct.length} direct conversations from history chats (${stats.created} new contacts, ${stats.updated} updated, ${stats.unchanged} unchanged)`
  );
}

/** Live `contacts.upsert` event handler body. */
export async function syncContactUpsert(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  contactsList: any[],
  log: LogFn
): Promise<void> {
  // Broadcast lists (`<timestamp>@broadcast`), Status (`status@broadcast`)
  // and Channels (`<id>@newsletter`) show up in this event too -- none are
  // a person (see parseBaileysMessage's matching guard), so they're skipped.
  // Small live batches keep the per-contact path; the big burst right after
  // connecting uses the bulk path.
  if (contactsList.length < 20) {
    for (const c of contactsList) {
      if (!c.id || c.id.endsWith("@broadcast") || c.id.endsWith("@newsletter")) continue;
      try {
        await upsertContactMapping(db, waSessionId, workspaceId, {
          jid: c.id,
          lid: c.lid || null,
          name: c.name || c.notify || c.verifiedName,
          notify: c.notify,
          phoneNumber: extractPhoneNumber(c),
          avatarUrl: c.imgUrl || null,
          verifiedName: c.verifiedName,
        });
      } catch (err: any) {
        log("error", `contacts.upsert failed for ${c.id}: ${err?.message || err}`);
      }
    }
    return;
  }
  const stats = await bulkUpsertContacts(db, workspaceId, waSessionId, contactsList
      .filter((c: any) => c.id && !c.id.endsWith("@broadcast") && !c.id.endsWith("@newsletter"))
      .map((c: any) => ({
        jid: c.id,
        lid: c.lid || null,
        name: c.name || c.notify || c.verifiedName,
        notify: c.notify,
        phoneNumber: extractPhoneNumber(c),
        avatarUrl: c.imgUrl || null,
        verifiedName: c.verifiedName,
      })));
  if (stats.failed) log("error", `contacts.upsert: ${stats.failed} contacts failed`);
}

/**
 * Sync contacts from Baileys `messaging-history.set` event.
 * These come as flat Contact objects with id, name, notify, etc.
 */
export async function syncContactsFromHistory(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  contactsList: any[],
  log: LogFn
): Promise<void> {
  log("info", `Syncing ${contactsList.length} contacts from history...`);
  const stats = await bulkUpsertContacts(db, workspaceId, waSessionId, contactsList
      .filter((c: any) => c.id && !c.id.endsWith("@broadcast") && !c.id.endsWith("@newsletter"))
      .map((c: any) => ({
        jid: c.id,
        lid: c.lid || null,
        name: c.name || c.notify || c.verifiedName,
        notify: c.notify,
        phoneNumber: extractPhoneNumber(c),
        avatarUrl: c.imgUrl || null,
        verifiedName: c.verifiedName,
      })));
  log(
    "info",
    `Synced ${contactsList.length} contacts from history (${stats.created} new, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.failed} failed)`
  );
}

/**
 * Sync group metadata from Baileys `messaging-history.set` event.
 * Group chats arrive as Chat objects with id (@g.us), name (subject), etc.
 */
export async function syncGroupsFromHistory(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  groupChats: any[],
  log: LogFn,
  // Group metadata (name/participant count) always syncs so groups show
  // up in the inbox -- this only gates the participant -> contact
  // resolution loop, which is the actual expensive/write-heavy part (one
  // findOrCreateContact per member, per group). Defaults true so any
  // other caller that doesn't pass it keeps the old behavior.
  syncMembers = true
): Promise<void> {
  log("info", `Syncing ${groupChats.length} groups from history...`);
  for (const g of groupChats) {
    if (!g.id) continue;
    try {
      const group = await upsertGroupMetadata(db, workspaceId, waSessionId, {
        jid: g.id,
        name: g.name || g.subject || null,
        participantCount: g.participants?.length ?? null,
      });
      // Group metadata alone never created a conversation row — only an
      // incoming message did (upsertGroupConversation). So a workspace
      // that connected with syncHistory on still showed zero groups in the
      // inbox until someone spoke in them. Ensure the conversation exists
      // as soon as WhatsApp tells us the group does.
      await db
        .insert(conversations)
        .values({
          workspaceId,
          waSessionId,
          kind: "group",
          groupId: group.id,
          lastMessageAt: chatTimestampMs(g),
        })
        .onConflictDoUpdate({
          target: [conversations.waSessionId, conversations.groupId],
          set: { groupId: group.id },
        });
      if (g.participants?.length && syncMembers) {
        await upsertGroupMembers(db, workspaceId, waSessionId, group.id, g.participants);
      }
    } catch (err: any) {
      log("error", `syncGroupsFromHistory failed for ${g.id}: ${err?.message || err}`);
    }
  }
  log("info", `Synced ${groupChats.length} groups from history${syncMembers ? "" : " (members skipped)"}`);
}
