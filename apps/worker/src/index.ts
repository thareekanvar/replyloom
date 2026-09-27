import { createDb, and, eq, sql, applySafeMediaHeaders, isAllowedUploadMime, normalizeMime, waSessions, conversations, messages, broadcastCampaigns, contacts, agentConfigs, agentWebhookTools } from "@workspace/db";
import {
  startCampaign,
  handleBroadcastBatch
  
} from "./broadcast";
import type {BroadcastQueueMessage} from "./broadcast";
import { storeLibraryMedia } from "./media";
import { indexMessagesForSearch, semanticSearch } from "./search";
import { pruneWebhookDeliveries } from "./automation";
import { handleAgentMessage } from "./ai-agent/agent";
import { loadAgentConfig, invalidateConfigCache } from "./ai-agent/config";
import { ingestDocument } from "./ai-agent/rag";
import { listWorkspaceWebhookTools } from "./ai-agent/tools";
import { resolveCaller, assertCallerWorkspace, unauthorized, forbidden, assertSafeOutboundUrl, MAX_MEDIA_UPLOAD_BYTES, MAX_SEND_MEDIA_BYTES  } from "./security";
import {
  SearchBodySchema,
  ReindexBodySchema,
  AgentReplyBodySchema,
  AgentIngestBodySchema,
  AgentConfigBodySchema,
  AgentToolBodySchema,
} from "./validation";
import { scopedLogger } from "./logger";
import { captureError } from "./error-tracking";
import { publicMessage, publicStatus } from "./errors";
import { readJson } from "./json";
import * as Sentry from "@sentry/cloudflare";
import { scrubSentryEvent } from "@workspace/db/sentry-scrub";

export { WhatsAppSession } from "./session/whatsapp-session";
export { Scheduler } from "./scheduler";

/**
 * Reads just the `to` field off a /session/:id/send* request without
 * consuming the original body -- always reads a clone, since the real
 * request still needs to be forwarded to the Durable Object untouched
 * afterward. JSON bodies (send, send-template) and multipart (send-media)
 * both carry `to` as a plain string field.
 */
async function peekOutboundTarget(request: Request): Promise<string | null> {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.clone().formData();
      const to = form.get("to");
      return typeof to === "string" ? to : null;
    }
    const body = readJson<{ to?: string } | null>(await request.clone().json());
    return typeof body?.to === "string" ? body.to : null;
  } catch {
    // Malformed body -- let the real handler downstream produce the
    // actual validation error instead of masking it here.
    return null;
  }
}


const log = scopedLogger("worker");

export interface Env {
  WHATSAPP_SESSION: DurableObjectNamespace;
  SCHEDULER: DurableObjectNamespace;
  DB: D1Database;
  MEDIA: R2Bucket;
  BROADCAST_QUEUE: Queue<BroadcastQueueMessage>;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  AGENT_VECTORIZE: VectorizeIndex;
  REPLY_CACHE: KVNamespace;
  API_RATE_LIMITER: RateLimit;
  AUTH_RATE_LIMITER: RateLimit;
  /**
   * Shared secret that proves a request came from apps/web (which holds the
   * same value as its ENGINE_INTERNAL_SECRET var and presents it on every
   * engine call through the WA_WORKER service binding), used together with
   * the X-Engine-Workspace header. Set in wrangler vars for dev; override
   * with `wrangler secret put ENGINE_INTERNAL_SECRET` in production.
   */
  ENGINE_INTERNAL_SECRET: string;
  /**
   * Shared secret for signing WebSocket auth tokens. Both workers must
   * hold the same value. Set with `wrangler secret put WS_TOKEN_SECRET`
   * on both apps/web and apps/worker.
   */
  WS_TOKEN_SECRET: string;
  /**
   * AI Gateway id for model calls (see ai-agent/gateway.ts). Set in the
   * dashboard or via `wrangler secret put AIG_GATEWAY_ID`; defaults to the
   * auto-provisioned "default" gateway when unset.
   */
  AIG_GATEWAY_ID?: string;
  /**
   * Allowed CORS origin. Defaults to "*" for local dev; set to your
   * production domain (e.g. "https://app.example.com") in wrangler vars
   * or via `wrangler secret put CORS_ORIGIN` for tighter security.
   */
  CORS_ORIGIN?: string;
}

let warnedInsecureCors = false;

function getAllowedOrigin(env: Env): string {
  const origin = env.CORS_ORIGIN || "*";
  // "*" combined with credentialed requests (this app sends cookies on
  // every request) means browsers will simply refuse to expose the
  // response — functionally broken, not just insecure. Warn loudly once
  // per isolate so it shows up in production logs (this is fine and
  // expected in local dev).
  if (origin === "*" && !warnedInsecureCors) {
    warnedInsecureCors = true;
    log.warn(
      { origin },
      "CORS_ORIGIN is unset or \"*\" — set it to your production domain " +
        "(wrangler secret put CORS_ORIGIN) before going live; credentialed " +
        "cross-origin requests will otherwise be rejected by browsers.",
    );
  }
  return origin;
}

function buildCorsHeaders(env: Env, requestOrigin: string | null): Record<string, string> {
  const allowed = getAllowedOrigin(env);
  // CORS_ORIGIN may list several origins, comma-separated (prod domain +
  // workers.dev + http://localhost:3000). Only an exact match is echoed
  // with credentials. "*" + Allow-Credentials is rejected outright by
  // browsers (and would be an open CORS hole if they didn't).
  const list = allowed.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
  const exact = allowed !== "*" && !!requestOrigin && list.includes(requestOrigin);
  const exposeOrigin = allowed === "*" ? "*" : exact ? requestOrigin : null;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Vary": "Origin",
  };
  if (exposeOrigin) headers["Access-Control-Allow-Origin"] = exposeOrigin;
  if (exact) headers["Access-Control-Allow-Credentials"] = "true";
  return headers;
}

function withCors(response: Response, env: Env, requestOrigin: string | null): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(buildCorsHeaders(env, requestOrigin))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Only the config fields present in the request body, so a PUT never nulls the rest. */
function configValuesFromBody(body: any): Partial<typeof agentConfigs.$inferInsert> {
  const v: Partial<typeof agentConfigs.$inferInsert> = {};
  if (body.enabled !== undefined) v.enabled = !!body.enabled;
  if (body.businessName !== undefined) v.businessName = body.businessName ?? null;
  if (body.scopeDescription !== undefined) v.scopeDescription = body.scopeDescription ?? null;
  if (body.systemPrompt !== undefined) v.systemPrompt = body.systemPrompt ?? null;
  if (body.classifierModel !== undefined) v.classifierModel = body.classifierModel ?? null;
  if (body.generatorModel !== undefined) v.generatorModel = body.generatorModel ?? null;
  if (body.embeddingModel !== undefined) v.embeddingModel = body.embeddingModel ?? null;
  if (body.maxContextChunks !== undefined) v.maxContextChunks = Math.min(10, Math.max(1, Number(body.maxContextChunks)));
  if (body.similarityThreshold !== undefined)
    v.similarityThreshold = Math.min(1, Math.max(0, Number(body.similarityThreshold)));
  if (body.cacheTtlSeconds !== undefined) v.cacheTtlSeconds = Math.max(0, Number(body.cacheTtlSeconds));
  if (body.replyInGroups !== undefined) v.replyInGroups = !!body.replyInGroups;
  return v;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // ── Health check (only intentionally public endpoint) ──
  if (url.pathname === "/health") {
    return Response.json({ cloudflare: true, baileys: true });
  }

  // ── GET /session/:id/ws ── browser WebSocket upgrade ──
  // Browsers can't set an Authorization header on a WebSocket handshake,
  // so this can't go through resolveCaller() below -- it used to 401 here
  // and the socket died with 1006 on every attempt (the inbox silently
  // fell back to 10s conversation-list polling, and the open thread never
  // refreshed). Auth for this path is the short-lived HMAC ?token= from
  // /ws-token, verified inside the DO. We deliberately do NOT set
  // X-Session-Workspace here: the DO treats that header as an internal
  // caller and would skip the token check.
  const wsMatch = url.pathname.match(/^\/session\/([A-Za-z0-9_-]+)\/ws$/);
  if (request.method === "GET" && wsMatch && request.headers.get("Upgrade") === "websocket") {
    const doUrl = new URL("/ws" + url.search, url.origin);
    const doRequest = new Request(doUrl, request);
    doRequest.headers.delete("X-Session-Workspace");
    const stub = env.WHATSAPP_SESSION.get(env.WHATSAPP_SESSION.idFromName(wsMatch[1]));
    return stub.fetch(doRequest);
  }

  // ── Authentication ──
  // Every other route requires either the internal engine secret (from
  // apps/web via the service binding) or a per-workspace API key.
  const caller = await resolveCaller(env, request);
  if (!caller) return unauthorized();

  // ── GET /session/:id/ws-token ──
  // Returns a short-lived HMAC-signed token the browser can present when
  // opening a WebSocket to the DO's /ws endpoint. Authenticated callers
  // only (internal secret or API key — same gate as every other route).
  const wsTokenMatch = url.pathname.match(/^\/session\/([A-Za-z0-9_-]+)\/ws-token$/);
  if (request.method === "GET" && wsTokenMatch) {
    if (!env.WS_TOKEN_SECRET) {
      // Fails closed with a clean JSON error instead of letting
      // crypto.subtle.importKey throw on empty key data below (an
      // unhandled exception here surfaces to the client as a bare 500 —
      // see apps/web/.dev.vars.example / DEPLOY.md for how to set this).
      log.error({}, "WS_TOKEN_SECRET is not set — cannot issue a WebSocket token");
      return Response.json({ ok: false, error: "Server misconfigured (WS_TOKEN_SECRET unset)" }, { status: 500 });
    }
    const sessionId = wsTokenMatch[1];
    const db = createDb(env.DB);
    const session = await db
      .select({ workspaceId: waSessions.workspaceId })
      .from(waSessions)
      .where(eq(waSessions.id, sessionId))
      .get();
    if (!session) {
      return Response.json({ ok: false, error: "Session not found" }, { status: 404 });
    }
    const scopeError = assertCallerWorkspace(caller, session.workspaceId);
    if (scopeError) return scopeError;

    const exp = Math.floor(Date.now() / 1000) + 120; // 2 min lifetime
    const payload = JSON.stringify({ sid: sessionId, wid: session.workspaceId, exp });
    const payloadB64 = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.WS_TOKEN_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
    const sigHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return Response.json({ ok: true, token: `${payloadB64}.${sigHex}` });
  }

  // ── Route to Durable Object ──
  // Matches: /session/:id, /session/:id/send, /session/:id/connect, etc.
  const match = url.pathname.match(/^\/session\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (match) {
    const sessionId = match[1];
    const subPath = match[2] || "/";
    // DO-only routes (e.g. /internal/emit) are for in-worker callers, never
    // for the web app or API-key integrations. Checked on the normalized
    // path so "/x/../internal/emit" can't slip past.
    if (new URL(subPath, url.origin).pathname.startsWith("/internal/")) {
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    // The DO resolves its own workspace from D1 and refuses any request whose
    // X-Session-Workspace header doesn't match (defence in depth — this is
    // what actually stops a caller that knows the secret from touching a
    // session outside their workspace).
    const db = createDb(env.DB);
    const session = await db
      .select({ workspaceId: waSessions.workspaceId })
      .from(waSessions)
      .where(eq(waSessions.id, sessionId))
      .get();
    if (!session) {
      return Response.json({ ok: false, error: "Session not found" }, { status: 404 });
    }
    const scopeError = assertCallerWorkspace(caller, session.workspaceId);
    if (scopeError) return scopeError;

    // Broadcast anti-spam, enforced at the API boundary: an external
    // integration (caller.kind === "api") could otherwise route around
    // the whole contact-list/campaign system entirely by just looping
    // POST /session/:id/send calls against arbitrary numbers. Any number
    // that opted out (STOP keyword) or was admin-suppressed is rejected
    // here regardless of which send endpoint or campaign path it comes
    // through -- suppression is workspace-wide and unconditional, not
    // just a campaign-eligibility filter. Internal calls from the CRM's
    // own UI (caller.kind === "internal") are exempt: a person replying
    // to an inbound conversation from the inbox must still work even if
    // that contact previously opted out of *broadcasts*.
    const SEND_SUBPATHS = new Set(["/send", "/send-template", "/send-media"]);
    if (caller.kind === "api" && SEND_SUBPATHS.has(subPath) && request.method === "POST") {
      const to = await peekOutboundTarget(request);
      if (to) {
        const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
        const suppressed = await db
          .select({ doNotBroadcast: contacts.doNotBroadcast })
          .from(contacts)
          .where(and(eq(contacts.waSessionId, sessionId), eq(contacts.jid, jid)))
          .get();
        if (suppressed?.doNotBroadcast) {
          return Response.json(
            { ok: false, error: "This number has opted out / been suppressed and cannot be messaged via the API." },
            { status: 403 },
          );
        }
      }
    }

    // Rewrite URL so the DO sees only the subpath (e.g. "/qr" not "/session/test/qr")
    const newUrl = new URL(subPath + url.search, url.origin);
    // Clone the request to avoid body stream issues
    const newRequest = new Request(newUrl, request.clone());
    newRequest.headers.set("X-Session-Workspace", session.workspaceId);
    // Outbound-guard kind is decided here, never by the caller: API-key
    // integrations get the "api" limits, the CRM UI the "manual" ones.
    newRequest.headers.delete("X-Send-Kind");
    if (caller.kind === "api") newRequest.headers.set("X-Send-Kind", "api");
    const id = env.WHATSAPP_SESSION.idFromName(sessionId);
    const stub = env.WHATSAPP_SESSION.get(id);
    return stub.fetch(newRequest);
  }

  // ── GET /media/:key (key may contain slashes) ──
  // Streams a stored WhatsApp media object straight out of R2. Access is
  // scoped to objects owned by the caller's workspace (keys embed the
  // workspace id as their first segment, see src/media.ts).
  if (request.method === "GET" && url.pathname.startsWith("/media/")) {
    const key = decodeURIComponent(url.pathname.slice("/media/".length));
    if (!key) return new Response("Not found", { status: 404 });
    if (!key.startsWith(`${caller.workspaceId}/`)) return forbidden();
    const object = await env.MEDIA.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    // private: this is auth-scoped content -- browsers may cache it forever
    // (keys are immutable), shared caches/CDNs must not.
    headers.set("Cache-Control", "private, max-age=31536000, immutable");
    headers.set("ETag", object.httpEtag);
    applySafeMediaHeaders(headers);
    return new Response(object.body, { headers });
  }

  // ── DELETE /media/:key -- remove a stored asset (gallery cleanup),
  // same workspace scoping as GET. ──
  if (request.method === "DELETE" && url.pathname.startsWith("/media/")) {
    const key = decodeURIComponent(url.pathname.slice("/media/".length));
    if (!key) return Response.json({ ok: false, error: "Missing key" }, { status: 400 });
    if (!key.startsWith(`${caller.workspaceId}/`)) return forbidden();
    await env.MEDIA.delete(key);
    return Response.json({ ok: true });
  }

  // ── POST /media/upload -- store a standalone asset for the template
  // library (not tied to any one message/session). multipart, same
  // reasoning as /session/:id/send-media. ──
  if (request.method === "POST" && url.pathname === "/media/upload") {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json({ ok: false, error: "Expected multipart/form-data" }, { status: 400 });
    }
    const workspaceId = form.get("workspaceId");
    const file = form.get("file");
    if (typeof workspaceId !== "string" || !workspaceId) {
      return Response.json({ ok: false, error: "Missing 'workspaceId'" }, { status: 400 });
    }
    const scopeError = assertCallerWorkspace(caller, workspaceId);
    if (scopeError) return scopeError;
    if (!(file instanceof File)) {
      return Response.json({ ok: false, error: "Missing 'file'" }, { status: 400 });
    }
    if (file.size > MAX_MEDIA_UPLOAD_BYTES) {
      return Response.json(
        { ok: false, error: `File too large — max ${Math.round(MAX_MEDIA_UPLOAD_BYTES / (1024 * 1024))}MB` },
        { status: 413 },
      );
    }
    const mime = normalizeMime(file.type);
    if (!isAllowedUploadMime(mime)) {
      return Response.json(
        { ok: false, error: "Unsupported file type. Use an image, video, audio, PDF or Office document." },
        { status: 415 },
      );
    }
    try {
      const buffer = await file.arrayBuffer();
      const stored = await storeLibraryMedia(env, workspaceId, buffer, mime);
      return Response.json({ ok: true, ...stored });
    } catch (err: any) {
      captureError(err, { module: "media-upload" });
      return Response.json(
        { ok: false, error: publicMessage(err, 'Upload failed. Please try again.') },
        { status: publicStatus(err, 500) }
      );
    }
  }

  // ── POST /broadcast/:campaignId/start ──
  // Called by apps/web right after it inserts a campaign + recipient rows,
  // for a "send now" campaign (a scheduled one is picked up by the cron
  // trigger below instead). Enqueues one staggered Queue message per
  // recipient -- see src/broadcast.ts. The caller must own the campaign.
  const broadcastMatch = url.pathname.match(/^\/broadcast\/([A-Za-z0-9_-]+)\/start$/);
  if (request.method === "POST" && broadcastMatch) {
    const db = createDb(env.DB);
    try {
      const campaign = await db
        .select({ workspaceId: broadcastCampaigns.workspaceId })
        .from(broadcastCampaigns)
        .where(eq(broadcastCampaigns.id, broadcastMatch[1]))
        .get();
      if (!campaign) {
        return Response.json({ ok: false, error: "Campaign not found" }, { status: 404 });
      }
      const scopeError = assertCallerWorkspace(caller, campaign.workspaceId);
      if (scopeError) return scopeError;
      await startCampaign(db, env, broadcastMatch[1]);
      return Response.json({ ok: true });
    } catch (err: any) {
      captureError(err, { module: "broadcast-start" });
      return Response.json(
        { ok: false, error: publicMessage(err, "Couldn't start this broadcast. Please try again.") },
        { status: publicStatus(err, 400) }
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/search") {
    try {
      const parsed = SearchBodySchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
      }
      const { workspaceId, query, topK } = parsed.data;
      const scopeError = assertCallerWorkspace(caller, workspaceId);
      if (scopeError) return scopeError;
      const matches = await semanticSearch(env, workspaceId, query, topK);
      return Response.json({ ok: true, matches });
    } catch (err: any) {
      captureError(err, { module: "search" });
      return Response.json(
        { ok: false, error: publicMessage(err, 'Search is unavailable right now. Please try again.') },
        { status: publicStatus(err, 500) }
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/search/reindex") {
    try {
      const parsed = ReindexBodySchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
      }
      const { workspaceId, limit, offset, cursor } = parsed.data;
      const scopeError = assertCallerWorkspace(caller, workspaceId);
      if (scopeError) return scopeError;
      const db = createDb(env.DB);
      // Keyset on messages_workspace_wa_message_idx (workspace_id,
      // wa_message_id) when a cursor is given; offset kept for old callers.
      const base = db
        .select({
          waMessageId: messages.waMessageId,
          waSessionId: waSessions.id,
          conversationId: messages.conversationId,
          body: messages.body,
        })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .innerJoin(waSessions, eq(conversations.waSessionId, waSessions.id))
        .where(
          and(
            eq(messages.workspaceId, workspaceId),
            sql`${messages.body} is not null`,
            cursor ? sql`${messages.waMessageId} > ${cursor}` : undefined,
          ),
        )
        .orderBy(messages.waMessageId)
        .limit(limit);
      const rows = await (cursor ? base : base.offset(offset)).all();

      // Embed in batches of 50: one AI call + one Vectorize upsert each.
      let indexed = 0;
      const items = rows
        .filter((r) => r.body && r.waMessageId)
        .map((r) => ({ messageId: r.waMessageId!, waSessionId: r.waSessionId, conversationId: r.conversationId, text: r.body! }));
      for (let i = 0; i < items.length; i += 50) {
        const res = await indexMessagesForSearch(env, workspaceId, items.slice(i, i + 50));
        indexed += res.indexed;
      }
      const last = rows.at(-1)?.waMessageId ?? null;
      return Response.json({
        ok: true,
        scanned: rows.length,
        indexed,
        limit,
        offset,
        nextOffset: offset + rows.length,
        nextCursor: rows.length === limit ? last : null,
      });
    } catch (err: any) {
      captureError(err, { module: "search-reindex" });
      return Response.json(
        { ok: false, error: publicMessage(err, 'Reindexing failed. Please try again.') },
        { status: publicStatus(err, 500) }
      );
    }
  }

  // ── AI agent integration surface ──
  // Lets an external integration (holding a per-workspace API key) drive the
  // same agent that answers WhatsApp messages, or the web app itself through
  // the internal secret.

  if (request.method === "POST" && url.pathname === "/agent/reply") {
    try {
      const parsed = AgentReplyBodySchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
      }
      const { workspaceId, message, conversationId, waSessionId, remoteJid, phone, isGroup } = parsed.data;
      const scopeError = assertCallerWorkspace(caller, workspaceId);
      if (scopeError) return scopeError;
      const config = await loadAgentConfig(env, workspaceId);
      if (!config.enabled) {
        return Response.json({ ok: false, error: "agent_disabled" }, { status: 409 });
      }
      const reply = await handleAgentMessage(env, config, { message, conversationId, waSessionId, remoteJid, customerPhone: phone, isGroup });
      return Response.json({ ok: true, ...reply });
    } catch (err: any) {
      captureError(err, { module: "agent-reply" });
      return Response.json(
        { ok: false, error: publicMessage(err, "The agent couldn't reply right now. Please try again.") },
        { status: publicStatus(err, 500) }
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/agent/ingest") {
    try {
      const parsed = AgentIngestBodySchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
      }
      const { workspaceId, source, text, docId, chunkSize } = parsed.data;
      const scopeError = assertCallerWorkspace(caller, workspaceId);
      if (scopeError) return scopeError;
      const config = await loadAgentConfig(env, workspaceId);
      const result = await ingestDocument(env, config, { source, text, docId, chunkSize });
      return Response.json({ ok: true, ...result });
    } catch (err: any) {
      captureError(err, { module: "agent-ingest" });
      return Response.json(
        { ok: false, error: publicMessage(err, "Couldn't ingest that document. Please try again.") },
        { status: publicStatus(err, 500) }
      );
    }
  }

  if (url.pathname === "/agent/config") {
    if (request.method === "GET") {
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId) return Response.json({ ok: false, error: "Missing 'workspaceId'" }, { status: 400 });
      const scopeError = assertCallerWorkspace(caller, workspaceId);
      if (scopeError) return scopeError;
      const config = await loadAgentConfig(env, workspaceId);
      return Response.json({ ok: true, config });
    }
    if (request.method === "PUT" || request.method === "POST") {
      try {
        const parsed = AgentConfigBodySchema.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
        }
        const { workspaceId, ...fields } = parsed.data;
        const scopeError = assertCallerWorkspace(caller, workspaceId);
        if (scopeError) return scopeError;
        const values = configValuesFromBody(fields);
        if (Object.keys(values).length === 0) {
          return Response.json({ ok: false, error: "No config fields provided" }, { status: 400 });
        }
        const db = createDb(env.DB);
        await db
          .insert(agentConfigs)
          .values({ workspaceId, ...values })
          .onConflictDoUpdate({ target: agentConfigs.workspaceId, set: { ...values, updatedAt: new Date() } });
        await invalidateConfigCache(env, workspaceId);
        return Response.json({ ok: true });
      } catch (err: any) {
        captureError(err, { module: "agent-config" });
        return Response.json(
          { ok: false, error: publicMessage(err, "Couldn't save the agent config. Please try again.") },
          { status: publicStatus(err, 500) }
        );
      }
    }
  }

  if (url.pathname === "/agent/tools" || url.pathname.startsWith("/agent/tools/")) {
    if (request.method === "GET" && url.pathname === "/agent/tools") {
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId) return Response.json({ ok: false, error: "Missing 'workspaceId'" }, { status: 400 });
      const scopeError = assertCallerWorkspace(caller, workspaceId);
      if (scopeError) return scopeError;
      const tools = await listWorkspaceWebhookTools(env, workspaceId);
      return Response.json({
        ok: true,
        tools: tools.map(({ authToken, ...t }) => ({ ...t, hasAuth: !!authToken })),
      });
    }
    if (request.method === "POST" && url.pathname === "/agent/tools") {
      try {
        const parsed = AgentToolBodySchema.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
        }
        const { workspaceId, name, description, url: toolUrl, parameters, method, authToken, enabled } = parsed.data;
        const scopeError = assertCallerWorkspace(caller, workspaceId);
        if (scopeError) return scopeError;
        const urlCheck = assertSafeOutboundUrl(toolUrl);
        if (!urlCheck.ok) {
          return Response.json({ ok: false, error: urlCheck.error }, { status: 400 });
        }
        const db = createDb(env.DB);
        const params = typeof parameters === "string" ? parameters : JSON.stringify(parameters ?? {});
        const row = await db
          .insert(agentWebhookTools)
          .values({
            workspaceId, name, description, parametersJson: params,
            url: urlCheck.url.toString(), method, authToken: authToken ?? null,
            enabled: enabled === undefined ? true : enabled,
          })
          .returning()
          .get();
        return Response.json({ ok: true, tool: { id: row.id, name: row.name, enabled: row.enabled } });
      } catch (err: any) {
        captureError(err, { module: "agent-tools" });
        return Response.json(
          { ok: false, error: publicMessage(err, "Couldn't save this tool. Please try again.") },
          { status: publicStatus(err, 500) }
        );
      }
    }
    const delMatch = url.pathname.match(/^\/agent\/tools\/([A-Za-z0-9_-]+)$/);
    if (request.method === "DELETE" && delMatch) {
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId) return Response.json({ ok: false, error: "Missing 'workspaceId'" }, { status: 400 });
      const scopeError = assertCallerWorkspace(caller, workspaceId);
      if (scopeError) return scopeError;
      const db = createDb(env.DB);
      await db
        .delete(agentWebhookTools)
        .where(and(eq(agentWebhookTools.id, delMatch[1]), eq(agentWebhookTools.workspaceId, workspaceId)));
      return Response.json({ ok: true });
    }
  }

  // ── POST /schedule/arm ──
  // Pokes the global Scheduler DO so it re-arms its alarm to the soonest
  // pending item. Called by apps/web whenever it schedules or cancels a
  // message/campaign, and by the */5 cron as a recovery sweep. The Scheduler
  // is the single dispatcher -- see src/scheduler.ts. Internal-only: arming
  // is a control action, not something an integration with a scoped API key
  // should be able to trigger.
  if (request.method === "POST" && url.pathname === "/schedule/arm") {
    if (caller.kind !== "internal") return forbidden();
    return pokeScheduler(env);
  }

  // ── Root usage guide ──
  if (url.pathname === "/") {
    return Response.json({
      usage: {
        note: "All endpoints except /health require the internal engine secret (web app) or a per-workspace API key (Authorization: Bearer wa_...).",
        health: "GET /health",
        session_status: "GET /session/:id",
        connect: "POST /session/:id/connect",
        disconnect: "POST /session/:id/disconnect",
        send_message: "POST /session/:id/send  { to, text }",
        send_template: "POST /session/:id/send-template  { to, text?, mediaKey? }",
        send_media: "POST /session/:id/send-media  multipart: to, media (file)",
        upload_media: "POST /media/upload  multipart: workspaceId, file",
        broadcast: "POST /broadcast/:campaignId/start",
        search: "POST /search  { workspaceId, query, topK? }",
        search_reindex: "POST /search/reindex  { workspaceId, limit? }",
        agent_reply: "POST /agent/reply  { workspaceId, message, remoteJid?, phone?, conversationId? }",
        agent_ingest: "POST /agent/ingest  { workspaceId, source, text, docId? }",
        agent_config: "GET|PUT /agent/config  ?workspaceId= | { workspaceId, enabled, scopeDescription, ... }",
        agent_tools: "GET|POST /agent/tools  ?workspaceId= | { workspaceId, name, description, url, parameters }",
      },
    });
  }

  return new Response("Not found. See the usage guide at /", { status: 404 });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // ── CORS preflight ──
    const requestOrigin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: buildCorsHeaders(env, requestOrigin) });
    }

    // ── Rate limiting ──
    // Use client IP as rate limit key
    const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
    const url = new URL(request.url);

    // Apply stricter rate limit to auth endpoints
    const isAuthEndpoint = url.pathname.startsWith("/auth") ||
      url.pathname.includes("/login") ||
      url.pathname.includes("/signup");

    const rateLimiter = isAuthEndpoint ? env.AUTH_RATE_LIMITER : env.API_RATE_LIMITER;
    const { success } = await rateLimiter.limit({ key: clientIp });

    if (!success) {
      return new Response(
        JSON.stringify({ ok: false, error: "Rate limit exceeded. Please try again later." }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "60",
            ...buildCorsHeaders(env, requestOrigin),
          },
        }
      );
    }

    try {
      const response = await route(request, env);
      // A 101 upgrade must be returned as-is: rebuilding it in withCors()
      // drops the `webSocket` and new Response() rejects status 101.
      if (response.status === 101 || (response as any).webSocket) return response;
      return withCors(response, env, requestOrigin);
    } catch (err: any) {
      // Last line of defence: an uncaught throw anywhere in route() would
      // otherwise surface to the caller as a bare, CORS-less 500 with no
      // body (this is exactly how a missing WS_TOKEN_SECRET showed up —
      // see the ws-token handler above). Always return JSON with CORS
      // headers so callers can at least parse the failure. captureError
      // logs to pino AND reports to Sentry (the throw is caught here, so
      // the withSentry() wrapper below never sees it).
      captureError(err, { module: "route" });
      return withCors(
        Response.json({ ok: false, error: "Internal error" }, { status: 500 }),
        env,
        requestOrigin
      );
    }
  },

  // ── Queue consumer: one batch of staggered broadcast sends ──
  async queue(batch: MessageBatch<BroadcastQueueMessage>, env: Env): Promise<void> {
    try {
      const db = createDb(env.DB);
      await handleBroadcastBatch(batch, env, db);
    } catch (err) {
      // Rethrow after reporting so the queue's retry policy (max_retries: 2)
      // still applies — Sentry gets the failure either way.
      captureError(err, { module: "broadcast-queue" });
      throw err;
    }
  },

  // ── Cron trigger: recovery sweep for the Scheduler DO (see scheduler.ts).
  // Individual sends / campaign kick-offs / webhook retries all run inside
  // the Scheduler's alarm handler -- the cron never dispatches directly, so
  // there's a single writer over the pending->sent transitions and no
  // double-fire race with the agent alarm itself.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      pokeScheduler(env).catch((err) => captureError(err, { module: "scheduled" }))
    );
    // Keep WhatsApp numbers online with no browser open: arm/run each
    // connected session's watchdog (see WhatsAppSession.runWatchdog).
    ctx.waitUntil(
      pokeSessionWatchdogs(env).catch((err) => captureError(err, { module: "session-watchdog" }))
    );
    // Retention: delivered/dead webhook deliveries (one row with the full
    // payload per message per webhook) older than 7 days. Bounded batches;
    // an index seek on (status, created_at) when there's nothing to do.
    ctx.waitUntil(
      pruneWebhookDeliveries(createDb(env.DB)).catch((err) => captureError(err, { module: "webhook-prune" }))
    );
  },
};

// Wrap the whole Worker (fetch + queue + scheduled) with Sentry: unhandled
// errors, request tracing, and automatic instrumentation of D1/KV/R2
// bindings. Disabled unless SENTRY_DSN is set (same as apps/web).
export default Sentry.withSentry<Env, BroadcastQueueMessage>(
  (env) => ({
    // Opt-in: `wrangler secret put SENTRY_DSN`. Unset -> Sentry stays disabled.
    dsn: (env as Env & { SENTRY_DSN?: string }).SENTRY_DSN,
    // 100% tracing adds a span + upload to every request/queue message;
    // 10% keeps performance visibility at a fraction of the overhead.
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    // Message bodies / phone numbers / API keys never leave via error reports.
    beforeSend: scrubSentryEvent,
  }),
  worker,
);

/** Re-arms the global Scheduler DO. */
const WATCHDOG_SWEEP_BATCH = 200;
const WATCHDOG_CURSOR_KEY = "watchdog:session-cursor";

/**
 * Cron safety net for the per-session watchdog alarm. Each run pokes the
 * next WATCHDOG_SWEEP_BATCH sessions that D1 says should be online (keyset
 * over wa_sessions.id, cursor in KV), so every number is re-checked
 * periodically even if its alarm was never armed (sessions connected before
 * the watchdog shipped) -- bounded subrequests per run however many
 * sessions exist.
 */
async function pokeSessionWatchdogs(env: Env) {
  const db = createDb(env.DB);
  const cursor = (await env.REPLY_CACHE.get(WATCHDOG_CURSOR_KEY).catch(() => null)) ?? "";
  const rows = await db
    .select({ id: waSessions.id })
    .from(waSessions)
    .where(
      and(
        sql`${waSessions.status} IN ('connected', 'connecting', 'authenticated')`,
        sql`${waSessions.id} > ${cursor}`,
      ),
    )
    .orderBy(waSessions.id)
    .limit(WATCHDOG_SWEEP_BATCH)
    .all();
  const next = rows.length === WATCHDOG_SWEEP_BATCH ? rows[rows.length - 1].id : "";
  await env.REPLY_CACHE.put(WATCHDOG_CURSOR_KEY, next).catch(() => {});
  await Promise.allSettled(
    rows.map((r) =>
      env.WHATSAPP_SESSION.get(env.WHATSAPP_SESSION.idFromName(r.id)).fetch("http://do/internal/watchdog", {
        method: "POST",
      }),
    ),
  );
}

function pokeScheduler(env: Env) {
  const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("global"));
  return stub.fetch("https://scheduler.internal/arm", { method: "POST" });
}
