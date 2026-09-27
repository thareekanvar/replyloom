import "../protobuf-patch";
import { makeWASocket, DisconnectReason, initAuthCreds, Browsers, BufferJSON } from "@whiskeysockets/baileys";
import type { AuthenticationState, AuthenticationCreds, SignalKeyStore, WASocket } from "@whiskeysockets/baileys";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createDb,  and, eq, sql, messages, conversations, contacts, waSessions } from "@workspace/db";
import type {Db} from "@workspace/db";
import type { Env } from "../index";
import { publicMessage, publicStatus } from "../errors";
import { readJson } from "../json";
import {
  getSessionWorkspaceId,
  markSessionStatus,
  messageStatusFromBaileys,
  syncIncomingMessage,
  updateMessageStatus,
  upsertGroupMetadata,
  upsertGroupMembers,
  resolveToPhoneJid,
  isLidJid,
  upsertMessageReaction,
  markMessageEdited,
  markMessageDeleted,
  updateConversationChatState,
  syncLidMapping,
  invalidateBlockedCache
  
} from "../db/sync";
import type {MessageStatus} from "../db/sync";
import { storeOutgoingMedia, mediaTypeFromMime } from "../media";
import { processLiveMessage, syncMessagesFromHistory } from "./message-events";
import { syncContactUpsert, syncContactsFromHistory, syncGroupsFromHistory, syncDirectChatsFromHistory } from "./contact-events";
import { TtlCache } from "../ttl-cache";
import {
  AutoReplyLimiter,
  MAX_QUEUE_WAIT_MS,
  OUTBOUND_BURST,
  OUTBOUND_PER_SEC,
  TokenBucket,
  dayKey,
  newChatDailyCap,
  parseSendKind
  
} from "./outbound-guard";
import type {SendKind} from "./outbound-guard";

// Pretty-prints a Baileys pino-logger argument for our own log stream.
// Was `String(x)` for every arg, which turns any object Baileys logs
// (which is most of them -- pino loggers take a data object as the FIRST
// arg, then a message string) into the literal text "[object Object]",
// throwing away the actual error/detail every single time. That's exactly
// what made a real failure (e.g. "Failed to encrypt for recipient") show
// up in our logs with zero information about *why* -- the useful part was
// always in the object we were discarding.
function fmtLogArg(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message;
  if (a && typeof a === "object") {
    try {
      return JSON.stringify(a, (_k, v) => {
        if (v instanceof Uint8Array) return `<${v.length} bytes>`;
        if (v instanceof Error) return { message: v.message, stack: v.stack };
        return v;
      });
    } catch {
      return String(a);
    }
  }
  return String(a);
}

// ── SQLite-backed auth state adapter (Phase 4) ──────────────────────────

function createSqliteAuthState(storage: SqlStorage): AuthenticationState {
  storage.exec(`
    CREATE TABLE IF NOT EXISTS wa_creds (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  storage.exec(`
    CREATE TABLE IF NOT EXISTS wa_keys (
      type TEXT NOT NULL,
      id   TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (type, id)
    );
  `);

  function loadCreds(): AuthenticationCreds {
    const rows = storage.exec("SELECT value FROM wa_creds WHERE key = ?", "creds").toArray();
    if (rows.length > 0) {
      return JSON.parse(rows[0].value as string, BufferJSON.reviver);
    }
    const fresh = initAuthCreds();
    saveCreds(fresh);
    return fresh;
  }

  function saveCreds(creds: AuthenticationCreds) {
    storage.exec(
      "INSERT OR REPLACE INTO wa_creds (key, value) VALUES (?, ?)",
      "creds",
      JSON.stringify(creds, BufferJSON.replacer)
    );
  }

  const keys: SignalKeyStore = {
    async get(type, ids) {
      const result: Record<string, any> = {};
      for (const id of ids) {
        const rows = storage.exec("SELECT value FROM wa_keys WHERE type = ? AND id = ?", type, id).toArray();
        if (rows.length > 0) {
          result[id] = JSON.parse(rows[0].value as string, BufferJSON.reviver);
        }
      }
      return result;
    },
    async set(data) {
      for (const type of Object.keys(data)) {
        const entries = (data as any)[type];
        if (!entries) continue;
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) {
            storage.exec("DELETE FROM wa_keys WHERE type = ? AND id = ?", type, id);
          } else {
            storage.exec(
              "INSERT OR REPLACE INTO wa_keys (type, id, value) VALUES (?, ?, ?)",
              type,
              id,
              JSON.stringify(value, BufferJSON.replacer)
            );
          }
        }
      }
    },
  };

  return { creds: loadCreds(), keys };
}

// ── Durable Object ──────────────────────────────────────────────────────

const MAX_RECONNECT_ATTEMPTS = 3;

type ConnectionState = "idle" | "connecting" | "qr" | "authenticated" | "connected" | "disconnected";

interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

// See applyMessageStatus: receipts that arrive before their message row.
const RECEIPT_RETRY_DELAY_MS = 4_000;

// ── Always-on watchdog ──
// The WhatsApp connection lives in this DO, not in the browser -- but a DO
// is torn down on every deploy / runtime restart, and nothing used to bring
// it back until some request arrived (i.e. someone opened the CRM). With
// every tab closed the number went silent: no sync, no auto-replies. A
// durable alarm (survives eviction + deploys) now checks the socket and
// reconnects on its own, backing off instead of giving up for good.
const WATCHDOG_HEALTHY_MS = 2 * 60_000;
const WATCHDOG_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000];
// Random spread added to every watchdog timer: after a deploy every
// session's DO restarts at once, and without jitter they'd all reconnect
// (and hit WhatsApp + the shared D1) in the same few seconds.
const WATCHDOG_JITTER_MS = 30_000;
// A reconnect re-runs groupFetchAllParticipating + a sync of every group.
// Live groups.* events keep groups current in between, so the full refetch
// only runs when the last one is older than this -- otherwise a deploy
// (every number reconnecting) turns into a D1 write storm.
const FULL_GROUP_SYNC_MIN_INTERVAL_MS = 6 * 60 * 60_000;

// "Has this person ever written to us?" -- once true it stays true.
const warmChatCache = new TtlCache<boolean>(60 * 60_000);

export class WhatsAppSession implements DurableObject {
  private state: DurableObjectState;
  private socket: WASocket | null = null;
  private connectionState: ConnectionState = "idle";
  private qr: string | null = null;
  private logs: LogEntry[] = [];
  private sessionUser: string | null = null;
  private initialized = false;
  private env: Env;
  private db: Db;
  // Set when the user explicitly clicks Disconnect / DELETE — prevents the
  // connection.close handler from auto-reconnecting.
  private intentionalDisconnect = false;
  // In-flight startSocket() promise. `this.socket` stays null for the
  // whole auth-state + sw.js + makeWASocket setup, so a second
  // POST /connect (or ensureInit) during that window used to pass
  // `if (this.socket) return` and call makeWASocket again — orphaning
  // the first socket. Concurrent callers now await this promise instead.
  private startPromise: Promise<void> | null = null;
  // Last sw.js client_revision we successfully parsed — reused when the
  // next sw.js fetch fails/times out so we don't fall back to a stale
  // hardcoded version WhatsApp will reject.
  private lastWaVersion: [number, number, number] | null = null;
  // Resolved lazily from D1 (wa_sessions.workspace_id) and cached — the DO
  // itself only ever knows its own id (== wa_sessions.id); the CRM
  // relationship data all lives in D1, not in DO storage.
  private workspaceId: string | null = null;
  // Reconnect counter — reset on successful connection, increments on disconnect
  private reconnectCount = 0;
  // Onboarding preferences, set by POST /connect and persisted in DO
  // storage (not D1 -- these only ever matter to this session's own
  // connect flow, same category as connectionState/qr/sessionUser above).
  // When true, `messaging-history.set`'s message backfill is skipped
  // entirely -- the CRM only starts recording messages that arrive live
  // from this point on, instead of importing the number's past chat
  // history. Contacts/group metadata still sync either way (cheap), but
  // conversation shells from hist.chats are NOT created -- the inbox
  // stays empty until a live message arrives.
  private skipHistorySync = false;
  // When true, group membership sync (resolving every participant of
  // every group into a CRM contact row) is skipped at connect/history
  // time -- group name + participant count still sync so groups show up
  // in the inbox, but members can be pulled in later on demand via
  // POST /group-members-sync for a specific group instead of eagerly for
  // every group the number happens to be in.
  private skipGroupMemberSync = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.db = createDb(env.DB);
  }

  // DOs for this app are always created via idFromName(sessionId) in
  // index.ts, so `.name` is always set in practice — this getter just
  // gives call sites a non-optional string without sprinkling `!` around.
  private get sessionIdName(): string {
    return this.state.id.name ?? this.state.id.toString();
  }

  private async resolveWorkspaceId(): Promise<string | null> {
    if (this.workspaceId) return this.workspaceId;
    try {
      this.workspaceId = await getSessionWorkspaceId(this.db, this.sessionIdName);
    } catch (err: any) {
      this.log("error", `resolveWorkspaceId D1 query FAILED: ${err?.message || err}`);
      return null;
    }
    if (!this.workspaceId) {
      this.log(
        "warn",
        `resolveWorkspaceId: NO row in wa_sessions for id="${this.sessionIdName}". CRM sync (status/messages/contacts) SKIPPED. Create the session in the web app first.`
      );
    } else {
      this.log("info", `resolveWorkspaceId: workspaceId=${this.workspaceId} for session=${this.sessionIdName}`);
    }
    return this.workspaceId;
  }

  /**
   * Resolves workspaceId and runs `fn` with it, or logs a warning and
   * bails if it can't be resolved yet. Used by every event handler below
   * that needs workspaceId to sync anything -- was copy-pasted at each
   * call site before, now it's one place.
   */
  private async withWorkspaceId(fn: (workspaceId: string) => Promise<void>): Promise<void> {
    const wsId = await this.resolveWorkspaceId();
    if (!wsId) {
      this.log("warn", "workspaceId unresolved — sync skipped");
      return;
    }
    await fn(wsId);
  }

  private async ensureInit() {
    if (this.initialized) return;
    this.initialized = true;

    const saved = await this.state.storage.get<ConnectionState>("connectionState");
    if (saved) this.connectionState = saved;
    const savedUser = await this.state.storage.get<string>("sessionUser");
    if (savedUser) this.sessionUser = savedUser;
    const savedQr = await this.state.storage.get<string>("qr");
    if (savedQr) this.qr = savedQr;
    this.skipHistorySync = (await this.state.storage.get<boolean>("skipHistorySync")) ?? false;
    this.skipGroupMemberSync = (await this.state.storage.get<boolean>("skipGroupMemberSync")) ?? false;

    // A Durable Object can be evicted from memory (and its in-process
    // `this.socket` destroyed) whenever it goes quiet, even though the
    // persisted connectionState / auth creds in storage still say
    // "connected". On the next request a brand-new instance is
    // constructed (socket=null, connectionState defaults to "idle" until
    // this hydrate runs). If storage says we were mid-connect or already
    // connected, re-attach a socket now using the saved Baileys creds —
    // this resumes the existing session without a fresh QR scan.
    if (
      !this.socket &&
      (this.connectionState === "qr" ||
        this.connectionState === "connecting" ||
        this.connectionState === "connected" ||
        this.connectionState === "authenticated")
    ) {
      this.log(
        "info",
        `ensureInit: no live socket but persisted state="${this.connectionState}" — rehydrating socket after likely DO eviction`
      );
      this.connectionState = "connecting";
      this.qr = null;
      await this.startSocket();
      // startSocket() resolves as soon as makeWASocket() returns a socket
      // object -- Baileys still needs to finish the noise handshake with
      // WA's servers in the background before that socket can actually
      // send/receive. A route that only checked `!!this.socket` right
      // after this (like POST /send) was firing sendMessage() at a socket
      // that was still mid-handshake, which Baileys rejects with
      // "Connection Closed". Block here until the handshake actually
      // completes (or bail out after a timeout) so every caller of
      // ensureInit() gets back a socket that's really usable.
      await this.waitUntilConnected(15_000);
    }
  }

  /**
   * Polls connectionState until it reaches "connected" (the noise
   * handshake finished and setupEventHandlers's connection.update "open"
   * branch ran) or gives up after timeoutMs. Only meaningful right after
   * startSocket() -- if we're not mid-connect at all, returns immediately.
   */
  private async waitUntilConnected(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (
      this.connectionState !== "connected" &&
      this.connectionState !== "disconnected" &&
      Date.now() - start < timeoutMs
    ) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private log(level: LogEntry["level"], msg: string) {
    const entry = { ts: Date.now(), level, msg };
    this.logs.push(entry);
    if (this.logs.length > 200) this.logs.shift();
    console.log(`[WA:${this.state.id.name}] [${level}] ${msg}`);
  }

  private persist() {
    this.state.storage.put("connectionState", this.connectionState);
    if (this.sessionUser) {
      this.state.storage.put("sessionUser", this.sessionUser);
    }
  }

  /**
   * Persist receipts (forward-only, batched) and push them to open inboxes --
   * one event per conversation per status, not one per message.
   */
  private async applyMessageStatus(
    workspaceId: string,
    waMessageIds: string[],
    status: MessageStatus,
    isRetry = false
  ) {
    try {
      const changed = await updateMessageStatus(this.db, workspaceId, waMessageIds, status);
      // A receipt can beat the message's own D1 insert (fast recipient:
      // sendMessage resolves, the ack lands, then syncIncomingMessage
      // writes the row) and used to be dropped. Retry the ids that matched
      // nothing once, a few seconds later. (A stale receipt for a row
      // that's already past this status also lands here -- one extra
      // indexed no-op update, harmless.)
      if (!isRetry) {
        const hit = new Set(changed.map((r) => r.waMessageId));
        const missed = waMessageIds.filter((id) => !hit.has(id));
        if (missed.length) {
          this.state.waitUntil(
            new Promise((resolve) => setTimeout(resolve, RECEIPT_RETRY_DELAY_MS)).then(() =>
              this.applyMessageStatus(workspaceId, missed, status, true)
            )
          );
        }
      }
      const byConversation = new Map<string, string[]>();
      for (const row of changed) {
        if (!row.waMessageId) continue;
        const list = byConversation.get(row.conversationId) ?? [];
        list.push(row.waMessageId);
        byConversation.set(row.conversationId, list);
      }
      for (const [conversationId, messageIds] of byConversation) {
        this.broadcast({
          type: "message-status",
          sessionId: this.sessionIdName,
          workspaceId,
          conversationId,
          messageIds,
          status,
        });
      }
    } catch (err: any) {
      this.log("error", `Message status sync failed (${waMessageIds.length} ids -> ${status}): ${err?.message || err}`);
    }
  }

  /** Group ids by target status and flush each group as one batched update. */
  private async flushStatusBatch(workspaceId: string, batch: Map<MessageStatus, string[]>) {
    await Promise.all([...batch].map(([status, ids]) => this.applyMessageStatus(workspaceId, ids, status)));
  }

  // ── Anti-ban outbound guard (see session/outbound-guard.ts) ──
  private outboundBucket = new TokenBucket(OUTBOUND_BURST, OUTBOUND_PER_SEC);
  private autoReplyLimiter = new AutoReplyLimiter();
  private sessionCreatedAt: Date | null | undefined = undefined;

  /**
   * Called before every new outbound message. Returns a 429 Response to send
   * back instead, or null to go ahead. Pace applies to every kind; the
   * new-chat cap to agent/API/scheduled sends (broadcasts have their own
   * daily cap + list rules; auto-replies only ever answer inbound).
   */
  private async guardOutbound(jid: string, request: Request | null, kindOverride?: SendKind): Promise<Response | null> {
    const kind = kindOverride ?? parseSendKind(request?.headers.get("X-Send-Kind"));
    let wait = this.outboundBucket.take();
    if (wait > 0 && wait <= MAX_QUEUE_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = this.outboundBucket.take();
    }
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      this.log("warn", `outbound guard: rate limited (${kind})`);
      return Response.json(
        {
          ok: false,
          error: `Sending too fast -- WhatsApp flags bursts of messages. Try again in ${retryAfterSeconds}s.`,
          retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
      );
    }
    if ((kind === "manual" || kind === "api" || kind === "scheduled") && !jid.endsWith("@g.us")) {
      return this.checkNewChatCap(jid);
    }
    return null;
  }

  /** Auto-reply loop breaker + pace (used by processLiveMessage). */
  private allowAutoReply(jid: string): boolean {
    if (!this.autoReplyLimiter.allow(jid)) {
      this.log("warn", "outbound guard: auto-reply suppressed (per-contact / hourly limit)");
      return false;
    }
    return this.outboundBucket.take() === 0;
  }

  private async hasInboundHistory(jid: string): Promise<boolean> {
    return warmChatCache.get(`${this.sessionIdName}|${jid}`, async () => {
      const row = await this.db
        .select({ one: sql<number>`1` })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(
          and(
            eq(contacts.waSessionId, this.sessionIdName),
            eq(contacts.jid, jid),
            eq(messages.direction, "in")
          )
        )
        .limit(1)
        .get();
      return !!row;
    });
  }

  private async checkNewChatCap(jid: string): Promise<Response | null> {
    if (await this.hasInboundHistory(jid)) return null; // they wrote to us: not a cold chat
    if (this.sessionCreatedAt === undefined) {
      const row = await this.db
        .select({ createdAt: waSessions.createdAt })
        .from(waSessions)
        .where(eq(waSessions.id, this.sessionIdName))
        .get()
        .catch(() => undefined);
      this.sessionCreatedAt = row?.createdAt ? new Date(row.createdAt) : null;
    }
    const cap = newChatDailyCap(this.sessionCreatedAt);
    const key = `newchats:${dayKey()}`;
    const today = (await this.state.storage.get<string[]>(key)) ?? [];
    if (today.includes(jid)) return null;
    if (today.length >= cap) {
      this.log("warn", `outbound guard: new-chat daily cap reached (${cap})`);
      return Response.json(
        {
          ok: false,
          error: `Daily limit for starting new chats reached (${cap}/day for this number). Messaging many people who never wrote to you first is the #1 cause of WhatsApp bans -- try again tomorrow, or reply to people who contact you.`,
        },
        { status: 429 }
      );
    }
    today.push(jid);
    const lastKey = await this.state.storage.get<string>("newchats:lastKey");
    if (lastKey && lastKey !== key) await this.state.storage.delete(lastKey);
    await this.state.storage.put({ [key]: today, "newchats:lastKey": key });
    return null;
  }

  /** Should this number be kept online by the watchdog? Set when the
   * connection opens; cleared on an intentional disconnect or logout. */
  private async setWantOnline(want: boolean) {
    await this.state.storage.put("wantOnline", want);
    if (want) {
      await this.state.storage.put("watchdogAttempt", 0);
      await this.scheduleWatchdog(WATCHDOG_HEALTHY_MS);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  private async scheduleWatchdog(delayMs: number) {
    await this.state.storage.setAlarm(Date.now() + delayMs + Math.floor(Math.random() * WATCHDOG_JITTER_MS));
  }

  /** Durable alarm: runs even when no browser is connected, including right
   * after a deploy/eviction (alarms are persisted). */
  async alarm(): Promise<void> {
    await this.runWatchdog();
  }

  private async runWatchdog(): Promise<{ state: string; action: string }> {
    try {
      const want = await this.state.storage.get<boolean>("wantOnline");
      if (!want) return { state: this.connectionState, action: "not-wanted" };

      if (this.socket && this.connectionState === "connected") {
        // Healthy: no D1 read, just re-arm.
        await this.state.storage.put("watchdogAttempt", 0);
        await this.scheduleWatchdog(WATCHDOG_HEALTHY_MS);
        return { state: this.connectionState, action: "healthy" };
      }
      // Mid-connect or waiting for a QR scan: check again soon, don't interfere.
      if (this.startPromise || this.connectionState === "qr" || (this.socket && this.connectionState === "connecting")) {
        await this.scheduleWatchdog(WATCHDOG_BACKOFF_MS[0]);
        return { state: this.connectionState, action: "waiting" };
      }

      // About to (re)connect: stop for good if the session was deleted in the
      // CRM (fresh D1 read, not the per-instance cache).
      const wsId = await getSessionWorkspaceId(this.db, this.sessionIdName).catch(() => undefined);
      if (wsId === null) {
        await this.setWantOnline(false);
        return { state: this.connectionState, action: "session-deleted" };
      }
      await this.ensureInit(); // re-attaches the socket after an eviction
      if (this.socket && (this.connectionState as ConnectionState) === "connected") {
        await this.state.storage.put("watchdogAttempt", 0);
        await this.scheduleWatchdog(WATCHDOG_HEALTHY_MS);
        return { state: this.connectionState, action: "rehydrated" };
      }

      const attempt = (await this.state.storage.get<number>("watchdogAttempt")) ?? 0;
      this.log("warn", `watchdog: offline (state=${this.connectionState}) -- reconnecting, attempt ${attempt + 1}`);
      this.reconnectCount = 0;
      this.intentionalDisconnect = false;
      if (this.socket) {
        await this.socket.end(undefined).catch(() => {});
        this.socket = null;
      }
      this.connectionState = "connecting";
      this.persist();
      await this.startSocket();
      await this.waitUntilConnected(15_000);
      // (re-read: TS keeps the "connecting" narrowing across the awaits
      // above, but connection.update has changed it by now)
      const ok = (this.connectionState as ConnectionState) === "connected";
      await this.state.storage.put("watchdogAttempt", ok ? 0 : attempt + 1);
      await this.scheduleWatchdog(
        ok ? WATCHDOG_HEALTHY_MS : WATCHDOG_BACKOFF_MS[Math.min(attempt, WATCHDOG_BACKOFF_MS.length - 1)]
      );
      return { state: this.connectionState, action: ok ? "reconnected" : "retry-scheduled" };
    } catch (err: any) {
      this.log("error", `watchdog failed: ${err?.message || err}`);
      await this.scheduleWatchdog(WATCHDOG_BACKOFF_MS[0]).catch(() => {});
      return { state: this.connectionState, action: "error" };
    }
  }

  private broadcast(data: Record<string, unknown>) {
    const msg = JSON.stringify(data);
    // this.state.getWebSockets() is the runtime's own bookkeeping for every
    // socket handed to acceptWebSocket() below -- unlike an in-memory Set,
    // it's correct even right after this DO wakes from hibernation (a fresh
    // instance's own fields would otherwise start out empty while the
    // browser's sockets are still very much open).
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // Send failed on an already-broken socket; the runtime will drop it
        // from getWebSockets() once the close/error reaches it. Nothing for
        // us to clean up here.
      }
    }
  }

  // ── Hibernation API handlers ──
  // Cloudflare invokes these directly (not via addEventListener) for any
  // socket accepted with state.acceptWebSocket(), including one accepted by
  // a now-evicted earlier instance of this DO -- this is what actually lets
  // the object hibernate between browser-pushed events instead of billing
  // wall-clock time for an idle CRM tab. We don't expect the browser client
  // to send app-level messages (this channel is server -> browser only,
  // see broadcast() above), so webSocketMessage has nothing to act on; it's
  // still implemented so an unexpected message never surfaces as a runtime
  // warning about a missing handler.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // No client-initiated protocol yet -- ignore.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.log("info", `ws closed code=${code} reason=${reason} wasClean=${wasClean}`);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed on the runtime's side -- nothing to do.
    }
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    this.log("warn", `ws error: ${error instanceof Error ? error.message : String(error)}`);
  }

  async fetch(request: Request): Promise<Response> {
    // Defence-in-depth: apps/web already verifies the caller's workspace
    // against the session's before it proxies the request (see index.ts),
    // and the DO re-checks it here so a future code path that skips that
    // gate (e.g. a direct call from another internal worker) can't reach a
    // session it doesn't own. Mismatch → 404 (not 403) so the response
    // doesn't reveal whether the session id exists.
    const claimedWorkspace = request.headers.get("X-Session-Workspace");
    if (claimedWorkspace && claimedWorkspace !== this.state.id.name) {
      const workspaceId = await this.resolveWorkspaceId();
      if (workspaceId !== claimedWorkspace) return new Response("Not found", { status: 404 });
    }

    const url = new URL(request.url);

    // ── POST /internal/emit ── fan an event out to this session's browser
    // WebSockets. Only reachable from inside the worker (e.g. the broadcast
    // queue consumer pushing campaign progress) -- the public
    // /session/:id/* forwarder in index.ts refuses any /internal/* subpath.
    // ── POST /internal/watchdog ── cron bootstrap / safety net. Sessions
    // connected before the watchdog existed have no alarm yet; the engine
    // cron pokes connected sessions here, which arms it. (/internal/* is not
    // reachable through the public /session/:id proxy.)
    if (request.method === "POST" && url.pathname === "/internal/watchdog") {
      await this.ensureInit();
      const want = await this.state.storage.get<boolean>("wantOnline");
      if (want === undefined && (this.connectionState === "connected" || this.connectionState === "connecting")) {
        await this.state.storage.put("wantOnline", true);
      }
      // Don't reconnect inline: the cron pokes up to 200 sessions at once, so
      // an offline one just gets its alarm armed with jitter (spreads the
      // reconnects instead of 200 simultaneous WhatsApp logins).
      if (this.socket && this.connectionState === "connected") {
        if (want !== false) await this.scheduleWatchdog(WATCHDOG_HEALTHY_MS);
        return Response.json({ ok: true, state: this.connectionState, action: "healthy" });
      }
      if ((await this.state.storage.get<boolean>("wantOnline")) === true) {
        await this.scheduleWatchdog(5_000);
        return Response.json({ ok: true, state: this.connectionState, action: "reconnect-scheduled" });
      }
      return Response.json({ ok: true, state: this.connectionState, action: "not-wanted" });
    }

    if (request.method === "POST" && url.pathname === "/internal/emit") {
      const event = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!event || typeof event.type !== "string") {
        return Response.json({ ok: false, error: "Invalid event" }, { status: 400 });
      }
      this.broadcast({ ...event, sessionId: this.sessionIdName });
      return Response.json({ ok: true });
    }

    // ── GET / ──
    if (request.method === "GET" && url.pathname === "/") {
      await this.ensureInit();
      return Response.json(
        {
          sessionId: this.state.id.name,
          connection: this.connectionState,
          qr: this.qr,
          user: this.sessionUser,
          hasSocket: !!this.socket,
          // Onboarding choices made at link time -- shown read-only in the
          // web "View integration" dialog for an already-connected number.
          syncHistory: !this.skipHistorySync,
          syncGroupMembers: !this.skipGroupMemberSync,
          logs: this.logs.slice(-50),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // ── GET /qr ──
    // Serves a single static shell that polls GET / (JSON, same-origin, no
    // reload) every 3s and redraws the canvas only when the qr string
    // actually changes. This avoids the old approach's failure mode: a
    // full `location.reload()` every 15s could land right as WhatsApp
    // rotates the pairing ref (WA rotates it roughly every 18-20s after an
    // initial ~60s window), momentarily showing a code that's about to be
    // (or just was) invalidated server-side -- which WhatsApp reports to
    // the phone as "check your connection and try again" rather than a
    // clear "expired QR" message. Polling in place removes that race
    // (3s << the ~18-20s rotation window) and also survives a transient
    // failure to load the qrcode.js CDN script on any single poll.
    if (request.method === "GET" && url.pathname === "/qr") {
      await this.ensureInit();
      return new Response(
        `<!DOCTYPE html><html><head>
          <script src="https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js"></script>
        </head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif">
          <h2>WhatsApp Session: ${this.state.id.name}</h2>
          <p id="status">Loading...</p>
          <canvas id="qr" style="display:none"></canvas>
          <p style="color:#888;margin-top:1rem">This page updates itself automatically -- leave it open.</p>
          <script>
            let lastQr = null;
            async function poll() {
              try {
                const res = await fetch('./', { cache: 'no-store' });
                const data = await res.json();
                const statusEl = document.getElementById('status');
                const canvasEl = document.getElementById('qr');
                if (data.connection === 'connected') {
                  statusEl.textContent = 'Connected as ' + (data.user || '');
                  canvasEl.style.display = 'none';
                  return; // stop polling once connected
                }
                if (data.qr) {
                  statusEl.textContent = 'Scan with WhatsApp -> Linked Devices -> Link a Device';
                  canvasEl.style.display = '';
                  if (data.qr !== lastQr && window.QRCode) {
                    lastQr = data.qr;
                    QRCode.toCanvas(canvasEl, data.qr, { width: 300, margin: 2 });
                  }
                } else {
                  statusEl.textContent = 'State: ' + data.connection + ' -- waiting for QR...';
                  canvasEl.style.display = 'none';
                }
              } catch (e) {
                document.getElementById('status').textContent = 'Reconnecting to server...';
              } finally {
                setTimeout(poll, 3000);
              }
            }
            poll();
          </script>
        </body></html>`,
        {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        }
      );
    }

    // ── GET /logs ──
    if (request.method === "GET" && url.pathname === "/logs") {
      await this.ensureInit();
      return Response.json({ logs: this.logs.slice(-100) });
    }

    // ── GET /ws ── WebSocket upgrade for real-time message events ──
    // Requires a short-lived HMAC token (?token=<payload>.<sig>) generated
    // by the engine's /session/:id/ws-token endpoint. Internal callers
    // (service binding with X-Session-Workspace) are also allowed.
    if (request.method === "GET" && url.pathname === "/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return Response.json({ error: "Expected WebSocket upgrade" }, { status: 426 });
      }

      // Allow internal callers (service binding) without a token
      const isInternal = !!request.headers.get("X-Session-Workspace");

      if (!isInternal) {
        const token = url.searchParams.get("token");
        if (!token) {
          return Response.json({ error: "Missing token" }, { status: 401 });
        }
        const parts = token.split(".");
        if (parts.length !== 2) {
          return Response.json({ error: "Invalid token" }, { status: 401 });
        }
        const [payloadB64, sigHex] = parts;
        try {
          // Verify HMAC
          const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(this.env.WS_TOKEN_SECRET),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["verify"],
          );
          const sigBytes = Uint8Array.from(sigHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
          const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payloadB64));
          if (!valid) {
            return Response.json({ error: "Invalid token signature" }, { status: 401 });
          }
          // Check expiry
          const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
          if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
            return Response.json({ error: "Token expired" }, { status: 401 });
          }
          // Verify session ID matches
          if (payload.sid !== this.state.id.name) {
            return Response.json({ error: "Token session mismatch" }, { status: 401 });
          }
        } catch {
          return Response.json({ error: "Invalid token" }, { status: 401 });
        }
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // acceptWebSocket() (not addEventListener) is what makes this socket
      // hibernation-safe: the runtime keeps it in state.getWebSockets() and
      // will wake this DO via webSocketMessage/webSocketClose/webSocketError
      // below even after an eviction, so broadcast() above always sees every
      // live client regardless of which instance handled the original /ws
      // upgrade.
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── POST /connect ──
    if (request.method === "POST" && url.pathname === "/connect") {
      await this.ensureInit();
      const body = (await request.json().catch(() => ({}))) as {
        force?: boolean;
        // Onboarding options, both default true (current behavior) so
        // every existing caller that doesn't send them is unaffected.
        // syncHistory=false skips messaging-history.set's message
        // backfill; syncGroupMembers=false skips resolving group
        // participants into contacts at connect/history time (group
        // metadata itself still syncs regardless -- see
        // POST /group-members-sync for pulling a specific group's
        // members in later, on demand).
        syncHistory?: boolean;
        syncGroupMembers?: boolean;
      };
      const isHealthy = this.socket && (this.connectionState === "connected" || this.connectionState === "qr");
      if (isHealthy && !body.force) {
        return Response.json({ ok: true, message: "Already running" });
      }
      // Wait for any in-flight startSocket() (ensureInit / reconnect)
      // so we don't tear down mid-setup or start a second makeWASocket.
      if (this.startPromise) await this.startPromise.catch(() => {});
      // Tear down stale socket before reconnecting
      if (this.socket) {
        await this.socket.end(undefined).catch(() => {});
        this.socket = null;
      }
      this.intentionalDisconnect = false;
      this.connectionState = "idle";
      this.qr = null;
      this.skipHistorySync = body.syncHistory === false;
      this.skipGroupMemberSync = body.syncGroupMembers === false;
      // "Sync history now" is a force reconnect with the same saved creds.
      // Baileys treats accountSyncCounter > 0 as "history already delivered"
      // and never waits for (or gets) another messaging-history.set — so the
      // button was a silent no-op after the first connect. Clear the markers
      // so this reconnect behaves like a fresh history fetch again.
      if (body.force && !this.skipHistorySync) {
        this.resetHistorySyncMarkers();
      }
      // A manual (re)connect always does the full group refetch, bypassing
      // the reconnect throttle.
      this.state.storage.delete("groupsSyncedAt");
      this.persist();
      this.state.storage.delete("qr");
      this.state.storage.put("skipHistorySync", this.skipHistorySync);
      this.state.storage.put("skipGroupMemberSync", this.skipGroupMemberSync);
      // Use waitUntil so async errors don't kill the DO
      this.state.waitUntil(this.startSocket());
      return Response.json({ ok: true, message: "Connection started" });
    }

    // ── POST /send ──
    if (request.method === "POST" && url.pathname === "/send") {
      // IMPORTANT: every other handler (/, /qr, /logs, /connect, /pair)
      // calls ensureInit() first. This one didn't, which is why a fresh
      // (post-eviction) DO instance always saw socket=null and
      // connectionState="idle" here and rejected the send outright,
      // without ever trying to rehydrate the socket from storage.
      await this.ensureInit();
      this.log(
        "info",
        `POST /send: socket=${!!this.socket} state=${this.connectionState} intentionalDisconnect=${this.intentionalDisconnect}`
      );
      if (!this.socket) {
        this.log("warn", `POST /send REJECTED: socket is null. State: ${this.connectionState}`);
        return Response.json(
          {
            ok: false,
            error: "Socket not running. POST /connect first.",
            state: this.connectionState,
            hasSocket: false,
          },
          { status: 400 }
        );
      }
      const body = readJson<{ to?: string; text?: string }>(await request.json());
      if (!body.to || !body.text) {
        return Response.json({ ok: false, error: "Missing 'to' or 'text' field" }, { status: 400 });
      }
      try {
        // Normalize JID: add @s.whatsapp.net if no @ present
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        // Resolve LID JIDs to phone JIDs (Baileys can't send to @lid)
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        if (isLidJid(jid)) {
          this.log("warn", `Cannot resolve LID JID ${body.to} to phone JID — send may fail`);
        }
        const outboundBlocked = await this.guardOutbound(jid, request);
        if (outboundBlocked) return outboundBlocked;
        const result = await this.socket.sendMessage(jid, { text: body.text });

        // Write the outbound message to D1 immediately — the CRM inbox
        // shouldn't wait on messages.upsert to echo our own send back.
        const workspaceId = await this.resolveWorkspaceId();
        if (workspaceId && result?.key) {
          try {
            await syncIncomingMessage(this.db, workspaceId, this.sessionIdName, {
              waMessageId: result.key.id ?? crypto.randomUUID(),
              remoteJid: jid,
              fromMe: true,
              type: "text",
              body: body.text,
              timestampMs: Date.now(),
            });
          } catch (syncErr: any) {
            this.log("error", `D1 sync failed for sent message: ${syncErr?.message || syncErr}`);
          }
        }

        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `Send failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Send failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /read ──
    // Mark inbound messages as read on WhatsApp when an agent opens a thread.
    // The CRM clears its own unread counter separately; this route only sends
    // the WhatsApp receipt and is intentionally best-effort per key.
    if (request.method === "POST" && url.pathname === "/read") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        keys?: unknown;
      };
      const keys = Array.isArray(body.keys)
        ? body.keys.filter(
            (
              key
            ): key is {
              remoteJid: string;
              id: string;
              fromMe?: boolean;
              participant?: string;
            } =>
              !!key &&
              typeof key === "object" &&
              typeof (key).remoteJid === "string" &&
              typeof (key).id === "string"
          )
        : [];
      if (keys.length === 0) return Response.json({ ok: true, read: 0 });
      try {
        await this.socket.readMessages(keys);
        return Response.json({ ok: true, read: keys.length });
      } catch (err: any) {
        this.log("error", `Read receipt failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Read receipt failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /send-media ──
    // Attachments (image/video/audio/document) picked in the composer.
    // multipart/form-data because these can be several MB -- base64-in-JSON
    // would blow up ~33% larger for no reason. Mirrors /send: sends via
    // Baileys first, then best-effort stores our own copy in R2 + D1 so the
    // outbound bubble shows up immediately without waiting on a
    // messages.upsert echo (which WhatsApp doesn't even reliably send back
    // for our own outgoing messages).
    if (request.method === "POST" && url.pathname === "/send-media") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running. POST /connect first.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return Response.json({ ok: false, error: "Expected multipart/form-data" }, { status: 400 });
      }

      const to = form.get("to");
      const type = form.get("type");
      const caption = form.get("caption");
      const file = form.get("file");

      if (typeof to !== "string" || !to) {
        return Response.json({ ok: false, error: "Missing 'to' field" }, { status: 400 });
      }
      const validTypes = ["image", "video", "audio", "document"] as const;
      if (typeof type !== "string" || !(validTypes as readonly string[]).includes(type)) {
        return Response.json(
          {
            ok: false,
            error: "'type' must be one of image, video, audio, document",
          },
          { status: 400 }
        );
      }
      if (!(file instanceof File)) {
        return Response.json({ ok: false, error: "Missing 'file'" }, { status: 400 });
      }

      const mediaType = type as "image" | "video" | "audio" | "document";
      const captionText = typeof caption === "string" && caption.trim() ? caption.trim() : undefined;

      try {
        let jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        if (isLidJid(jid)) {
          this.log("warn", `Cannot resolve LID JID ${to} to phone JID — send may fail`);
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const mime = file.type || "application/octet-stream";

        let content: any;
        if (mediaType === "image") {
          content = { image: buffer, mimetype: mime, caption: captionText };
        } else if (mediaType === "video") {
          content = { video: buffer, mimetype: mime, caption: captionText };
        } else if (mediaType === "audio") {
          // Attachments go out as a regular playable audio file, not a
          // voice note (ptt) -- the mic button (if/when we build one) is
          // the ptt path, this is "attach an existing audio file".
          content = { audio: buffer, mimetype: mime, ptt: false };
        } else {
          content = {
            document: buffer,
            mimetype: mime,
            fileName: file.name || "file",
            caption: captionText,
          };
        }

        const outboundBlocked = await this.guardOutbound(jid, request);
        if (outboundBlocked) return outboundBlocked;
        const result = await this.socket.sendMessage(jid, content);

        const workspaceId = await this.resolveWorkspaceId();
        if (workspaceId && result?.key) {
          const waMessageId = result.key.id ?? crypto.randomUUID();
          try {
            const stored = await storeOutgoingMedia(
              this.env,
              workspaceId,
              this.sessionIdName,
              waMessageId,
              buffer,
              mime,
              mediaType,
              file.name || undefined
            );
            await syncIncomingMessage(this.db, workspaceId, this.sessionIdName, {
              waMessageId,
              remoteJid: jid,
              fromMe: true,
              type: mediaType,
              body: captionText,
              mediaKey: stored.mediaKey,
              mediaMime: stored.mediaMime,
              mediaMeta: stored.mediaMeta,
              timestampMs: Date.now(),
            });
          } catch (syncErr: any) {
            this.log("error", `D1/R2 sync failed for sent media: ${syncErr?.message || syncErr}`);
          }
        }

        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `Send-media failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Send-media failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /send-template ──
    // Sends a message template (picked from the composer's template
    // button, or by a broadcast campaign) as a normal outbound message.
    // `text` here is already variable-resolved by the caller -- this
    // route only knows how to send, not how to fill in {{placeholders}}.
    // `mediaKey` (optional) points at an R2 object already uploaded via
    // POST /media/upload -- reused as-is rather than copied per send,
    // since the bytes are immutable either way (mirrors /send-media, but
    // pulls the file from R2 instead of the request body).
    if (request.method === "POST" && url.pathname === "/send-template") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running. POST /connect first.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        text?: string;
        mediaKey?: string;
      };
      if (!body.to) {
        return Response.json({ ok: false, error: "Missing 'to' field" }, { status: 400 });
      }
      if (!body.text && !body.mediaKey) {
        return Response.json({ ok: false, error: "Template has neither text nor media" }, { status: 400 });
      }

      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        if (isLidJid(jid)) {
          this.log("warn", `Cannot resolve LID JID ${body.to} to phone JID — send may fail`);
        }

        let mediaType: "image" | "video" | "audio" | "document" | null = null;
        let mediaMime: string | null = null;
        let content: any;

        if (body.mediaKey) {
          const object = await this.env.MEDIA.get(body.mediaKey);
          if (!object) {
            return Response.json({ ok: false, error: "Template media not found in storage" }, { status: 404 });
          }
          const buffer = Buffer.from(await object.arrayBuffer());
          mediaMime = object.httpMetadata?.contentType || "application/octet-stream";
          mediaType = mediaTypeFromMime(mediaMime);
          const captionText = body.text?.trim() || undefined;
          if (mediaType === "image")
            content = {
              image: buffer,
              mimetype: mediaMime,
              caption: captionText,
            };
          else if (mediaType === "video")
            content = {
              video: buffer,
              mimetype: mediaMime,
              caption: captionText,
            };
          else if (mediaType === "audio") content = { audio: buffer, mimetype: mediaMime, ptt: false };
          else
            content = {
              document: buffer,
              mimetype: mediaMime,
              fileName: body.mediaKey.split("/").pop() || "file",
              caption: captionText,
            };
        } else {
          content = { text: body.text };
        }

        const outboundBlocked = await this.guardOutbound(jid, request);
        if (outboundBlocked) return outboundBlocked;
        const result = await this.socket.sendMessage(jid, content);

        const workspaceId = await this.resolveWorkspaceId();
        if (workspaceId && result?.key) {
          try {
            await syncIncomingMessage(this.db, workspaceId, this.sessionIdName, {
              waMessageId: result.key.id ?? crypto.randomUUID(),
              remoteJid: jid,
              fromMe: true,
              type: mediaType ?? "text",
              body: body.text || undefined,
              mediaKey: body.mediaKey,
              mediaMime: mediaMime ?? undefined,
              timestampMs: Date.now(),
            });
          } catch (syncErr: any) {
            this.log("error", `D1 sync failed for sent template: ${syncErr?.message || syncErr}`);
          }
        }

        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `Send-template failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Send-template failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /refresh-profile ──
    // Fetches a contact's real profile picture + "about" status on demand —
    // not eagerly for every contact. contacts.upsert's imgUrl field is
    // usually empty (Baileys only fills it when a store is watching), so
    // this is the actual way to get a photo, and doing it lazily (one
    // contact at a time, when the CRM shows interest in them) avoids
    // hammering WhatsApp the way a bulk profile-scrape would.
    if (request.method === "POST" && url.pathname === "/refresh-profile") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running. POST /connect first.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = readJson<{ jid?: string }>(await request.json());
      if (!body.jid) {
        return Response.json({ ok: false, error: "Missing 'jid' field" }, { status: 400 });
      }
      let jid = body.jid.includes("@") ? body.jid : `${body.jid}@s.whatsapp.net`;
      jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);

      // Each of these throws independently when the contact's privacy
      // settings hide it (or it's a group/broadcast jid) — fetch them
      // separately so one missing field doesn't blank out the other.
      let avatarUrl: string | null = null;
      let about: string | null = null;
      try {
        avatarUrl = (await this.socket.profilePictureUrl(jid, "image")) ?? null;
      } catch (err: any) {
        this.log("info", `profilePictureUrl(${jid}) unavailable: ${err?.message || err}`);
      }
      try {
        const status = await this.socket.fetchStatus(jid);
        about = (status as any)?.status ?? null;
      } catch (err: any) {
        this.log("info", `fetchStatus(${jid}) unavailable: ${err?.message || err}`);
      }

      return Response.json({ ok: true, jid, avatarUrl, about });
    }

    // ── POST /pair ──
    // Alternative to QR scanning: WhatsApp -> Linked Devices -> Link with phone number.
    // Uses a different WA-side code path than QR scanning, so if this also fails with
    // "check your connection", the bug is in the general pairing exchange, not QR-specific.
    if (request.method === "POST" && url.pathname === "/pair") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json({ ok: false, error: "Socket not running. POST /connect first." }, { status: 400 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        phone?: string;
      };
      const phone = (body.phone || "").replace(/[^0-9]/g, "");
      if (!phone) {
        return Response.json(
          {
            ok: false,
            error: "Missing 'phone' field (digits only, with country code, no +)",
          },
          { status: 400 }
        );
      }
      try {
        const code = await this.socket.requestPairingCode(phone);
        this.log("info", `Pairing code requested for ${phone}: ${code}`);
        return Response.json({ ok: true, code });
      } catch (err: any) {
        this.log("error", `requestPairingCode failed: ${err?.stack || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "requestPairingCode failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /disconnect ──
    if (request.method === "POST" && url.pathname === "/disconnect") {
      this.intentionalDisconnect = true;
      if (this.socket) {
        await this.socket.end(undefined).catch(() => {});
        this.socket = null;
      }
      this.connectionState = "disconnected";
      this.qr = null;
      this.persist();
      this.state.storage.delete("qr");
      this.state.waitUntil(
        (async () => {
          try {
            const wsId = await this.resolveWorkspaceId();
            if (wsId) {
              await markSessionStatus(this.db, this.sessionIdName, "disconnected");
            }
          } catch {}
        })()
      );
      return Response.json({ ok: true });
    }

    // ── POST /react ── Send a reaction to a message ──
    if (request.method === "POST" && url.pathname === "/react") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        messageId?: string;
        emoji?: string;
        fromMe?: boolean;
        participant?: string;
      };
      if (!body.to || !body.messageId) {
        return Response.json({ ok: false, error: "Missing 'to' or 'messageId'" }, { status: 400 });
      }
      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        // The key must match the ORIGINAL message exactly -- fromMe wrong
        // means Baileys can't resolve which message this reacts to, and
        // for group messages the sender's participant jid is required too.
        const key: any = {
          remoteJid: jid,
          id: body.messageId,
          fromMe: body.fromMe ?? false,
        };
        if (jid.endsWith("@g.us") && !key.fromMe && body.participant) key.participant = body.participant;
        const result = await this.socket.sendMessage(jid, {
          react: { text: body.emoji || "", key },
        });
        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `React failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "React failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /edit ── Edit a sent message ──
    if (request.method === "POST" && url.pathname === "/edit") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        messageId?: string;
        text?: string;
      };
      if (!body.to || !body.messageId || !body.text) {
        return Response.json({ ok: false, error: "Missing 'to', 'messageId', or 'text'" }, { status: 400 });
      }
      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        const key = { remoteJid: jid, id: body.messageId, fromMe: true };
        const result = await this.socket.sendMessage(jid, {
          text: body.text,
          edit: key,
        });
        // Sync edit to D1
        const workspaceId = await this.resolveWorkspaceId();
        if (workspaceId) {
          const conversationId = await markMessageEdited(this.db, workspaceId, body.messageId, body.text);
          this.broadcast({
            type: "message-edited",
            sessionId: this.sessionIdName,
            workspaceId,
            messageId: body.messageId,
            newBody: body.text,
            conversationId: conversationId ?? undefined,
          });
        }
        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `Edit failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Edit failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /delete ── Delete a message for everyone ──
    if (request.method === "POST" && url.pathname === "/delete") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        messageId?: string;
        fromMe?: boolean;
        participant?: string;
      };
      if (!body.to || !body.messageId) {
        return Response.json({ ok: false, error: "Missing 'to' or 'messageId'" }, { status: 400 });
      }
      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        // "Delete for everyone" only works on your own messages, but
        // "delete for me" can target either -- always pass the real
        // fromMe of the message being deleted, never assume it.
        const key: any = {
          remoteJid: jid,
          id: body.messageId,
          fromMe: body.fromMe ?? true,
        };
        if (jid.endsWith("@g.us") && !key.fromMe && body.participant) key.participant = body.participant;
        await this.socket.sendMessage(jid, { delete: key });
        // Soft-delete in D1
        const workspaceId = await this.resolveWorkspaceId();
        if (workspaceId) {
          const conversationId = await markMessageDeleted(this.db, workspaceId, body.messageId);
          this.broadcast({
            type: "message-deleted",
            sessionId: this.sessionIdName,
            workspaceId,
            messageId: body.messageId,
            conversationId: conversationId ?? undefined,
          });
        }
        return Response.json({ ok: true });
      } catch (err: any) {
        this.log("error", `Delete failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Delete failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /chat-modify ── Archive/mute/pin/unpin a chat ──
    if (request.method === "POST" && url.pathname === "/chat-modify") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        jid?: string;
        archive?: boolean;
        mute?: number | null;
        pin?: boolean;
        markRead?: boolean;
      };
      if (!body.jid) {
        return Response.json({ ok: false, error: "Missing 'jid'" }, { status: 400 });
      }
      try {
        let jid = body.jid.includes("@") ? body.jid : `${body.jid}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        const modification: Record<string, unknown> = {};
        if (body.archive !== undefined) modification.archive = body.archive;
        if (body.mute !== undefined) modification.mute = body.mute;
        if (body.pin !== undefined) modification.pin = body.pin;
        if (body.markRead !== undefined) modification.markRead = body.markRead;
        await this.socket.chatModify(modification as any, jid);
        // Sync state to D1
        const workspaceId = await this.resolveWorkspaceId();
        if (workspaceId) {
          const update: Record<string, any> = {};
          if (body.archive !== undefined) update.archived = body.archive;
          if (body.mute !== undefined) update.muted = body.mute !== null;
          if (Object.keys(update).length > 0) {
            await updateConversationChatState(this.db, workspaceId, this.sessionIdName, jid, update);
          }
        }
        return Response.json({ ok: true });
      } catch (err: any) {
        this.log("error", `Chat-modify failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Chat-modify failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /presence ── Send presence update (typing indicator, online/offline) ──
    if (request.method === "POST" && url.pathname === "/presence") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        jid?: string;
        presence?: string;
      };
      if (!body.presence) {
        return Response.json(
          {
            ok: false,
            error: "Missing 'presence' (available|unavailable|composing|recording|paused)",
          },
          { status: 400 }
        );
      }
      try {
        const validPresences = ["available", "unavailable", "composing", "recording", "paused"];
        if (!validPresences.includes(body.presence)) {
          return Response.json(
            {
              ok: false,
              error: `'presence' must be one of: ${validPresences.join(", ")}`,
            },
            { status: 400 }
          );
        }
        let jid: string | undefined;
        if (body.jid) {
          jid = body.jid.includes("@") ? body.jid : `${body.jid}@s.whatsapp.net`;
          jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        }
        await this.socket.sendPresenceUpdate(body.presence as any, jid);
        return Response.json({ ok: true });
      } catch (err: any) {
        this.log("error", `Presence failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Presence failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /group-create ── Create a WhatsApp group ──
    if (request.method === "POST" && url.pathname === "/group-create") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        subject?: string;
        participants?: string[];
      };
      if (!body.subject || !body.participants?.length) {
        return Response.json({ ok: false, error: "Missing 'subject' or 'participants'" }, { status: 400 });
      }
      try {
        const resolvedParticipants = await Promise.all(
          body.participants.map(async (p) => {
            const jid = p.includes("@") ? p : `${p}@s.whatsapp.net`;
            return resolveToPhoneJid(this.db, this.sessionIdName, jid);
          })
        );
        const result = await this.socket.groupCreate(body.subject, resolvedParticipants);
        return Response.json({ ok: true, id: result.id });
      } catch (err: any) {
        this.log("error", `Group create failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Group create failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /group-participants ── Add/remove/promote/demote group participants ──
    if (request.method === "POST" && url.pathname === "/group-participants") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        groupJid?: string;
        participants?: string[];
        action?: string;
      };
      if (!body.groupJid || !body.participants?.length || !body.action) {
        return Response.json(
          {
            ok: false,
            error: "Missing 'groupJid', 'participants', or 'action'",
          },
          { status: 400 }
        );
      }
      const validActions = ["add", "remove", "promote", "demote"];
      if (!validActions.includes(body.action)) {
        return Response.json(
          {
            ok: false,
            error: `'action' must be one of: ${validActions.join(", ")}`,
          },
          { status: 400 }
        );
      }
      try {
        const groupJid = body.groupJid.includes("@") ? body.groupJid : `${body.groupJid}@g.us`;
        const resolvedParticipants = await Promise.all(
          body.participants.map(async (p) => {
            const jid = p.includes("@") ? p : `${p}@s.whatsapp.net`;
            return resolveToPhoneJid(this.db, this.sessionIdName, jid);
          })
        );
        const result = await this.socket.groupParticipantsUpdate(groupJid, resolvedParticipants, body.action as any);
        return Response.json({ ok: true, participants: result });
      } catch (err: any) {
        this.log("error", `Group participants failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Group participants failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /group-settings ── Update group subject/description/settings ──
    if (request.method === "POST" && url.pathname === "/group-settings") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        groupJid?: string;
        subject?: string;
        description?: string;
        setting?: "announcement" | "not_announcement" | "locked" | "unlocked";
      };
      if (!body.groupJid) {
        return Response.json({ ok: false, error: "Missing 'groupJid'" }, { status: 400 });
      }
      try {
        const groupJid = body.groupJid.includes("@") ? body.groupJid : `${body.groupJid}@g.us`;
        if (body.subject) await this.socket.groupUpdateSubject(groupJid, body.subject);
        if (body.description) await this.socket.groupUpdateDescription(groupJid, body.description);
        if (body.setting) await this.socket.groupSettingUpdate(groupJid, body.setting);
        return Response.json({ ok: true });
      } catch (err: any) {
        this.log("error", `Group settings failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Group settings failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /group-members-sync ── Pull one group's current member list
    // and resolve every participant into a CRM contact, on demand. This is
    // the escape hatch for a session connected with syncGroupMembers=false
    // (see POST /connect) -- or for any group whose roster has since
    // changed -- to opt a specific group in without needing to
    // disconnect/reconnect or affecting any other group. Always runs
    // regardless of this.skipGroupMemberSync, since it's an explicit,
    // per-group user action.
    if (request.method === "POST" && url.pathname === "/group-members-sync") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          { ok: false, error: "Socket not running.", state: this.connectionState },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as { groupJid?: string };
      if (!body.groupJid) {
        return Response.json({ ok: false, error: "Missing 'groupJid'" }, { status: 400 });
      }
      const groupJid = body.groupJid.includes("@") ? body.groupJid : `${body.groupJid}@g.us`;
      try {
        const wsId = await this.resolveWorkspaceId();
        if (!wsId) {
          return Response.json({ ok: false, error: "Workspace not resolved yet" }, { status: 409 });
        }
        const metadata = await this.socket.groupMetadata(groupJid);
        const group = await upsertGroupMetadata(this.db, wsId, this.sessionIdName, {
          jid: groupJid,
          name: metadata.subject || null,
          participantCount: metadata.participants.length,
        });
        if (metadata.participants.length) {
          await upsertGroupMembers(this.db, wsId, this.sessionIdName, group.id, metadata.participants);
        }
        return Response.json({ ok: true, memberCount: metadata.participants.length });
      } catch (err: any) {
        this.log("error", `group-members-sync failed for ${groupJid}: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Group sync failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /group-leave ── Leave a group ──
    if (request.method === "POST" && url.pathname === "/group-leave") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        groupJid?: string;
      };
      if (!body.groupJid) {
        return Response.json({ ok: false, error: "Missing 'groupJid'" }, { status: 400 });
      }
      try {
        const groupJid = body.groupJid.includes("@") ? body.groupJid : `${body.groupJid}@g.us`;
        await this.socket.groupLeave(groupJid);
        return Response.json({ ok: true });
      } catch (err: any) {
        this.log("error", `Group leave failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Group leave failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /forward ── Forward a message ──
    if (request.method === "POST" && url.pathname === "/forward") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        messageId?: string;
        fromJid?: string;
        text?: string;
      };
      if (!body.to || !body.messageId) {
        return Response.json({ ok: false, error: "Missing 'to' or 'messageId'" }, { status: 400 });
      }
      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        // Baileys' `forward` content type needs the ORIGINAL message's real
        // content, resolved from its own message store via a getMessage()
        // callback we don't have wired up here -- without it, `message: {}`
        // sends a genuinely empty message (this was the bug: forwards
        // arrived blank). We don't keep raw WAMessage protos around, only
        // the text body in D1, so forwarding is implemented as re-sending
        // that same content to the new recipient instead.
        const outboundBlocked = await this.guardOutbound(jid, request);
        if (outboundBlocked) return outboundBlocked;
        const result = body.text
          ? await this.socket.sendMessage(jid, { text: body.text })
          : await this.socket.sendMessage(jid, {
              forward: {
                key: {
                  remoteJid: body.fromJid || jid,
                  id: body.messageId,
                  fromMe: true,
                },
                message: {},
              },
            });
        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `Forward failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Forward failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /pin ── Pin/unpin a message ──
    if (request.method === "POST" && url.pathname === "/pin") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        messageId?: string;
        pin?: boolean;
        time?: number;
        fromMe?: boolean;
        participant?: string;
      };
      if (!body.to || !body.messageId) {
        return Response.json({ ok: false, error: "Missing 'to' or 'messageId'" }, { status: 400 });
      }
      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        const key: any = {
          remoteJid: jid,
          id: body.messageId,
          fromMe: body.fromMe ?? false,
        };
        if (jid.endsWith("@g.us") && !key.fromMe && body.participant) key.participant = body.participant;
        const result = await this.socket.sendMessage(jid, {
          pin: {
            type: (body.pin !== false ? 1 : 0) as any,
            time: body.time || 86400,
            key,
          },
        } as any);
        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `Pin failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Pin failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /poll ── Send a poll message ──
    if (request.method === "POST" && url.pathname === "/poll") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        name?: string;
        values?: string[];
        selectableCount?: number;
      };
      if (!body.to || !body.name || !body.values?.length) {
        return Response.json({ ok: false, error: "Missing 'to', 'name', or 'values'" }, { status: 400 });
      }
      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        const outboundBlocked = await this.guardOutbound(jid, request);
        if (outboundBlocked) return outboundBlocked;
        const result = await this.socket.sendMessage(jid, {
          poll: {
            name: body.name,
            values: body.values,
            selectableCount: body.selectableCount ?? 1,
          },
        });
        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `Poll failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Poll failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /location ── Send a location message ──
    if (request.method === "POST" && url.pathname === "/location") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        latitude?: number;
        longitude?: number;
      };
      if (!body.to || body.latitude === undefined || body.longitude === undefined) {
        return Response.json({ ok: false, error: "Missing 'to', 'latitude', or 'longitude'" }, { status: 400 });
      }
      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        const outboundBlocked = await this.guardOutbound(jid, request);
        if (outboundBlocked) return outboundBlocked;
        const result = await this.socket.sendMessage(jid, {
          location: {
            degreesLatitude: body.latitude,
            degreesLongitude: body.longitude,
          },
        });
        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `Location failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Location failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /contact-card ── Send a contact/vCard message ──
    if (request.method === "POST" && url.pathname === "/contact-card") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        displayName?: string;
        vcard?: string;
      };
      if (!body.to || !body.vcard) {
        return Response.json({ ok: false, error: "Missing 'to' or 'vcard'" }, { status: 400 });
      }
      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        const outboundBlocked = await this.guardOutbound(jid, request);
        if (outboundBlocked) return outboundBlocked;
        const result = await this.socket.sendMessage(jid, {
          contacts: {
            displayName: body.displayName || "",
            contacts: [{ vcard: body.vcard }],
          },
        });
        return Response.json({ ok: true, key: result?.key });
      } catch (err: any) {
        this.log("error", `Contact card failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Contact card failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /profile ── Update profile status/name/picture ──
    if (request.method === "POST" && url.pathname === "/profile") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        status?: string;
        name?: string;
      };
      try {
        if (body.status !== undefined) await this.socket.updateProfileStatus(body.status);
        if (body.name !== undefined) await this.socket.updateProfileName(body.name);
        return Response.json({ ok: true });
      } catch (err: any) {
        this.log("error", `Profile update failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Profile update failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /group-invite ── Get/revoke group invite code ──
    if (request.method === "POST" && url.pathname === "/group-invite") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        groupJid?: string;
        action?: "get" | "revoke";
      };
      if (!body.groupJid || !body.action) {
        return Response.json({ ok: false, error: "Missing 'groupJid' or 'action'" }, { status: 400 });
      }
      try {
        const groupJid = body.groupJid.includes("@") ? body.groupJid : `${body.groupJid}@g.us`;
        const code =
          body.action === "revoke"
            ? await this.socket.groupRevokeInvite(groupJid)
            : await this.socket.groupInviteCode(groupJid);
        return Response.json({
          ok: true,
          code,
          link: `https://chat.whatsapp.com/${code}`,
        });
      } catch (err: any) {
        this.log("error", `Group invite failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Group invite failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /group-ephemeral ── Toggle disappearing messages in a group ──
    if (request.method === "POST" && url.pathname === "/group-ephemeral") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        groupJid?: string;
        duration?: number;
      };
      if (!body.groupJid || body.duration === undefined) {
        return Response.json(
          {
            ok: false,
            error: "Missing 'groupJid' or 'duration' (seconds, 0 to disable)",
          },
          { status: 400 }
        );
      }
      try {
        const groupJid = body.groupJid.includes("@") ? body.groupJid : `${body.groupJid}@g.us`;
        await this.socket.groupToggleEphemeral(groupJid, body.duration);
        return Response.json({ ok: true });
      } catch (err: any) {
        this.log("error", `Group ephemeral failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Group ephemeral failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /block ── Block/unblock a user ──
    if (request.method === "POST" && url.pathname === "/block") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        jid?: string;
        action?: "block" | "unblock";
      };
      if (!body.jid || !body.action) {
        return Response.json({ ok: false, error: "Missing 'jid' or 'action'" }, { status: 400 });
      }
      try {
        let jid = body.jid.includes("@") ? body.jid : `${body.jid}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        await this.socket.updateBlockStatus(jid, body.action);
        // Messages for this session are processed by this same DO, so the
        // block takes effect immediately rather than after the cache TTL.
        invalidateBlockedCache(this.sessionIdName);
        return Response.json({ ok: true });
      } catch (err: any) {
        this.log("error", `Block failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Block failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── POST /disappearing ── Toggle disappearing messages for a chat ──
    if (request.method === "POST" && url.pathname === "/disappearing") {
      await this.ensureInit();
      if (!this.socket) {
        return Response.json(
          {
            ok: false,
            error: "Socket not running.",
            state: this.connectionState,
          },
          { status: 400 }
        );
      }
      const body = (await request.json().catch(() => ({}))) as {
        to?: string;
        duration?: number;
      };
      if (!body.to || body.duration === undefined) {
        return Response.json(
          {
            ok: false,
            error: "Missing 'to' or 'duration' (seconds, 0 to disable)",
          },
          { status: 400 }
        );
      }
      try {
        let jid = body.to.includes("@") ? body.to : `${body.to}@s.whatsapp.net`;
        jid = await resolveToPhoneJid(this.db, this.sessionIdName, jid);
        await this.socket.sendMessage(jid, {
          disappearingMessagesInChat: body.duration || (false as any),
        });
        return Response.json({ ok: true });
      } catch (err: any) {
        this.log("error", `Disappearing messages failed: ${err?.message || err}`);
        return Response.json({ ok: false, error: publicMessage(err, "Disappearing messages failed. Please try again.") }, { status: publicStatus(err) });
      }
    }

    // ── GET /crypto-test ──
    if (request.method === "GET" && url.pathname === "/crypto-test") {
      const results: Record<string, string> = {};

      try {
        // Test SHA-256
        const hash = createHash("sha256").update("test").digest("hex");
        results.sha256 = hash;
        results.sha256_ok =
          hash === "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" ? "PASS" : "FAIL";
      } catch (e: any) {
        results.sha256 = `ERROR: ${e.message}`;
      }

      try {
        // Test HMAC-SHA256
        const hmac = createHmac("sha256", "key").update("message").digest("hex");
        results.hmac = hmac;
        results.hmac_ok = hmac === "6e9ef29b75fffc5b7abae527d58fdadb2fe42e7219011976917343065f58ed4a" ? "PASS" : "FAIL";
      } catch (e: any) {
        results.hmac = `ERROR: ${e.message}`;
      }

      try {
        // Test AES-256-GCM
        const key = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.alloc(0));
        const encrypted = Buffer.concat([cipher.update(Buffer.from("hello")), cipher.final(), cipher.getAuthTag()]);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.alloc(0));
        decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
        const decrypted = Buffer.concat([
          decipher.update(encrypted.subarray(0, encrypted.length - 16)),
          decipher.final(),
        ]);
        results.aes_gcm = decrypted.toString();
        results.aes_gcm_ok = decrypted.toString() === "hello" ? "PASS" : "FAIL";
      } catch (e: any) {
        results.aes_gcm = `ERROR: ${e.message}`;
      }

      try {
        // Test randomBytes
        const rb = randomBytes(32);
        results.randomBytes = `length=${rb.length}`;
        results.randomBytes_ok = rb.length === 32 ? "PASS" : "FAIL";
      } catch (e: any) {
        results.randomBytes = `ERROR: ${e.message}`;
      }

      return Response.json(results);
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Socket lifecycle ──────────────────────────────────────────────────

  /**
   * Clears Baileys' "history already synced for this device" markers so the
   * next connect waits for (and processes) messaging-history.set again.
   * Safe: only touches accountSyncCounter / processedHistoryMessages — pairing
   * keys and signal state stay intact, so no re-scan is needed.
   */
  private resetHistorySyncMarkers(): void {
    try {
      const rows = this.state.storage.sql
        .exec("SELECT value FROM wa_creds WHERE key = ?", "creds")
        .toArray();
      if (!rows.length) return;
      const creds = JSON.parse(rows[0].value as string, BufferJSON.reviver);
      creds.accountSyncCounter = 0;
      creds.processedHistoryMessages = [];
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO wa_creds (key, value) VALUES (?, ?)",
        "creds",
        JSON.stringify(creds, BufferJSON.replacer)
      );
      this.log(
        "info",
        "resetHistorySyncMarkers: accountSyncCounter=0, processedHistoryMessages cleared (force history resync)"
      );
    } catch (err: any) {
      this.log("error", `resetHistorySyncMarkers failed: ${err?.message || err}`);
    }
  }

  private async startSocket(): Promise<void> {
    if (this.socket) return;
    if (this.startPromise) {
      this.log("info", "startSocket: joining in-flight start");
      await this.startPromise;
      return;
    }
    this.startPromise = this.startSocketNow().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
  }

  private async startSocketNow() {
    try {
      this.connectionState = "connecting";
      this.persist();

      this.log("info", "Creating auth state...");
      const authState = createSqliteAuthState(this.state.storage.sql);
      this.log("info", "Auth state ready");

      // FIX: Both fetchLatestBaileysVersion() and fetchLatestWaWebVersion()
      // are unreliable — Baileys' helpers return stale versions that WhatsApp
      // rejects with 405 "client_too_old" (shows as "check your network" on
      // the phone). See https://github.com/WhiskeySockets/Baileys/issues/2679
      //
      // Instead, fetch the version directly from WhatsApp's sw.js ourselves.
      // Timeout is critical: an un-timeouted fetch hung for 50s+ in
      // production ("Network connection lost"), blowing past the UI's 15s
      // preparing timeout → "Connection failed" before makeWASocket even ran.
      let waVersion: [number, number, number] = this.lastWaVersion ?? [2, 3000, 1048000000];

      try {
        const swResp = await fetch("https://web.whatsapp.com/sw.js", {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(5_000),
        });
        const swText = await swResp.text();
        // Match both escaped (\"client_revision\") and unescaped ("client_revision") forms
        const match = swText.match(/\\?"client_revision\\?"\s*:\s*(\d+)/);
        if (match) {
          const revision = parseInt(match[1], 10);
          waVersion = [2, 3000, revision];
          this.lastWaVersion = waVersion;
          this.log(
            "info",
            `Using LIVE WA Web version ${JSON.stringify(waVersion)} (parsed from sw.js client_revision=${revision})`
          );
        } else {
          this.log("warn", `Could not parse client_revision from sw.js — using fallback ${JSON.stringify(waVersion)}`);
        }
      } catch (e: any) {
        this.log("warn", `Failed to fetch sw.js: ${e?.message} — using fallback ${JSON.stringify(waVersion)}`);
      }

      this.log("info", "Calling makeWASocket()...");
      // History import wants requireFullSync (set from syncFullHistory in
      // Baileys' registration node). WhatsApp rejects a *fresh* registration
      // that also claims the Desktop web platform (webSubPlatform DARWIN):
      // it closes the socket with "Connection Terminated" (code 428) before
      // any pair-device IQ / QR is issued — the UI then sits on "Preparing
      // your connection…" and finally "Connection failed". Pairing must use
      // Chrome (WEB_BROWSER). After creds.me exists, login may use Desktop
      // for a richer full-history profile. syncFullHistory still follows the
      // user's history toggle on first registration so requireFullSync is
      // recorded on the companion device when they asked for history.
      const wantHistory = !this.skipHistorySync;
      const hasPaired = !!authState.creds.me;
      const useDesktopProfile = wantHistory && hasPaired;
      this.log(
        "info",
        `socket profile: hasPaired=${hasPaired} wantHistory=${wantHistory} useDesktopProfile=${useDesktopProfile}`
      );
      this.socket = makeWASocket({
        auth: authState,
        version: waVersion,
        printQRInTerminal: false,
        browser: useDesktopProfile ? Browsers.macOS("Desktop") : Browsers.macOS("Chrome"),
        syncFullHistory: wantHistory,
        // Default Baileys filter rejects FULL history; when the user asked
        // to import history, accept every sync type including FULL. Must not
        // pass `undefined` here — makeWASocket spreads config over defaults
        // and would wipe the default filter with undefined.
        ...(wantHistory ? { shouldSyncHistoryMessage: () => true } : {}),
        markOnlineOnConnect: false,
        logger: {
          level: "warn",
          child: () => ({
            level: "warn",
            trace: (...a: any[]) => this.log("info", `[trace] ${a.map(fmtLogArg).join(" ")}`),
            debug: (...a: any[]) => this.log("info", `[debug] ${a.map(fmtLogArg).join(" ")}`),
            info: (...a: any[]) => this.log("info", `[info] ${a.map(fmtLogArg).join(" ")}`),
            warn: (...a: any[]) => this.log("warn", `[warn] ${a.map(fmtLogArg).join(" ")}`),
            error: (...a: any[]) => this.log("error", `[err] ${a.map(fmtLogArg).join(" ")}`),
          }),
          trace: (...a: any[]) => this.log("info", `[trace] ${a.map(fmtLogArg).join(" ")}`),
          debug: (...a: any[]) => this.log("info", `[debug] ${a.map(fmtLogArg).join(" ")}`),
          info: (...a: any[]) => this.log("info", `[info] ${a.map(fmtLogArg).join(" ")}`),
          warn: (...a: any[]) => this.log("warn", `[warn] ${a.map(fmtLogArg).join(" ")}`),
          error: (...a: any[]) => this.log("error", `[error] ${a.map(fmtLogArg).join(" ")}`),
        } as any,
        keepAliveIntervalMs: 30_000,
        qrTimeout: 60_000,
        connectTimeoutMs: 20_000,
        transactionOpts: { maxCommitRetries: 3, delayBetweenTriesMs: 2000 },
        getMessage: async () => undefined,
      });
      this.log("info", "makeWASocket() returned");

      this.setupEventHandlers(authState);
      this.log("info", "Event handlers attached");
    } catch (err: any) {
      this.log("error", `startSocket FAILED: ${err?.stack || err}`);
      this.connectionState = "disconnected";
      this.persist();
    }
  }

  private setupEventHandlers(_authState: AuthenticationState) {
    if (!this.socket) return;

    // Also listen for creds and settings updates
    this.socket.ev.on("creds.update", (creds: any) => {
      this.log("info", `creds.update: me=${JSON.stringify(creds.me)}`);
    });

    this.socket.ev.on("messaging-history.set", (hist: any) => {
      this.log(
        "info",
        `messaging-history.set chats=${hist.chats?.length} msgs=${hist.messages?.length} contacts=${hist.contacts?.length} syncType=${hist.syncType ?? "?"}`
      );
      // Contacts, group metadata and message history are backfilled
      // independently; each bails out on its own (via withWorkspaceId) if
      // workspaceId can't be resolved yet, without blocking the others.
      if (hist.contacts?.length) {
        this.state.waitUntil(
          this.withWorkspaceId((wsId) =>
            syncContactsFromHistory(this.db, wsId, this.sessionIdName, hist.contacts, this.log.bind(this))
          )
        );
      }
      // Chat list → conversation shells. WhatsApp often delivers many
      // chats but only a handful of messages in the first history batch;
      // creating conversations from messages alone left the inbox almost
      // empty after connect. Skipped when the user chose "no chat history":
      // they expect a clean inbox that only fills as live messages arrive,
      // not dozens of empty "No messages yet" shells (direct + groups).
      // Group metadata still lands via groupFetchAllParticipating on open,
      // and the conversation row is created on the first live message.
      if (hist.chats?.length && this.skipHistorySync) {
        this.log("info", `messaging-history.set: skipping ${hist.chats.length} chat shells (syncHistory=false)`);
      } else if (hist.chats?.length) {
        this.state.waitUntil(
          this.withWorkspaceId((wsId) =>
            syncDirectChatsFromHistory(this.db, wsId, this.sessionIdName, hist.chats, this.log.bind(this))
          )
        );
        const groupChats = hist.chats.filter((c: any) => c.id?.endsWith?.("@g.us"));
        if (groupChats.length) {
          this.state.waitUntil(
            this.withWorkspaceId((wsId) =>
              syncGroupsFromHistory(this.db, wsId, this.sessionIdName, groupChats, this.log.bind(this), !this.skipGroupMemberSync)
            )
          );
        }
      }
      // Backfill the actual chat history -- unless the user chose "only
      // new messages from now on" at connect time (see POST /connect's
      // syncHistory option). Previously hist.messages was logged and
      // discarded here, so a freshly connected session never got any
      // message history into D1 -- only messages that arrived live
      // afterward. See session/message-events.ts for why this
      // intentionally skips media download / broadcast / webhooks /
      // search indexing / auto-reply (those are for live messages only).
      if (hist.messages?.length) {
        if (this.skipHistorySync) {
          this.log("info", `messaging-history.set: skipping backfill of ${hist.messages.length} messages (syncHistory=false)`);
        } else {
          this.state.waitUntil(
            this.withWorkspaceId((wsId) =>
              syncMessagesFromHistory(this.db, wsId, this.sessionIdName, hist.messages, this.log.bind(this))
            )
          );
        }
      }
    });

    this.socket.ev.on("chats.upsert", (chats: any) => {
      this.log("info", `chats.upsert: ${JSON.stringify(chats?.map?.((c: any) => c.id) ?? chats)}`);
    });

    // ── Chat-state sync (archive/mute) FROM WhatsApp ─────────────────────
    // The counterpart to POST /chat-modify above: chats.update is what
    // Baileys fires when a chat's archived/muted state changes -- whether
    // that change came from our own chatModify() call, or (the gap this
    // closes) was made on the phone or another linked device, which
    // previously had no path into D1 at all. updateConversationChatState
    // is the same helper /chat-modify already uses, so both directions
    // stay consistent.
    //
    // chats.update payloads are partial -- most fire for unrelated reasons
    // (unreadCount, lastMsgTimestamp, etc.) and carry neither `archived`
    // nor `muteEndTime` at all, so only touch the fields actually present
    // rather than overwriting archived/muted with `undefined` on every
    // unrelated update.
    this.socket.ev.on("chats.update", (updates: any[]) => {
      this.state.waitUntil(
        (async () => {
          const workspaceId = await this.resolveWorkspaceId();
          if (!workspaceId) return;
          for (const upd of updates) {
            const rawJid = upd?.id;
            // Same @broadcast guard as everywhere else -- Stories/broadcast
            // lists aren't a chat we track, and neither are Channels
            // (`@newsletter`). See https://baileys.wiki/features/broadcasts-stories.
            if (!rawJid || rawJid.endsWith("@broadcast") || rawJid.endsWith("@newsletter")) continue;

            const update: { archived?: boolean; muted?: boolean } = {};
            if (upd.archived !== undefined && upd.archived !== null) {
              update.archived = !!upd.archived;
            }
            if (upd.muteEndTime !== undefined && upd.muteEndTime !== null) {
              // proto.IConversation.muteEndTime is a unix-seconds timestamp
              // the mute lasts until, or 0 when unmuted -- the same
              // convention chatModify's own `mute: number | null` writes.
              const muteEndTime = Number(upd.muteEndTime);
              update.muted = muteEndTime > Math.floor(Date.now() / 1000);
            }
            if (Object.keys(update).length === 0) continue;

            try {
              const jid = await resolveToPhoneJid(this.db, this.sessionIdName, rawJid);
              await updateConversationChatState(this.db, workspaceId, this.sessionIdName, jid, update);
              this.log("info", `chats.update: ${jid} -> ${JSON.stringify(update)}`);
              this.broadcast({
                type: "chat-state",
                sessionId: this.sessionIdName,
                workspaceId,
                jid,
                update,
              });
            } catch (err: any) {
              this.log("error", `chats.update sync failed for ${rawJid}: ${err?.message || err}`);
            }
          }
        })()
      );
    });

    // ── Presence updates (typing, online/offline) ────────────────────────
    // Incoming presence (contacts typing / online) is NOT broadcast: no
    // client consumes it (use-presence.ts only *sends* our typing state),
    // and it's one of the chattiest Baileys events -- every update was
    // being serialized and pushed to every open CRM tab for nothing. Add a
    // targeted broadcast back here when a typing indicator UI exists.

    // ── Group metadata sync ──────────────────────────────────────────────
    this.socket.ev.on("groups.upsert", (groupsList: any[]) => {
      this.log("info", `groups.upsert: ${groupsList.length} groups`);
      const wsIdPromise = this.resolveWorkspaceId();
      this.state.waitUntil(
        (async () => {
          const wsId = await wsIdPromise;
          if (!wsId) {
            this.log("warn", "groups.upsert: no workspaceId — skipped");
            return;
          }
          for (const g of groupsList) {
            if (!g.id) continue;
            try {
              const group = await upsertGroupMetadata(this.db, wsId, this.sessionIdName, {
                jid: g.id,
                name: g.subject || g.name || null,
                participantCount: g.participants?.length ?? null,
              });
              if (g.participants?.length && !this.skipGroupMemberSync) {
                await upsertGroupMembers(this.db, wsId, this.sessionIdName, group.id, g.participants);
              }
            } catch (err: any) {
              this.log("error", `groups.upsert failed for ${g.id}: ${err?.message || err}`);
            }
          }
        })()
      );
    });

    // ── Contact sync (WA-AKG pattern) ──────────────────────────────────
    this.socket.ev.on("contacts.upsert", async (contactsList: any[]) => {
      this.log("info", `contacts.upsert: ${contactsList.length} contacts`);
      await this.withWorkspaceId((wsId) =>
        syncContactUpsert(this.db, wsId, this.sessionIdName, contactsList, this.log.bind(this))
      );
    });

    // The moment WhatsApp actually reveals a @lid <-> phone-JID pairing.
    // resolveToPhoneJid/findOrCreateContact already know how to *use* this
    // mapping once it's recorded -- this is what was missing to ever
    // record it, which is why a contact first seen only by @lid (common
    // on newer accounts / history sync) and later addressed by phone JID
    // on a live message could show up as two separate conversations. See
    // syncLidMapping's own comment for the merge behavior.
    this.socket.ev.on("lid-mapping.update", async (mapping: { lid: string; pn: string }) => {
      this.log("info", `lid-mapping.update: ${mapping.lid} <-> ${mapping.pn}`);
      await this.withWorkspaceId((wsId) =>
        syncLidMapping(this.db, wsId, this.sessionIdName, mapping).catch((err: any) => {
          this.log("error", `syncLidMapping failed for ${mapping.lid}<->${mapping.pn}: ${err?.message || err}`);
        })
      );
    });

    // ── Connection lifecycle ────────────────────────────────────────────
    this.socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qr = qr;
        this.connectionState = "qr";
        this.reconnectCount = 0; // reset on new QR (user is re-scanning)
        this.log("info", `QR received (${qr.length} chars). Scan via /qr`);
        this.persist();
        this.state.storage.put("qr", qr);
        this.broadcast({ type: "session-status", sessionId: this.sessionIdName, status: "qr", user: null });
      }

      if (connection === "open") {
        this.connectionState = "connected";
        this.qr = null;
        this.reconnectCount = 0;
        this.sessionUser = this.socket?.user?.id ?? null;
        this.log("info", `CONNECTED as ${this.sessionUser}`);
        this.persist();
        // Keep this number online from now on, browser or not.
        this.state.waitUntil(this.setWantOnline(true));
        this.state.storage.delete("qr");
        // Broadcast status to WS subscribers
        this.broadcast({
          type: "session-status",
          sessionId: this.sessionIdName,
          status: "connected",
          user: this.sessionUser,
        });
        // Fire-and-forget: update D1 so the web session card shows "connected".
        this.state.waitUntil(
          (async () => {
            try {
              const wsId = await this.resolveWorkspaceId();
              if (wsId) {
                await markSessionStatus(this.db, this.sessionIdName, "connected", {
                  connectedJid: this.sessionUser ?? undefined,
                  phoneNumber: this.socket?.user?.id.split(":")[0].split("@")[0],
                });
                this.log("info", "D1 status updated to connected");
              } else {
                this.log("warn", "No workspaceId — D1 status NOT updated");
              }
              // Fetch all participating groups to ensure we have complete group
              // metadata -- throttled (see FULL_GROUP_SYNC_MIN_INTERVAL_MS).
              const lastGroupSync = (await this.state.storage.get<number>("groupsSyncedAt")) ?? 0;
              const groupSyncDue = Date.now() - lastGroupSync > FULL_GROUP_SYNC_MIN_INTERVAL_MS;
              if (!groupSyncDue) this.log("info", "Skipping full group refetch (synced recently)");
              if (this.socket && groupSyncDue) {
                try {
                  const allGroups = await this.socket.groupFetchAllParticipating();
                  const groupCount = Object.keys(allGroups).length;
                  this.log("info", `groupFetchAllParticipating: ${groupCount} groups fetched`);
                  await this.state.storage.put("groupsSyncedAt", Date.now());
                  // Sync groups to D1
                  if (wsId && groupCount > 0) {
                    for (const [jid, metadata] of Object.entries(allGroups)) {
                      try {
                        const group = await upsertGroupMetadata(this.db, wsId, this.sessionIdName, {
                          jid,
                          name: (metadata as any).subject || null,
                          participantCount: (metadata as any).participants?.length ?? null,
                        });
                        if ((metadata as any).participants?.length && !this.skipGroupMemberSync) {
                          await upsertGroupMembers(
                            this.db,
                            wsId,
                            this.sessionIdName,
                            group.id,
                            (metadata as any).participants
                          );
                        }
                      } catch (err: any) {
                        this.log("error", `groupFetchAllParticipating sync failed for ${jid}: ${err?.message || err}`);
                      }
                    }
                  }
                } catch (err: any) {
                  this.log("warn", `groupFetchAllParticipating failed: ${err?.message || err}`);
                }
              }
            } catch (err: any) {
              this.log("error", `Failed to update D1 status: ${err?.message || err}`);
            }
          })()
        );
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const errMsg = (lastDisconnect?.error as any)?.message || String(lastDisconnect?.error);
        this.log(
          "warn",
          `connection.close fired: code=${statusCode} err=${errMsg} socket_was=${!!this.socket} state=${this.connectionState}`
        );

        // User explicitly clicked Disconnect — do NOT auto-reconnect.
        if (this.intentionalDisconnect) {
          this.intentionalDisconnect = false;
          this.log("warn", `Intentional disconnect (code: ${statusCode}). Not reconnecting.`);
          this.state.waitUntil(this.setWantOnline(false));
          this.connectionState = "disconnected";
          this.socket = null;
          this.qr = null;
          this.reconnectCount = 0;
          this.persist();
          this.state.storage.delete("qr");
          this.broadcast({ type: "session-status", sessionId: this.sessionIdName, status: "disconnected", user: null });
          return;
        }

        // Logged out — clear credentials permanently
        if (statusCode === DisconnectReason.loggedOut) {
          this.log("warn", `Logged out (code: ${statusCode}). Clearing credentials.`);
          this.state.waitUntil(this.setWantOnline(false));
          this.connectionState = "disconnected";
          this.socket = null;
          this.qr = null;
          this.reconnectCount = 0;
          this.persist();
          this.state.storage.delete("qr");
          this.broadcast({ type: "session-status", sessionId: this.sessionIdName, status: "disconnected", user: null });
          // Clear auth state from storage
          try {
            this.state.storage.sql.exec("DELETE FROM wa_creds");
            this.state.storage.sql.exec("DELETE FROM wa_keys");
          } catch (e: any) {
            this.log("error", `Failed to clear auth state: ${e?.message || e}`);
          }
          this.state.waitUntil(
            (async () => {
              try {
                const wsId = await this.resolveWorkspaceId();
                if (wsId) await markSessionStatus(this.db, this.sessionIdName, "disconnected");
              } catch {}
            })()
          );
          return;
        }

        // Post-pairing restart: after a successful QR scan, WhatsApp
        // deliberately closes the just-registered socket with 515
        // ("restart required") so Baileys can reconnect using the now-real
        // creds -- this is the *expected* second half of pairing, not a
        // failure. The mobile app is actively waiting on that reconnect to
        // complete the link; funneling this through the generic
        // unexpected-disconnect path below (flat 3s delay, counted against
        // MAX_RECONNECT_ATTEMPTS, connectionState flipped to "disconnected"
        // long enough for the QR dialog's own 4s failure threshold to trip)
        // was racing both the phone's own linking timeout ("check your
        // connection") and our own UI's false "Connection failed". Reconnect
        // immediately, don't burn a retry attempt, and keep the state as
        // "connecting" (not "disconnected") so the dialog keeps showing its
        // loading state instead of flagging a failure.
        if (statusCode === DisconnectReason.restartRequired) {
          this.log("info", "Restart required (post-pairing reconnect) — reconnecting immediately.");
          this.connectionState = "connecting";
          this.socket = null;
          this.persist();
          this.state.waitUntil(this.startSocket());
          return;
        }

        // Unexpected disconnect — retry with limit (like WA-AKG)
        this.reconnectCount++;
        const remaining = MAX_RECONNECT_ATTEMPTS - this.reconnectCount + 1;

        if (remaining > 0) {
          this.connectionState = "disconnected";
          this.socket = null;
          this.persist();
          this.log(
            "warn",
            `DISCONNECTED (code: ${statusCode}, err: ${errMsg}). Reconnecting (${this.reconnectCount}/${MAX_RECONNECT_ATTEMPTS})...`
          );
          this.state.waitUntil(
            (async () => {
              try {
                const wsId = await this.resolveWorkspaceId();
                if (wsId) await markSessionStatus(this.db, this.sessionIdName, "connecting");
              } catch {}
            })()
          );
          this.state.waitUntil(
            new Promise<void>((resolve) => {
              setTimeout(async () => {
                await this.startSocket();
                resolve();
              }, 3000);
            })
          );
        } else {
          // Max retries exceeded — auto-stop (like WA-AKG)
          // Fast retries exhausted: hand over to the watchdog alarm, which
          // keeps retrying with backoff (it used to stop here for good
          // until someone clicked reconnect in the CRM).
          this.log("error", `Max reconnects (${MAX_RECONNECT_ATTEMPTS}) reached. Watchdog will keep retrying with backoff.`);
          this.state.waitUntil(this.scheduleWatchdog(WATCHDOG_BACKOFF_MS[0]));
          this.connectionState = "disconnected";
          this.socket = null;
          this.qr = null;
          this.reconnectCount = 0;
          this.persist();
          this.state.storage.delete("qr");
          this.state.waitUntil(
            (async () => {
              try {
                const wsId = await this.resolveWorkspaceId();
                if (wsId) await markSessionStatus(this.db, this.sessionIdName, "disconnected");
              } catch {}
            })()
          );
        }
      }
    });

    this.socket.ev.on("creds.update", () => {
      this.log("info", "creds.update — persisting creds");
      try {
        const creds = this.socket?.authState.creds;
        if (creds) {
          this.state.storage.sql.exec(
            "INSERT OR REPLACE INTO wa_creds (key, value) VALUES (?, ?)",
            "creds",
            JSON.stringify(creds, BufferJSON.replacer)
          );
        }
      } catch (err: any) {
        this.log("error", `creds.update persist failed: ${err?.message || err}`);
      }
    });

    // ── Reactions ── Baileys has a DEDICATED event for this, separate
    // from messages.update. Per node_modules/@whiskeysockets/baileys's own
    // Events.d.ts: `'messages.reaction': { key: WAMessageKey; reaction:
    // proto.IReaction }[]`. The messages.update handler below also has a
    // defensive read of `update.update?.reactions` in case some path still
    // populates that, but this is the actual event WhatsApp reactions
    // arrive on (confirmed against the installed proto types) -- without
    // this listener, reactions had no code path into D1 at all, regardless
    // of the earlier `continue`-skips-everything bug already fixed below.
    this.socket.ev.on("messages.reaction", (events: any[]) => {
      this.state.waitUntil(
        (async () => {
          const workspaceId = await this.resolveWorkspaceId();
          if (!workspaceId) return;
          for (const evt of events) {
            const keyId = evt.key?.id;
            const reaction = evt.reaction;
            if (!keyId || !reaction) continue;
            const emoji = reaction.text || "";
            const sender =
              reaction.key?.participant ||
              reaction.key?.remoteJid ||
              evt.key?.participant ||
              evt.key?.remoteJid ||
              "unknown";
            const ts = reaction.senderTimestampMs ? Number(reaction.senderTimestampMs) : Date.now();
            this.log("info", `messages.reaction on ${keyId}: emoji="${emoji}" sender=${sender}`);
            let conversationId: string | null = null;
            try {
              conversationId = await upsertMessageReaction(this.db, workspaceId, keyId, {
                emoji,
                sender,
                timestampMs: ts,
              });
              this.log("info", `Reaction synced to D1 for ${keyId}`);
            } catch (err: any) {
              this.log("error", `Reaction sync failed for ${keyId}: ${err?.message || err}`);
            }
            this.broadcast({
              type: "message-reaction",
              sessionId: this.sessionIdName,
              workspaceId,
              messageId: keyId,
              reaction: { emoji, sender, timestampMs: ts },
              conversationId: conversationId ?? undefined,
            });
          }
        })()
      );
    });

    // ── Group receipts ── For groups (and status@broadcast) Baileys never
    // emits messages.update with a status; each participant's receipt comes
    // on message-receipt.update instead (see Socket/messages-recv.js
    // handleReceipt). Without this, our group messages were stuck on a
    // single tick forever. We advance on the first participant receipt
    // (not "all participants" like the phone does) -- no per-participant
    // storage yet.
    this.socket.ev.on("message-receipt.update", (updates: any[]) => {
      this.state.waitUntil(
        (async () => {
          const workspaceId = await this.resolveWorkspaceId();
          if (!workspaceId) return;
          const batch = new Map<MessageStatus, string[]>();
          for (const u of updates) {
            const keyId = u.key?.id;
            if (!keyId || !u.key?.fromMe) continue;
            const r = u.receipt ?? {};
            const mapped: MessageStatus | null =
              r.readTimestamp || r.playedTimestamp ? "read" : r.receiptTimestamp ? "delivered" : null;
            if (mapped) batch.set(mapped, [...(batch.get(mapped) ?? []), keyId]);
          }
          await this.flushStatusBatch(workspaceId, batch);
        })()
      );
    });

    // ── Message status tracking (sent → delivered → read) ───────────────
    this.socket.ev.on("messages.update", (updates: any[]) => {
      this.state.waitUntil(
        (async () => {
          const workspaceId = await this.resolveWorkspaceId();
          const statusBatch = new Map<MessageStatus, string[]>();
          for (const update of updates) {
            const keyId = update.key?.id;
            if (!keyId) continue;
            const status = update.update?.status;
            // A reaction-only or edit-only event has no `status` field at all
            // (only delivery/read-receipt events do) -- this used to be a
            // blanket `if (!keyId || status === undefined) continue`, which
            // skipped straight past the reaction/edit handling below for
            // EVERY reaction and remote edit. Scope the status branch to
            // only run when a status is actually present instead.
            if (status !== undefined) {
              const mapped = messageStatusFromBaileys(Number(status));
              if (mapped) statusBatch.set(mapped, [...(statusBatch.get(mapped) ?? []), keyId]);
            }
            // Handle reactions -- proto.IReaction (WAProto/index.d.ts) has
            // { key, text, groupingKey, senderTimestampMs, unread }; there is
            // no `reactionTimestamp` field (that was a made-up name that
            // always silently fell back to Date.now()).
            const reactions = update.update?.reactions;
            if (reactions) this.log("info", `messages.update for ${keyId}: reactions=${reactions.length}`);
            if (keyId && workspaceId && reactions) {
              for (const r of reactions) {
                const emoji = r.text || "";
                const sender = r.key?.participant || r.key?.remoteJid || "unknown";
                const tsRaw = r.senderTimestampMs;
                const ts = tsRaw ? Number(tsRaw) : Date.now();
                this.log("info", `Reaction on ${keyId}: emoji="${emoji}" sender=${sender}`);
                let conversationId: string | null = null;
                try {
                  conversationId = await upsertMessageReaction(this.db, workspaceId, keyId, {
                    emoji,
                    sender,
                    timestampMs: ts,
                  });
                  this.log("info", `Reaction synced to D1 for ${keyId}`);
                } catch (err: any) {
                  this.log("error", `Reaction sync failed for ${keyId}: ${err?.message || err}`);
                }
                // Broadcast reaction to CRM
                this.broadcast({
                  type: "message-reaction",
                  sessionId: this.sessionIdName,
                  workspaceId,
                  messageId: keyId,
                  reaction: { emoji, sender, timestampMs: ts },
                  conversationId: conversationId ?? undefined,
                });
              }
            }
            // Handle message edits (messageStubType 14 = POLLED_MESSAGE is not edit;
            // actual edits come via messages.update with message content)
            if (keyId && workspaceId && update.update?.message) {
              const editedMsg = update.update.message;
              let newBody: string | undefined;
              if (editedMsg.conversation) newBody = editedMsg.conversation;
              else if (editedMsg.extendedTextMessage?.text) newBody = editedMsg.extendedTextMessage.text;
              if (newBody) {
                const editedConversationId = await markMessageEdited(this.db, workspaceId, keyId, newBody);
                this.broadcast({
                  type: "message-edited",
                  sessionId: this.sessionIdName,
                  workspaceId,
                  messageId: keyId,
                  newBody,
                  conversationId: editedConversationId ?? undefined,
                });
              }
            }
          }
          if (workspaceId) await this.flushStatusBatch(workspaceId, statusBatch);
        })()
      );
    });

    // ── Message deletions (synced from WhatsApp) ────────────────────────
    this.socket.ev.on("messages.delete", (del: any) => {
      this.state.waitUntil(
        (async () => {
          const workspaceId = await this.resolveWorkspaceId();
          if (!workspaceId) return;
          // messages.delete can be a single message or a batch
          const keys = del.keys || (del.key ? [del.key] : []);
          for (const key of keys) {
            const keyId = key?.id;
            if (!keyId) continue;
            this.log("info", `Message deleted: ${keyId}`);
            let conversationId: string | null = null;
            try {
              conversationId = await markMessageDeleted(this.db, workspaceId, keyId);
            } catch (err: any) {
              this.log("error", `Delete sync failed for ${keyId}: ${err?.message || err}`);
            }
            this.broadcast({
              type: "message-deleted",
              sessionId: this.sessionIdName,
              workspaceId,
              messageId: keyId,
              conversationId: conversationId ?? undefined,
            });
          }
        })()
      );
    });

    // ── Call events (voice/video calls) ──────────────────────────────────
    this.socket.ev.on("call", (calls: any[]) => {
      for (const call of calls) {
        this.log("info", `Call ${call.status} from ${call.from} (${call.id})`);
        this.broadcast({
          type: "call",
          sessionId: this.sessionIdName,
          call: {
            id: call.id,
            from: call.from,
            status: call.status,
            isVideo: call.isVideo,
            timestamp: call.timestamp,
          },
        });
      }
    });

    // ── Message processing ──────────────────────────────────────────────
    this.socket.ev.on("messages.upsert", (upsert) => {
      this.log("info", `messages.upsert type=${upsert.type} count=${upsert.messages.length}`);
      // Baileys tags messages 'notify' (live, real-time) or 'append'.
      // 'append' is more than just history backfill -- it's also how
      // messages that queued up while we were offline are delivered on
      // reconnect, and how our own sends from another linked device show
      // up. Both used to be dropped entirely here (`if (upsert.type !==
      // "notify") return`); now they're synced like any other message
      // (see session/message-events.ts for the recency guard that keeps
      // auto-reply from replaying a whole offline backlog as replies).
      const upsertType: "notify" | "append" = upsert.type === "append" ? "append" : "notify";

      this.state.waitUntil(
        this.withWorkspaceId(async (workspaceId) => {
          for (const msg of upsert.messages) {
            await processLiveMessage(
              {
                db: this.db,
                env: this.env,
                socket: this.socket,
                sessionIdName: this.sessionIdName,
                workspaceId,
                log: this.log.bind(this),
                broadcast: this.broadcast.bind(this),
                allowAutoReply: this.allowAutoReply.bind(this),
                waitUntil: (p) => this.state.waitUntil(p),
              },
              msg,
              upsertType
            );
          }
        })
      );
    });
  }
}
