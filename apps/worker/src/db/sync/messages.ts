// Parses a raw Baileys message into our own shape and persists it
// (message row + conversation/contact upsert + unread bump), for both
// live messages.upsert events and messaging-history.set backfill.
import {
  
  eq,
  and,
  inArray,
  sql,
  conversations,
  messages,
  groups,
  contacts,
  matchesStopKeyword
  
  
} from "@workspace/db";
import type {Db, MediaMeta, Reaction} from "@workspace/db";
import { findOrCreateContact } from "./contacts";
import { resolveToPhoneJid } from "./jid";

export type IncomingType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "poll"
  | "location"
  | "contact";
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";

/**
 * Translate Baileys' numeric status enum into the status used by the inbox.
 * proto.WebMessageInfo.Status (WAProto/index.d.ts): ERROR=0, PENDING=1,
 * SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5. This used to be shifted
 * by one (2 -> delivered, 3 -> read), so every sent message showed double
 * ticks on server ack and blue ticks as soon as it was merely delivered.
 */
export function messageStatusFromBaileys(status: number): MessageStatus | null {
  const statusMap: Record<number, MessageStatus> = {
    0: "failed",
    1: "queued",
    2: "sent",
    3: "delivered",
    4: "read",
    5: "read", // PLAYED (voice note / video listened to) -- still blue ticks
  };
  return statusMap[status] ?? null;
}

// Receipts arrive out of order (read before delivered, replays on
// reconnect, our own messages.upsert echo) -- a status may only move
// forward. `failed` is only allowed before the server acked the message.
const STATUS_ADVANCES_FROM: Record<MessageStatus, MessageStatus[]> = {
  queued: [],
  sent: ["queued"],
  delivered: ["queued", "sent"],
  read: ["queued", "sent", "delivered"],
  failed: ["queued"],
};

// D1 caps bound parameters at 100 per statement; workspace_id + up to 3
// status values leaves room for 90 ids.
const STATUS_UPDATE_CHUNK = 90;

/**
 * Persist WhatsApp receipts without allowing updates across workspaces or
 * status downgrades. One UPDATE per chunk of ids (Baileys delivers a receipt
 * for many messages at once), each an index SEARCH on
 * messages_workspace_wa_message_idx. Returns the rows that actually changed
 * (stale/duplicate receipts and not-yet-synced messages return nothing).
 */
export async function updateMessageStatus(
  db: Db,
  workspaceId: string,
  waMessageIds: string | string[],
  status: MessageStatus
): Promise<{ id: string; conversationId: string; waMessageId: string | null }[]> {
  const from = STATUS_ADVANCES_FROM[status];
  const ids = [...new Set(Array.isArray(waMessageIds) ? waMessageIds : [waMessageIds])];
  if (from.length === 0 || ids.length === 0) return [];
  const changed: { id: string; conversationId: string; waMessageId: string | null }[] = [];
  for (let i = 0; i < ids.length; i += STATUS_UPDATE_CHUNK) {
    const chunk = ids.slice(i, i + STATUS_UPDATE_CHUNK);
    const rows = await db
      .update(messages)
      .set({ status })
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          chunk.length === 1 ? eq(messages.waMessageId, chunk[0]) : inArray(messages.waMessageId, chunk),
          inArray(messages.status, from)
        )
      )
      .returning({ id: messages.id, conversationId: messages.conversationId, waMessageId: messages.waMessageId })
      .all();
    changed.push(...rows);
  }
  return changed;
}

export interface ParsedMessage {
  waMessageId: string;
  remoteJid: string;
  participant?: string;
  fromMe: boolean;
  type: IncomingType;
  body?: string;
  pushName?: string;
  timestampMs: number;
  // Filled in separately by apps/worker/src/media.ts (needs the live
  // socket, which this pure parser doesn't have) before syncIncomingMessage
  // is called -- see session/message-events.ts's processLiveMessage.
  mediaKey?: string;
  mediaMime?: string;
  mediaMeta?: MediaMeta;
  // Delivery status Baileys already knows (history sync carries it on our
  // own messages). Only delivered/read are kept -- see parseBaileysMessage.
  status?: MessageStatus;
}

/** Pulls the fields we care about out of a raw Baileys `proto.IWebMessageInfo`. */
/**
 * Our own messages from history sync arrive with a status (DELIVERY_ACK /
 * READ / PLAYED) but were all stored as "sent", so old chats showed single
 * ticks forever (receipts for them never arrive again). Only statuses at or
 * above "delivered" are used -- a live echo's PENDING/SERVER_ACK must not
 * start a row below the default "sent".
 */
function knownOutboundStatus(msg: any): MessageStatus | undefined {
  if (!msg?.key?.fromMe || msg?.status === undefined || msg?.status === null) return undefined;
  const mapped = messageStatusFromBaileys(Number(msg.status));
  return mapped === "delivered" || mapped === "read" ? mapped : undefined;
}

export async function parseBaileysMessage(db: Db, waSessionId: string, msg: any): Promise<ParsedMessage | null> {
  const rawRemoteJid = msg?.key?.remoteJid;
  // Anything addressed to `@broadcast` is not a chat with a person or a
  // group -- it's either the fixed `status@broadcast` JID (a Story) or a
  // `<creation-timestamp>@broadcast` JID (a broadcast list's own thread in
  // *our* chat list). Baileys surfaces both through the same
  // messages.upsert/messaging-history.set pipeline as everything else, so
  // without this check one would end up as a normal 1:1 "contact" (named
  // after the broadcast list's timestamp, with a garbage phone number) in
  // the CRM inbox. See https://baileys.wiki/features/broadcasts-stories --
  // this used to only catch the literal "status@broadcast" string, missing
  // every actual broadcast list.
  //
  // Channels (WhatsApp's newer "follow" feature, née newsletters) are a
  // separate JID namespace, `<id>@newsletter` -- not covered by that wiki
  // page at all, and not a broadcast/status JID, so this used to fall
  // through and land every followed Channel's posts in the inbox as a
  // normal 1:1 chat too. Same reasoning applies: it's not a person, so it
  // gets dropped here.
  if (!rawRemoteJid || rawRemoteJid.endsWith("@broadcast") || rawRemoteJid.endsWith("@newsletter")) return null;

  const content = msg.message;
  if (!content) return null;

  // Resolve LID JIDs to phone JIDs before storing
  const remoteJidAlt = msg?.key?.remoteJidAlt ?? null;
  const remoteJid = await resolveToPhoneJid(db, waSessionId, rawRemoteJid, remoteJidAlt);

  // Resolve participant JID for group messages
  const rawParticipant = msg?.key?.participant ?? undefined;
  const participant = rawParticipant
    ? await resolveToPhoneJid(db, waSessionId, rawParticipant, msg?.key?.participantAlt)
    : undefined;

  let type: IncomingType = "text";
  let body: string | undefined;

  if (content.conversation) {
    body = content.conversation;
  } else if (content.extendedTextMessage) {
    body = content.extendedTextMessage.text;
  } else if (content.imageMessage) {
    type = "image";
    body = content.imageMessage.caption;
  } else if (content.videoMessage) {
    type = "video";
    body = content.videoMessage.caption;
  } else if (content.audioMessage) {
    type = "audio";
  } else if (content.documentMessage) {
    type = "document";
    body = content.documentMessage.caption ?? content.documentMessage.fileName;
  } else if (content.stickerMessage) {
    type = "sticker";
  } else if (content.pollCreationMessage || content.pollUpdateMessage) {
    type = "poll";
    body = content.pollCreationMessage?.name || content.pollUpdateMessage?.name || "";
  } else if (content.locationMessage) {
    type = "location";
    body =
      content.locationMessage.name ||
      `${content.locationMessage.degreesLatitude}, ${content.locationMessage.degreesLongitude}`;
  } else if (content.contactsArrayMessage || content.contactMessage) {
    type = "contact";
    const contactsList =
      content.contactsArrayMessage?.contacts || (content.contactMessage ? [content.contactMessage] : []);
    body = contactsList.map((c: any) => c.displayName || c.vcard?.split("\n")?.[1] || "Contact").join(", ");
  } else {
    return null;
  }

  return {
    waMessageId: msg.key.id ?? crypto.randomUUID(),
    remoteJid,
    participant,
    fromMe: !!msg.key.fromMe,
    type,
    body,
    pushName: msg.pushName ?? undefined,
    timestampMs: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
    status: knownOutboundStatus(msg),
  };
}

export interface ResolvedConversation {
  conversationId: string;
  contactId: string | null;
}

// Per-isolate cache of (session, chat, sender, name) -> conversation/contact
// ids. Resolving them is 2-6 D1 queries per message (findOrCreateContact's
// lookups + its always-on UPDATE, then the conversation upsert) and the
// answer almost never changes between two messages in the same chat. Keyed
// on the pushName too, so a changed display name still re-resolves (and
// renames the contact). Short TTL + FK-failure eviction (see
// syncIncomingMessage) cover deletes/merges.
const RESOLVE_TTL_MS = 10 * 60 * 1000;
const RESOLVE_CACHE_MAX = 5000;
const resolveCache = new Map<string, { value: ResolvedConversation; expires: number }>();

function resolveKey(waSessionId: string, im: ParsedMessage) {
  const isGroup = im.remoteJid.endsWith("@g.us");
  const name = im.fromMe ? "" : (im.pushName ?? "");
  return `${waSessionId}|${isGroup ? "g" : "d"}|${im.remoteJid}|${im.participant ?? ""}|${name}`;
}

async function resolveConversation(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  im: ParsedMessage,
  useCache: boolean
): Promise<ResolvedConversation> {
  const key = resolveKey(waSessionId, im);
  const now = Date.now();
  if (useCache) {
    const hit = resolveCache.get(key);
    if (hit && hit.expires > now) return hit.value;
  }
  const value = im.remoteJid.endsWith("@g.us")
    ? await upsertGroupConversation(db, workspaceId, waSessionId, im)
    : await upsertDirectConversation(db, workspaceId, waSessionId, im);
  if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.clear();
  resolveCache.set(key, { value, expires: now + RESOLVE_TTL_MS });
  return value;
}

function evictResolved(waSessionId: string, im: ParsedMessage) {
  resolveCache.delete(resolveKey(waSessionId, im));
}

/**
 * The write half of syncIncomingMessage as batchable statements: the
 * message INSERT (de-duped on messages_conversation_wa_message_idx) plus
 * the conversation / contact / opt-out UPDATEs, each guarded by
 * `EXISTS (the row we just inserted)` so a duplicate delivery (conflict ->
 * nothing inserted) bumps nothing -- same semantics as the old
 * insert-then-check-then-update sequence, in ONE round trip.
 */
function buildMessageWrites(
  db: Db,
  workspaceId: string,
  resolved: ResolvedConversation,
  im: ParsedMessage,
  bumpUnread: boolean
) {
  const { conversationId, contactId } = resolved;
  const messageId = crypto.randomUUID();
  const messageDate = new Date(im.timestampMs);
  // sql`` fragments bind raw JS values as-is (no mapToDriverValue), so the
  // timestamp columns get the epoch-seconds integer Drizzle stores for
  // `integer(mode: "timestamp")` -- binding a Date throws in D1.
  const messageEpochSec = Math.floor(messageDate.getTime() / 1000);
  const insertedGuard = sql`EXISTS (SELECT 1 FROM messages WHERE id = ${messageId})`;
  const newer = sql`(${conversations.lastMessageAt} IS NULL OR ${conversations.lastMessageAt} < ${messageEpochSec})`;

  const insert = db
    .insert(messages)
    .values({
      id: messageId,
      workspaceId,
      conversationId,
      waMessageId: im.waMessageId,
      direction: im.fromMe ? "out" : "in",
      senderJid: im.participant ?? im.remoteJid,
      type: im.type,
      body: im.body,
      mediaKey: im.mediaKey,
      mediaMime: im.mediaMime,
      mediaMeta: im.mediaMeta,
      status: im.status ?? (im.fromMe ? "sent" : "delivered"),
      createdAt: messageDate,
    })
    .onConflictDoNothing({ target: [messages.conversationId, messages.waMessageId] })
    .returning({ id: messages.id });

  const statements: any[] = [
    insert,
    db
      .update(conversations)
      .set({
        // Forward-only: history backfills out of order; an older message
        // must never drag lastMessageAt / the preview backward.
        lastMessageAt: sql`CASE WHEN ${newer} THEN ${messageEpochSec} ELSE ${conversations.lastMessageAt} END`,
        unreadCount: !bumpUnread || im.fromMe ? sql`${conversations.unreadCount}` : sql`${conversations.unreadCount} + 1`,
        lastBody: sql`CASE WHEN ${newer} THEN ${im.body ?? null} ELSE ${conversations.lastBody} END`,
        lastType: sql`CASE WHEN ${newer} THEN ${im.type} ELSE ${conversations.lastType} END`,
        lastDirection: sql`CASE WHEN ${newer} THEN ${im.fromMe ? "out" : "in"} ELSE ${conversations.lastDirection} END`,
      })
      .where(and(eq(conversations.id, conversationId), insertedGuard)),
  ];
  if (contactId) {
    // "Last Contacted" on the Contacts page -- either direction counts.
    statements.push(
      db
        .update(contacts)
        .set({
          lastContactedAt: sql`CASE WHEN ${contacts.lastContactedAt} IS NULL OR ${contacts.lastContactedAt} < ${messageEpochSec} THEN ${messageEpochSec} ELSE ${contacts.lastContactedAt} END`,
        })
        .where(and(eq(contacts.id, contactId), insertedGuard))
    );
    // Broadcast opt-out: a STOP/unsubscribe reply permanently suppresses
    // this contact from every broadcast list (lib/contact-lists.ts).
    if (!im.fromMe && matchesStopKeyword(im.body)) {
      statements.push(
        db
          .update(contacts)
          .set({ doNotBroadcast: true, doNotBroadcastReason: "opted_out", doNotBroadcastAt: messageDate })
          .where(and(eq(contacts.id, contactId), insertedGuard))
      );
    }
  }
  return statements;
}

/**
 * Upserts contact/group + conversation + message rows for one parsed
 * Baileys message, and bumps the conversation's lastMessageAt/unreadCount.
 * Safe to call repeatedly for the same wa_message_id (de-duped on
 * messages_conversation_wa_message_idx -- a repeat delivery inserts nothing
 * and bumps nothing).
 *
 * D1 cost: 1 round trip (a batch) when the chat is in the resolve cache,
 * vs. 5-9 sequential queries before.
 */
export async function syncIncomingMessage(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  im: ParsedMessage,
  opts?: {
    // History backfill passes false: a freshly connected session
    // shouldn't dump its entire chat history into the CRM's unread
    // counters. Live messages (the default) still bump as before.
    bumpUnread?: boolean;
  }
) {
  const bumpUnread = opts?.bumpUnread ?? true;
  for (let attempt = 0; ; attempt++) {
    const resolved = await resolveConversation(db, workspaceId, waSessionId, im, attempt === 0);
    try {
      await db.batch(buildMessageWrites(db, workspaceId, resolved, im, bumpUnread) as [any, ...any[]]);
      return resolved.conversationId;
    } catch (err) {
      // A cached conversation/contact that was deleted or merged since:
      // evict and re-resolve once from the DB.
      evictResolved(waSessionId, im);
      if (attempt > 0) throw err;
    }
  }
}

/**
 * History backfill: resolves each chat once (cache) and writes up to
 * HISTORY_BATCH messages per round trip. A 50k-message history went from
 * ~350k sequential D1 queries to ~2k batches (+ one resolve per chat).
 * Falls back to the one-by-one path for a chunk whose batch fails.
 */
const HISTORY_BATCH = 25;
export async function syncMessagesBatch(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  parsed: ParsedMessage[],
  opts: { bumpUnread: boolean }
): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;
  for (let i = 0; i < parsed.length; i += HISTORY_BATCH) {
    const chunk = parsed.slice(i, i + HISTORY_BATCH);
    try {
      const statements: any[] = [];
      for (const im of chunk) {
        const resolved = await resolveConversation(db, workspaceId, waSessionId, im, true);
        statements.push(...buildMessageWrites(db, workspaceId, resolved, im, opts.bumpUnread));
      }
      await db.batch(statements as [any, ...any[]]);
      synced += chunk.length;
    } catch {
      for (const im of chunk) {
        try {
          await syncIncomingMessage(db, workspaceId, waSessionId, im, opts);
          synced++;
        } catch {
          failed++;
        }
      }
    }
  }
  return { synced, failed };
}

async function upsertDirectConversation(db: Db, workspaceId: string, waSessionId: string, im: ParsedMessage) {
  // Was: insert/onConflictDoUpdate keyed on exact jid, which is exactly
  // what let an @lid-addressed incoming message and a phone-jid-addressed
  // outgoing message spawn two different contacts (and conversations) for
  // the same person. findOrCreateContact resolves by phone number first.
  //
  // im.pushName on an outgoing (fromMe) message is OUR OWN WhatsApp
  // display name (Baileys stamps it on every message we send), not the
  // contact's -- using it here was overwriting every contact's name with
  // our own name the moment we replied to them. Only trust pushName for
  // naming the contact on messages they actually sent us.
  const contact = await findOrCreateContact(db, workspaceId, waSessionId, {
    jid: im.remoteJid,
    name: im.fromMe ? undefined : im.pushName,
  });

  const conversation = await db
    .insert(conversations)
    .values({ workspaceId, waSessionId, kind: "direct", contactId: contact.id })
    .onConflictDoUpdate({
      target: [conversations.waSessionId, conversations.contactId],
      set: { contactId: contact.id },
    })
    .returning({ id: conversations.id })
    .get();

  return { conversationId: conversation.id, contactId: contact.id };
}

async function upsertGroupConversation(db: Db, workspaceId: string, waSessionId: string, im: ParsedMessage) {
  const group = await db
    .insert(groups)
    .values({
      workspaceId,
      waSessionId,
      jid: im.remoteJid,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [groups.waSessionId, groups.jid],
      set: { updatedAt: new Date() },
    })
    .returning({ id: groups.id })
    .get();

  // The sender inside a group also deserves a contact record (assignable,
  // taggable, searchable) even though the conversation itself hangs off
  // the group, not the individual. Use findOrCreateContact so the
  // phone-number-first dedup applies to group participants too.
  let participantContactId: string | null = null;
  if (im.participant) {
    const participantName = im.fromMe ? undefined : im.pushName;
    const participantContact = await findOrCreateContact(db, workspaceId, waSessionId, {
      jid: im.participant,
      name: participantName,
    });
    participantContactId = participantContact.id;
  }

  const conversation = await db
    .insert(conversations)
    .values({ workspaceId, waSessionId, kind: "group", groupId: group.id })
    .onConflictDoUpdate({
      target: [conversations.waSessionId, conversations.groupId],
      set: { groupId: group.id },
    })
    .returning({ id: conversations.id })
    .get();

  return { conversationId: conversation.id, contactId: participantContactId };
}

// ── Reactions ──────────────────────────────────────────────────────────

/** Add or update a reaction on a message. Replaces any existing reaction from the same sender. */
export async function upsertMessageReaction(
  db: Db,
  workspaceId: string,
  waMessageId: string,
  reaction: { emoji: string; sender: string; timestampMs: number }
): Promise<string | null> {
  const row = await db
    .select({ reactions: messages.reactions, conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.waMessageId, waMessageId)))
    .get();
  if (!row) return null;

  const existing: Reaction[] = Array.isArray(row.reactions) ? row.reactions : [];
  const filtered = existing.filter((r) => r.sender !== reaction.sender);
  if (reaction.emoji) {
    filtered.push(reaction);
  }
  await db
    .update(messages)
    .set({ reactions: filtered.length > 0 ? filtered : null })
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.waMessageId, waMessageId)));
  return row.conversationId;
}

// ── Message edits ──────────────────────────────────────────────────────

/** Mark a message as edited and update its body. Returns the thread it
 *  belongs to (null when no such message) so callers can scope their
 *  realtime event to one conversation. */
export async function markMessageEdited(
  db: Db,
  workspaceId: string,
  waMessageId: string,
  newBody: string
): Promise<string | null> {
  const row = (await db
    .update(messages)
    .set({ body: newBody, editedAt: new Date() })
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.waMessageId, waMessageId)))
    .returning({ conversationId: messages.conversationId })
    .get()) as { conversationId: string } | undefined;
  return row?.conversationId ?? null;
}

// ── Message deletions ──────────────────────────────────────────────────

/** Soft-delete a message (mark as deleted on WhatsApp). Returns the thread
 *  it belongs to (null when no such message) for realtime scoping. */
export async function markMessageDeleted(db: Db, workspaceId: string, waMessageId: string): Promise<string | null> {
  const row = (await db
    .update(messages)
    .set({ deleted: true })
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.waMessageId, waMessageId)))
    .returning({ conversationId: messages.conversationId })
    .get()) as { conversationId: string } | undefined;
  return row?.conversationId ?? null;
}
