// Turns Baileys' messages.upsert / messaging-history.set payloads into
// D1 rows (+ the live-only side effects: websocket broadcast, outbound
// webhooks, search indexing, auto-reply). Pulled out of whatsapp-session.ts
// so the socket/lifecycle DO class doesn't also have to carry all of this
// business logic inline.
import {  eq, and, groups } from "@workspace/db";
import type {Db} from "@workspace/db";
import type { WASocket } from "@whiskeysockets/baileys";
import type { Env } from "../index";
import { parseBaileysMessage, syncIncomingMessage, syncMessagesBatch, isContactBlocked  } from "../db/sync";
import type {ParsedMessage} from "../db/sync";
import { downloadAndStoreMedia } from "../media";
import { findAutoReply, dispatchWebhookEvent } from "../automation";
import { maybeAiAutoReply } from "../ai-autoreply";
import { indexMessageForSearch } from "../search";
import { TtlCache } from "../ttl-cache";

// Group subject for the search index metadata -- was one D1 read per group message.
const groupNameCache = new TtlCache<string | null>(5 * 60_000);

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"];

// Offline-queued messages ('append', see processLiveMessage below) can be
// hours or days old by the time we reconnect. Auto-replying to the whole
// backlog would be spammy and confusing, so only messages this fresh get
// a reply; older backlog is still synced/broadcast/webhooked, just not
// auto-replied to.
const AUTO_REPLY_MAX_AGE_MS = 5 * 60 * 1000;

type LogFn = (level: "info" | "warn" | "error", msg: string) => void;

export interface MessageEventContext {
  db: Db;
  env: Env;
  socket: WASocket | null;
  sessionIdName: string;
  workspaceId: string;
  log: LogFn;
  broadcast: (data: Record<string, unknown>) => void;
  /** Anti-ban: per-contact auto-reply loop breaker + session pace. */
  allowAutoReply?: (jid: string) => boolean;
  /**
   * Hands a fire-and-forget promise (webhook delivery, search indexing) to
   * the runtime so it keeps the isolate alive after this handler returns.
   * Without it those promises are cut off mid-flight when the enclosing
   * waitUntil() settles -- silently dropped webhook deliveries.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Handles one message from a `messages.upsert` event, live end to end:
 * parse -> blocked-contact check -> media download -> D1 sync ->
 * websocket broadcast -> outbound webhook -> search index -> auto-reply.
 *
 * `upsertType` is Baileys' own `notify` | `append` tag. Per Baileys'
 * source (`node.attrs.offline ? 'append' : 'notify'`), `append` isn't
 * just history backfill -- it's also how a message that queued up while
 * we were offline gets delivered on reconnect, and how our own sends from
 * another linked device show up. Both need to reach the CRM the same as
 * a `notify` message; the only place `upsertType` changes behavior here
 * is the auto-reply recency guard below.
 */
export async function processLiveMessage(
  ctx: MessageEventContext,
  msg: any,
  upsertType: "notify" | "append"
): Promise<void> {
  const parsed = await parseBaileysMessage(ctx.db, ctx.sessionIdName, msg);
  if (!parsed) return;

  // No message text in logs: it's customer PII, and at scale one log line
  // per message is already the dominant log volume.
  ctx.log("info", `${parsed.fromMe ? "OUT" : "IN"} [${parsed.type}] ${parsed.waMessageId}`);

  // Skip all processing for incoming messages from blocked contacts —
  // no conversation, no sync, no auto-reply, nothing.
  if (!parsed.fromMe) {
    const senderJid = parsed.participant ?? parsed.remoteJid;
    if (await isContactBlocked(ctx.db, ctx.sessionIdName, senderJid)) {
      ctx.log("info", `Blocked contact ${senderJid} — message dropped`);
      return;
    }
  }

  // Photo/video/voice-note/document/sticker -- fetch the actual bytes
  // into R2 before we save the row, so the CRM inbox can render it
  // inline like WhatsApp Web does instead of a bare "[image]"
  // placeholder. Best-effort: a failure here still lets the message
  // through, just without media attached.
  if (MEDIA_TYPES.includes(parsed.type) && ctx.socket) {
    const media = await downloadAndStoreMedia(
      ctx.socket,
      ctx.env,
      ctx.workspaceId,
      ctx.sessionIdName,
      parsed.waMessageId,
      msg,
      parsed.type
    );
    if (media) {
      parsed.mediaKey = media.mediaKey;
      parsed.mediaMime = media.mediaMime;
      parsed.mediaMeta = media.mediaMeta;
    }
  }

  let conversationId: string;
  try {
    conversationId = await syncIncomingMessage(ctx.db, ctx.workspaceId, ctx.sessionIdName, parsed);
  } catch (err: any) {
    ctx.log("error", `D1 sync failed for message ${parsed.waMessageId}: ${err?.message || err}`);
    return;
  }

  // Broadcast to WebSocket subscribers so the CRM inbox updates in real-time.
  // Includes conversationPatch so the client can optimistically update the
  // conversation list without a D1 query.
  ctx.broadcast({
    type: "new-message",
    sessionId: ctx.sessionIdName,
    workspaceId: ctx.workspaceId,
    conversationId,
    message: {
      remoteJid: parsed.remoteJid,
      fromMe: parsed.fromMe,
      type: parsed.type,
      body: parsed.body,
      waMessageId: parsed.waMessageId,
      timestampMs: parsed.timestampMs,
      pushName: parsed.pushName ?? null,
      // "append" = backfill/offline catch-up; the web app only raises
      // desktop notifications for live traffic.
      upsertType,
    },
    conversationPatch: {
      lastBody: parsed.body ?? null,
      lastType: parsed.type,
      lastDirection: parsed.fromMe ? "out" : "in",
      lastMessageAt: parsed.timestampMs,
      unreadCountDelta: !parsed.fromMe ? 1 : 0,
    },
  });

  // Outbound webhook -- handed to waitUntil so the delivery (up to 10s per
  // hook, sequential) survives this handler returning.
  const webhookWork = dispatchWebhookEvent(ctx.db, ctx.workspaceId, parsed.fromMe ? "message.sent" : "message.received", {
    sessionId: ctx.sessionIdName,
    remoteJid: parsed.remoteJid,
    fromMe: parsed.fromMe,
    type: parsed.type,
    body: parsed.body,
    waMessageId: parsed.waMessageId,
  }).catch((err: any) => ctx.log("error", `Webhook dispatch failed: ${err?.message || err}`));
  if (ctx.waitUntil) ctx.waitUntil(webhookWork);

  // Semantic search index
  if (parsed.body) {
    const isGroup = parsed.remoteJid.endsWith("@g.us");
    let groupName: string | null = null;
    let senderName: string | null = null;
    if (isGroup) {
      try {
        groupName = await groupNameCache.get(`${ctx.sessionIdName}|${parsed.remoteJid}`, async () => {
          const groupRow = await ctx.db
            .select({ name: groups.name })
            .from(groups)
            .where(and(eq(groups.waSessionId, ctx.sessionIdName), eq(groups.jid, parsed.remoteJid)))
            .get();
          return groupRow?.name ?? null;
        });
      } catch {}
      if (parsed.pushName) senderName = parsed.pushName;
    }
    const indexWork = indexMessageForSearch(ctx.env, {
      messageId: parsed.waMessageId,
      workspaceId: ctx.workspaceId,
      waSessionId: ctx.sessionIdName,
      conversationId,
      text: parsed.body,
      isGroup,
      groupName,
      senderName,
      senderJid: parsed.participant ?? null,
    }).catch((err: any) => ctx.log("error", `Search indexing failed: ${err?.message || err}`));
    if (ctx.waitUntil) ctx.waitUntil(indexWork);
  }

  // Auto-reply: keyword rules first (deterministic, cheap), then the AI
  // agent as a fallback when no rule matched. Only for genuinely fresh
  // messages -- see AUTO_REPLY_MAX_AGE_MS above.
  const isFresh = upsertType === "notify" || Date.now() - parsed.timestampMs < AUTO_REPLY_MAX_AGE_MS;
  if (!parsed.fromMe && ctx.socket && parsed.body && isFresh) {
    try {
      const isGroup = parsed.remoteJid.endsWith("@g.us");
      const senderJid = parsed.participant ?? parsed.remoteJid;
      let replyText = await findAutoReply(ctx.db, ctx.workspaceId, ctx.sessionIdName, {
        isGroup,
        body: parsed.body,
        senderJid,
      });
      let source = "Keyword auto-reply";
      if (!replyText) {
        replyText = await maybeAiAutoReply(ctx.env, {
          waSessionId: ctx.sessionIdName,
          workspaceId: ctx.workspaceId,
          conversationId,
          remoteJid: parsed.remoteJid,
          senderJid,
          isGroup,
          body: parsed.body,
        });
        source = "AI auto-reply";
      }
      if (replyText && ctx.allowAutoReply && !ctx.allowAutoReply(parsed.remoteJid)) {
        replyText = null; // loop breaker / pace: skip this auto-reply
      }
      if (replyText) {
        ctx.log("info", `${source} firing for ${parsed.remoteJid}`);
        const result = await ctx.socket.sendMessage(parsed.remoteJid, {
          text: replyText,
        });
        if (result?.key) {
          const autoReplyParsed: ParsedMessage = {
            waMessageId: result.key.id ?? crypto.randomUUID(),
            remoteJid: parsed.remoteJid,
            fromMe: true,
            type: "text",
            body: replyText,
            timestampMs: Date.now(),
          };
          await syncIncomingMessage(ctx.db, ctx.workspaceId, ctx.sessionIdName, autoReplyParsed);
        }
      }
    } catch (err: any) {
      ctx.log("error", `Auto-reply failed: ${err?.message || err}`);
    }
  }
}

/**
 * Handles `messaging-history.set`'s `hist.messages` -- the actual chat
 * history Baileys sends on initial connect. Previously this array was
 * logged and discarded entirely, so a freshly connected session never
 * got any message history into D1, only messages that arrived live
 * afterward.
 *
 * Bulk historical sync intentionally skips the live-only side effects
 * (media download, websocket broadcast, outbound webhooks, search
 * indexing, auto-reply): replaying potentially thousands of old events
 * through those would flood the CRM UI/webhooks and run up media-download
 * / embedding costs for a user's entire chat history. It writes through
 * the same parse + de-duped upsert path as live messages, so a message
 * that arrives live after history sync (or a second history sync) is a
 * no-op rather than a duplicate.
 */
export async function syncMessagesFromHistory(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  historyMessages: any[],
  log: LogFn
): Promise<void> {
  log("info", `Syncing ${historyMessages.length} history messages...`);
  let skipped = 0;
  const parsedAll: ParsedMessage[] = [];
  for (const msg of historyMessages) {
    try {
      const parsed = await parseBaileysMessage(db, waSessionId, msg);
      if (parsed) parsedAll.push(parsed);
      else skipped++;
    } catch (err: any) {
      skipped++;
      log("error", `syncMessagesFromHistory parse failed for ${msg?.key?.id}: ${err?.message || err}`);
    }
  }
  // bumpUnread: false -- see syncIncomingMessage's opts doc. Batched: one
  // resolve per chat, 25 messages per D1 round trip.
  const { synced, failed } = await syncMessagesBatch(db, workspaceId, waSessionId, parsedAll, {
    bumpUnread: false,
  });
  skipped += failed;
  log("info", `Synced ${synced} history messages (${skipped} skipped/failed) for session ${waSessionId}`);
}
