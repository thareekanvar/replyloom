// Two independent event-reaction systems, both driven off the same
// `messages.upsert` hook in whatsapp-session.ts:
//   - Auto-reply: keyword-matched, whitelist/blacklist-aware canned
//     replies, sent synchronously (the whole point is a fast reply).
//   - Outbound webhooks: fire-and-forget HTTP callbacks, HMAC-signed,
//     with best-effort retries driven by the Scheduler alarm (see
//     scheduler.ts), not a fixed cron.
import { assertSafeOutboundUrl } from "./security";
import {
  
  eq,
  and,
  or,
  isNull,
  desc,
  autoReplyRules,
  accessRules,
  webhooks,
  webhookDeliveries,
  matchRulePattern,
  lt,
  inArray,
  sql
} from "@workspace/db";
import type {Db} from "@workspace/db";
import type { Env } from "./index";
import { scopedLogger } from "./logger";
import { TtlCache } from "./ttl-cache";

// Rules/webhooks change rarely but were re-read from D1 for every message.
const RULES_TTL_MS = 30_000;
const accessRulesCache = new TtlCache<(typeof accessRules.$inferSelect)[]>(RULES_TTL_MS);
const autoReplyRulesCache = new TtlCache<(typeof autoReplyRules.$inferSelect)[]>(RULES_TTL_MS);
const webhooksCache = new TtlCache<(typeof webhooks.$inferSelect)[]>(RULES_TTL_MS);
const WEBHOOK_TIMEOUT_MS = 10_000;

const log = scopedLogger("automation");

// ── Auto-reply ──────────────────────────────────────────────────────────

function keywordMatches(rule: { matchType: string; keyword: string }, body: string): boolean {
  const text = body;
  if (rule.matchType === "exact") return text.trim().toLowerCase() === rule.keyword.trim().toLowerCase();
  if (rule.matchType === "regex") {
    // Compiled once + validated against ReDoS shapes + input capped (see
    // packages/db lib/safe-regex.ts). An unsafe/invalid pattern never matches.
    return matchRulePattern(rule.keyword, text);
  }
  return text.toLowerCase().includes(rule.keyword.toLowerCase()); // "contains" (default)
}

export async function isBlocked(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  scope: "auto_reply" | "bot_commands",
  jid: string,
) {
  // workspace_id is mandatory: a workspace-wide rule (wa_session_id IS NULL)
  // must never leak into another tenant's sessions.
  const rows = await accessRulesCache.get(`${workspaceId}|${waSessionId}|${scope}`, () =>
    db
      .select()
      .from(accessRules)
      .where(
        and(
          eq(accessRules.workspaceId, workspaceId),
          eq(accessRules.scope, scope),
          or(eq(accessRules.waSessionId, waSessionId), isNull(accessRules.waSessionId)),
        ),
      )
      .all(),
  );

  if (rows.some((r) => r.listType === "blacklist" && r.jid === jid)) return true;
  const whitelist = rows.filter((r) => r.listType === "whitelist");
  if (whitelist.length > 0 && !whitelist.some((r) => r.jid === jid)) return true; // whitelist exists and jid isn't on it
  return false;
}

/** Returns the reply text for the first matching enabled rule, or null. */
export async function findAutoReply(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  ctx: { isGroup: boolean; body?: string; senderJid: string },
): Promise<string | null> {
  if (!ctx.body) return null;

  const rules = await autoReplyRulesCache.get(`${workspaceId}|${waSessionId}`, () =>
    db
      .select()
      .from(autoReplyRules)
      .where(
        and(
          eq(autoReplyRules.workspaceId, workspaceId),
          eq(autoReplyRules.enabled, true),
          or(eq(autoReplyRules.waSessionId, waSessionId), isNull(autoReplyRules.waSessionId)),
        ),
      )
      .orderBy(desc(autoReplyRules.priority))
      .all(),
  );

  const context = ctx.isGroup ? "group" : "private";
  for (const rule of rules) {
    if (rule.context !== "all" && rule.context !== context) continue;
    if (!keywordMatches(rule, ctx.body)) continue;
    if (!rule.replyText) continue;
    if (await isBlocked(db, workspaceId, waSessionId, "auto_reply", ctx.senderJid)) return null;
    return rule.replyText;
  }
  return null;
}

// ── Outbound webhooks ───────────────────────────────────────────────────

async function signPayload(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function deliver(db: Db, hook: { id: string; url: string; secret: string }, deliveryId: string, body: string) {
  try {
    // Re-checked at delivery time too (rows created before validation
    // existed, or edited directly in the DB).
    const safe = assertSafeOutboundUrl(hook.url);
    if (!safe.ok) {
      await db.update(webhookDeliveries).set({ status: "dead" }).where(eq(webhookDeliveries.id, deliveryId));
      return;
    }
    const signature = await signPayload(hook.secret, body);
    // Bounded: a slow/hung endpoint must not hold up message processing.
    // redirect: "manual" -- a public URL 30x-ing to an internal host must
    // not be followed (a redirect counts as a failed delivery).
    const res = await fetch(safe.url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Signature": `sha256=${signature}` },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    await db
      .update(webhookDeliveries)
      .set({ status: res.ok ? "success" : failedStatus() })
      .where(eq(webhookDeliveries.id, deliveryId));
  } catch {
    await db.update(webhookDeliveries).set({ status: failedStatus() }).where(eq(webhookDeliveries.id, deliveryId));
  }
}

// A failure on the last allowed attempt is terminal ("dead"), so the retry
// sweep and the Scheduler's "anything to retry?" probe never see it again.
function failedStatus() {
  return sql<"failed" | "dead">`CASE WHEN ${webhookDeliveries.attempts} >= ${MAX_WEBHOOK_ATTEMPTS} THEN 'dead' ELSE 'failed' END`;
}

/** Drops delivered / dead webhook deliveries older than `days` (each stores
 * the full message payload -- one row per message per webhook), in bounded
 * batches so a big backlog never becomes one huge write. */
export async function pruneWebhookDeliveries(db: Db, days = 7, maxBatches = 20) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const ids = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(and(inArray(webhookDeliveries.status, ["success", "dead"]), lt(webhookDeliveries.createdAt, cutoff)))
      .limit(500)
      .all();
    if (ids.length === 0) break;
    await db.run(sql`DELETE FROM webhook_deliveries WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids.map((r) => r.id))}))`);
    deleted += ids.length;
    if (ids.length < 500) break;
  }
  return deleted;
}

/** Fires every enabled webhook subscribed to `event` for this workspace. */
export async function dispatchWebhookEvent(
  db: Db,
  workspaceId: string,
  event: string,
  payload: Record<string, unknown>,
) {
  const hooks = await webhooksCache.get(workspaceId, () =>
    db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.workspaceId, workspaceId), eq(webhooks.enabled, true)))
      .all(),
  );
  if (hooks.length === 0) return;

  for (const hook of hooks) {
    const subscribed = hook.events.includes(event) || hook.events.includes("*");
    if (!subscribed) continue;

    const delivery = await db
      .insert(webhookDeliveries)
      .values({ webhookId: hook.id, event, payload, status: "pending", attempts: 1 })
      .returning()
      .get();

    const body = JSON.stringify({ event, payload, deliveryId: delivery.id, timestamp: Date.now() });
    await deliver(db, hook, delivery.id, body);
  }
}

// Retry cadence for deliveries that failed on their first attempt
// (a down endpoint, a timeout) -- capped at 5 tries so a permanently dead
// endpoint doesn't retry forever. Scheduler.earliestDueMs uses this cap to
// decide whether a failed delivery still deserves an alarm tick.
export const MAX_WEBHOOK_ATTEMPTS = 5;

export async function retryFailedWebhookDeliveries(db: Db, _env: Env) {
  const failed = await db
    .select({
      id: webhookDeliveries.id,
      webhookId: webhookDeliveries.webhookId,
      event: webhookDeliveries.event,
      payload: webhookDeliveries.payload,
      attempts: webhookDeliveries.attempts,
    })
    .from(webhookDeliveries)
    // Only retryable rows: exhausted ones are moved to "dead" below. This
    // used to select any 25 "failed" rows and skip exhausted ones in code --
    // once 25 exhausted rows existed, nothing was ever retried again while
    // the Scheduler kept waking every minute.
    .where(and(eq(webhookDeliveries.status, "failed"), lt(webhookDeliveries.attempts, MAX_WEBHOOK_ATTEMPTS)))
    .orderBy(webhookDeliveries.createdAt)
    .limit(25)
    .all();

  for (const row of failed) {
    const hook = await db.select().from(webhooks).where(eq(webhooks.id, row.webhookId)).get();
    if (!hook || !hook.enabled) {
      await db.update(webhookDeliveries).set({ status: "dead" }).where(eq(webhookDeliveries.id, row.id));
      continue;
    }

    await db.update(webhookDeliveries).set({ attempts: row.attempts + 1 }).where(eq(webhookDeliveries.id, row.id));
    const body = JSON.stringify({ event: row.event, payload: row.payload, deliveryId: row.id, timestamp: Date.now() });
    await deliver(db, hook, row.id, body);
  }
}
