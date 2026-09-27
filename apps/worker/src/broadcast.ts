// Safe-broadcast dispatch + scheduled-message delivery.
//
// Two Cloudflare-native primitives do the heavy lifting instead of any
// in-process timers (which wouldn't survive a DO/Worker eviction):
//   - Cloudflare Queues, one message per recipient, each given a staggered
//     `delaySeconds` so recipients aren't messaged back-to-back (anti-ban).
//   - A one-shot alarm on the Scheduler Durable Object (see scheduler.ts)
//     that fires the moment something becomes due: individually scheduled
//     messages, and campaigns whose `scheduledAt` has arrived (which then
//     get enqueued the same way). The */5 cron trigger only re-arms the
//     Scheduler as a recovery sweep; these dispatch functions are invoked
//     from the Scheduler's alarm handler.
//
// Anti-ban design: WhatsApp bans numbers that behave like a spam bot —
// identical timing, no failures ever slowing it down, blasting through a
// list at full speed. On top of the per-recipient stagger, this file adds:
//   1. A per-session daily send cap (self-imposed rate limit).
//   2. A circuit breaker: too many consecutive failures on one session
//      (WhatsApp starting to reject sends is an early tell) pauses that
//      session's queue for a cooldown window instead of hammering through.
//   3. Our own exponential-backoff retry (rather than relying on Cloudflare
//      Queues' fixed retry policy) so a retry lands 1m/5m/15m later, not
//      milliseconds later — bursty retries are exactly the pattern that
//      gets a number flagged.
import {
  
  eq,
  and,
  asc,
  gt,
  inArray,
  lte,
  sql,
  broadcastCampaigns,
  broadcastRecipients,
  scheduledMessages,
  contacts,
  groups,
  waSessions,
  resolveTemplate,
  contactTemplateVariables,
  effectiveDailyBroadcastLimit
} from "@workspace/db";
import type {Db} from "@workspace/db";
import type { Env } from "./index";
import { scopedLogger } from "./logger";
import { PublicError } from "./errors";
import { readJson } from "./json";

const log = scopedLogger("broadcast");

export interface BroadcastQueueMessage {
  campaignId: string;
  recipientId: string;
  waSessionId: string;
  toJid: string;
  // Already variable-resolved against this specific recipient (see
  // startCampaign) -- the queue carries the final text, not the template.
  text: string;
  // Points at an R2 object uploaded once for the campaign (from a
  // template's attachment) -- every recipient's send reuses the same key.
  mediaKey?: string;
  // Carried in the message so the consumer doesn't re-read it per send.
  // Optional: messages enqueued before this field existed still work.
  contactId?: string | null;
}

/** Random anti-ban gap between two sends in a campaign, in seconds. */
function randomGapSeconds(minSeconds = 15, maxSeconds = 45) {
  const base = minSeconds + Math.floor(Math.random() * (maxSeconds - minSeconds + 1));
  // Occasionally take a much longer "human" pause instead of a perfectly
  // metronomic gap every single time — real people don't send at a
  // constant cadence all day.
  const longPause = Math.random() < 1 / 15;
  return longPause ? base + 90 + Math.floor(Math.random() * 120) : base;
}

// Cloudflare Queues cap a single message's delaySeconds at 12h. A campaign
// whose stagger would run past that is still fully enqueued -- messages
// just queue up at the cap and fire together at the tail -- rather than
// silently dropping recipients. Good enough for MVP scale; very large
// lists should be chunked across multiple campaigns.
const MAX_DELAY_SECONDS = 12 * 60 * 60 - 60;
// Cloudflare Queues: max 100 messages (and 256 KB) per sendBatch.
const QUEUE_BATCH_SIZE = 100;

// --- Anti-ban throttling knobs -------------------------------------------
const FAILURE_CIRCUIT_THRESHOLD = 5; // consecutive failures before pausing
const CIRCUIT_PAUSE_SECONDS = 30 * 60; // cooldown once the breaker trips
const MAX_SEND_ATTEMPTS = 3;
const RETRY_BACKOFF_SECONDS = [60, 5 * 60, 15 * 60];

async function sendViaSession(
  env: Env,
  waSessionId: string,
  toJid: string,
  text: string,
  mediaKey?: string,
  kind: "broadcast" | "scheduled" = "broadcast",
) {
  const id = env.WHATSAPP_SESSION.idFromName(waSessionId);
  const stub = env.WHATSAPP_SESSION.get(id);
  // /send-template handles both plain text and (when mediaKey is set) an
  // attachment pulled from R2 -- one endpoint covers both broadcast shapes.
  const res = await stub.fetch("http://do/send-template", {
    method: "POST",
    // Tells the session's outbound guard which limits apply (see
    // session/outbound-guard.ts); the public proxy strips this header.
    headers: { "Content-Type": "application/json", "X-Send-Kind": kind },
    body: JSON.stringify({ to: toJid, text, mediaKey }),
  });
  const json = readJson<{ ok: boolean; error?: string; key?: Record<string, unknown> }>(await res.json());
  if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/**
 * Pushes a realtime event to every browser subscribed to this session's
 * WebSocket (via the DO's internal /internal/emit route), so the CRM's
 * Broadcasts page updates live instead of polling. Best-effort: a failed
 * emit must never affect the send pipeline itself.
 */
type CampaignEvent =
  | { type: "campaign-progress"; campaignId: string; recipientStatus?: "sent" | "failed"; campaignStatus?: string }
  | { type: "scheduled-message"; scheduledMessageId: string; status: "sent" | "failed" };

async function emitToSession(env: Env, waSessionId: string, event: CampaignEvent) {
  try {
    const stub = env.WHATSAPP_SESSION.get(env.WHATSAPP_SESSION.idFromName(waSessionId));
    await stub.fetch("http://do/internal/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (err: any) {
    log.warn({ err, waSessionId, type: event.type }, "realtime emit failed");
  }
}

/** Re-enqueues a broadcast message with its own delay, capped to the Queues limit. */
async function requeue(env: Env, body: BroadcastQueueMessage, delaySeconds: number) {
  await env.BROADCAST_QUEUE.send(body, { delaySeconds: Math.min(Math.max(delaySeconds, 0), MAX_DELAY_SECONDS) });
}

/** One keyset page of a campaign's still-pending contact recipients.
 *  Keyset (id > cursor) rather than OFFSET: pages stay O(page) and don't
 *  skip/duplicate rows as the consumer resolves recipients mid-scan. */
async function loadContactRecipientsPage(db: Db, campaignId: string, afterId: string, limit: number) {
  return await db
    .select({
      recipientId: broadcastRecipients.id,
      contactId: broadcastRecipients.contactId,
      toJid: contacts.jid,
      name: contacts.name,
      phone: contacts.phoneNumber,
      lifecycleStage: contacts.lifecycleStage,
      groupJid: broadcastRecipients.groupJid,
    })
    .from(broadcastRecipients)
    .innerJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
    .where(
      and(
        eq(broadcastRecipients.campaignId, campaignId),
        eq(broadcastRecipients.status, "pending"),
        afterId ? gt(broadcastRecipients.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(broadcastRecipients.id))
    .limit(limit);
}

/** Same, for group recipients -- a separate join, so its own cursor. */
async function loadGroupRecipientsPage(
  db: Db,
  waSessionId: string,
  campaignId: string,
  afterId: string,
  limit: number,
) {
  return await db
    .select({
      recipientId: broadcastRecipients.id,
      contactId: sql<string | null>`null`,
      toJid: broadcastRecipients.groupJid,
      name: groups.name,
      phone: sql<string | null>`null`,
      lifecycleStage: sql<string | null>`null`,
      groupJid: broadcastRecipients.groupJid,
    })
    .from(broadcastRecipients)
    // groups are unique per (wa_session_id, jid) -- pin the join to this
    // campaign's number so the same group jid under another session can't
    // duplicate recipients (and so it can use groups_session_jid_idx).
    .innerJoin(groups, and(eq(groups.waSessionId, waSessionId), eq(broadcastRecipients.groupJid, groups.jid)))
    .where(
      and(
        eq(broadcastRecipients.campaignId, campaignId),
        eq(broadcastRecipients.status, "pending"),
        sql`${broadcastRecipients.groupJid} IS NOT NULL`,
        afterId ? gt(broadcastRecipients.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(broadcastRecipients.id))
    .limit(limit);
}

/** Rows read per page -- small enough to stay cheap on D1, big enough that a
 *  2,000-recipient campaign is a handful of queries instead of thousands. */
const RECIPIENT_PAGE_SIZE = 500;

/**
 * Enqueues one staggered Queue message per still-pending recipient (reading
 * them in keyset pages, so a big campaign never materialises every joined row
 * at once), then flips the campaign to "running". Safe to call twice (only
 * "pending" rows get enqueued).
 */
export async function startCampaign(db: Db, env: Env, campaignId: string) {
  const campaign = await db
    .select()
    .from(broadcastCampaigns)
    .where(eq(broadcastCampaigns.id, campaignId))
    .get();
  if (!campaign) throw new PublicError("Campaign not found", 404);
  if (!campaign.messageText && !campaign.mediaKey) throw new PublicError("Campaign has no message text or media");

  let contactCursor = "";
  let groupCursor = "";
  let enqueued = 0;
  let cumulativeDelay = 0;
  let markedRunning = false;

  for (;;) {
    const [contactRows, groupRows] = await Promise.all([
      loadContactRecipientsPage(db, campaignId, contactCursor, RECIPIENT_PAGE_SIZE),
      loadGroupRecipientsPage(db, campaign.waSessionId, campaignId, groupCursor, RECIPIENT_PAGE_SIZE),
    ]);
    if (contactRows.length) contactCursor = contactRows[contactRows.length - 1].recipientId;
    if (groupRows.length) groupCursor = groupRows[groupRows.length - 1].recipientId;

    const rows = [...contactRows, ...groupRows];
    if (rows.length > 0) {
      // Flip to running BEFORE the first enqueue: the first message has no
      // delay and a consumer could otherwise finish it before this status
      // write lands.
      if (!markedRunning) {
        await db.update(broadcastCampaigns).set({ status: "running" }).where(eq(broadcastCampaigns.id, campaignId));
        markedRunning = true;
        await emitToSession(env, campaign.waSessionId, { type: "campaign-progress", campaignId, campaignStatus: "running" });
      }

      const pending: MessageSendRequest<BroadcastQueueMessage>[] = [];
      for (const r of rows) {
        // Resolved per-recipient at enqueue time -- the queue message carries
        // the final text, not the template.
        const text = resolveTemplate(
          campaign.messageText,
          contactTemplateVariables({
            name: r.name,
            phoneNumber: r.phone,
            lifecycleStage: r.lifecycleStage,
          }),
        );
        pending.push({
          body: {
            campaignId,
            recipientId: r.recipientId,
            waSessionId: campaign.waSessionId,
            toJid: r.toJid!,
            text,
            mediaKey: campaign.mediaKey ?? undefined,
            contactId: r.contactId,
          },
          delaySeconds: Math.min(cumulativeDelay, MAX_DELAY_SECONDS),
        });
        cumulativeDelay += randomGapSeconds();
      }

      // Queue.sendBatch: up to 100 messages per call instead of one subrequest
      // per recipient (a 5,000-recipient campaign was 5,000 sequential sends in
      // one invocation -- far past the Worker subrequest budget).
      for (let i = 0; i < pending.length; i += QUEUE_BATCH_SIZE) {
        await env.BROADCAST_QUEUE.sendBatch(pending.slice(i, i + QUEUE_BATCH_SIZE));
      }
      enqueued += rows.length;
    }

    if (contactRows.length < RECIPIENT_PAGE_SIZE && groupRows.length < RECIPIENT_PAGE_SIZE) break;
  }

  if (enqueued === 0) {
    await db.update(broadcastCampaigns).set({ status: "completed" }).where(eq(broadcastCampaigns.id, campaignId));
    await emitToSession(env, campaign.waSessionId, { type: "campaign-progress", campaignId, campaignStatus: "completed" });
  }
}

/** Queue consumer: sends one recipient's message and records the outcome.
 *
 * D1 budget per recipient (success path): 1 session read (+1 rare daily
 * reset), 1 campaign read, 1 recipient update, 1 batch (session counters,
 * contact cooldown, campaign counter). Was ~12 sequential queries, including
 * a duplicate syncIncomingMessage (the session DO's /send-template already
 * writes the outbound message) and an O(recipients) failure-rate aggregate.
 * Counters use SQL increments so concurrent consumers can't lose updates.
 */
/**
 * Ack AFTER processing: an isolate crash / D1 blip mid-message used to lose
 * the recipient forever (acked up front, never retried). Now an unexpected
 * error before the WhatsApp send -> message.retry() (queue max_retries);
 * once the send has happened we always ack, so a bookkeeping failure can't
 * cause a duplicate send. Expected outcomes (paused, capped, send failure
 * with backoff) are handled inside and requeue explicitly.
 */
export async function handleBroadcastBatch(batch: MessageBatch<BroadcastQueueMessage>, env: Env, db: Db) {
  for (const message of batch.messages) {
    const state = { sent: false };
    try {
      await processBroadcastMessage(message.body, env, db, state);
      message.ack();
    } catch (err) {
      log.error({ err, recipientId: message.body.recipientId, sent: state.sent }, "broadcast message processing failed");
      if (state.sent) message.ack();
      else message.retry({ delaySeconds: 30 });
    }
  }
}

async function processBroadcastMessage(
  body: BroadcastQueueMessage,
  env: Env,
  db: Db,
  state: { sent: boolean },
): Promise<void> {
  {
    const { campaignId, recipientId, waSessionId, toJid, text, mediaKey } = body;

    // Idempotency: a redelivered / retried message for a recipient that's
    // already resolved must not send again.
    const recipient = await db
      .select({ status: broadcastRecipients.status })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.id, recipientId))
      .get();
    if (!recipient || recipient.status !== "pending") return;

    const session = await db.select().from(waSessions).where(eq(waSessions.id, waSessionId)).get();
    const now = Date.now();

    if (session?.broadcastPausedUntil && new Date(session.broadcastPausedUntil).getTime() > now) {
      const delay = Math.ceil((new Date(session.broadcastPausedUntil).getTime() - now) / 1000) + 30;
      await requeue(env, body, delay);
      return;
    }

    let dailyCount = session?.dailyBroadcastCount ?? 0;
    const resetAt = session?.dailyBroadcastResetAt ? new Date(session.dailyBroadcastResetAt).getTime() : 0;
    if (!resetAt || resetAt <= now) {
      dailyCount = 0;
      await db
        .update(waSessions)
        .set({ dailyBroadcastCount: 0, dailyBroadcastResetAt: new Date(now + 24 * 60 * 60 * 1000) })
        .where(eq(waSessions.id, waSessionId));
    }
    const effectiveDailyLimit = effectiveDailyBroadcastLimit(
      session?.createdAt ? new Date(session.createdAt) : null,
      new Date(now),
    );
    if (dailyCount >= effectiveDailyLimit) {
      const delayToReset = resetAt ? Math.ceil((resetAt - now) / 1000) + 60 : 60 * 60;
      await requeue(env, body, delayToReset);
      return;
    }

    const campaign = await db
      .select({
        pausedForFailureRate: broadcastCampaigns.pausedForFailureRate,
        failureRatePauseThreshold: broadcastCampaigns.failureRatePauseThreshold,
      })
      .from(broadcastCampaigns)
      .where(eq(broadcastCampaigns.id, campaignId))
      .get();
    if (!campaign) return; // campaign deleted -- drop the message
    if (campaign.pausedForFailureRate) {
      await markRecipientFailed(db, env, waSessionId, campaignId, recipientId, undefined);
      return;
    }

    try {
      await sendViaSession(env, waSessionId, toJid, text, mediaKey);
      state.sent = true;
      // Only a pending -> sent transition counts, so a redelivered queue
      // message can't double-count.
      const updated = await db
        .update(broadcastRecipients)
        .set({ status: "sent", sentAt: new Date() })
        .where(and(eq(broadcastRecipients.id, recipientId), eq(broadcastRecipients.status, "pending")))
        .returning({ contactId: broadcastRecipients.contactId })
        .get() as { contactId: string | null } | undefined;
      const contactId = body.contactId ?? updated?.contactId ?? null;
      const sessionWrite = db
        .update(waSessions)
        .set({ consecutiveFailures: 0, dailyBroadcastCount: sql`${waSessions.dailyBroadcastCount} + 1` })
        .where(eq(waSessions.id, waSessionId));
      const writes: any[] = [sessionWrite];
      if (contactId) {
        writes.push(db.update(contacts).set({ lastBroadcastAt: new Date() }).where(eq(contacts.id, contactId)));
      }
      if (updated) {
        writes.push(
          db
            .update(broadcastCampaigns)
            .set({ sentCount: sql`${broadcastCampaigns.sentCount} + 1` })
            .where(eq(broadcastCampaigns.id, campaignId))
            .returning({
              sentCount: broadcastCampaigns.sentCount,
              failedCount: broadcastCampaigns.failedCount,
              resolvedRecipientCount: broadcastCampaigns.resolvedRecipientCount,
            }),
        );
      }
      const results = await db.batch(writes as [typeof sessionWrite]);
      await emitToSession(env, waSessionId, { type: "campaign-progress", campaignId, recipientStatus: "sent" });
      if (updated) {
        const counters = (results[results.length - 1] as unknown as CampaignCounters[] | undefined)?.[0];
        await completeIfDone(db, env, waSessionId, campaignId, counters);
      }
    } catch (err: any) {
      log.error({ err, campaignId, recipientId, waSessionId }, "broadcast send failed");
      const consecutiveFailures = (session?.consecutiveFailures ?? 0) + 1;
      const tripBreaker = consecutiveFailures >= FAILURE_CIRCUIT_THRESHOLD;
      const [recipientRows] = await db.batch([
        db
          .update(broadcastRecipients)
          .set({ attempts: sql`${broadcastRecipients.attempts} + 1` })
          .where(eq(broadcastRecipients.id, recipientId))
          .returning({ attempts: broadcastRecipients.attempts }),
        db
          .update(waSessions)
          .set({
            consecutiveFailures: sql`${waSessions.consecutiveFailures} + 1`,
            ...(tripBreaker ? { broadcastPausedUntil: new Date(now + CIRCUIT_PAUSE_SECONDS * 1000) } : {}),
          })
          .where(eq(waSessions.id, waSessionId)),
      ]);
      const attempts = recipientRows[0]?.attempts ?? MAX_SEND_ATTEMPTS;

      if (attempts < MAX_SEND_ATTEMPTS) {
        const backoff = RETRY_BACKOFF_SECONDS[attempts - 1] ?? RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1];
        await requeue(env, body, tripBreaker ? Math.max(backoff, CIRCUIT_PAUSE_SECONDS) : backoff);
        return; // still pending
      }
      await markRecipientFailed(db, env, waSessionId, campaignId, recipientId, campaign.failureRatePauseThreshold);
    }
  }
}

type CampaignCounters = { sentCount: number; failedCount: number; resolvedRecipientCount: number | null };

/** pending -> failed (counted once), then the failure-rate breaker and the
 * completion check -- both from the campaign's counters, no aggregate scan. */
async function markRecipientFailed(
  db: Db,
  env: Env,
  waSessionId: string,
  campaignId: string,
  recipientId: string,
  threshold: number | null | undefined,
) {
  const updated = await db
    .update(broadcastRecipients)
    .set({ status: "failed" })
    .where(and(eq(broadcastRecipients.id, recipientId), eq(broadcastRecipients.status, "pending")))
    .returning({ id: broadcastRecipients.id })
    .get() as { id: string } | undefined;
  if (!updated) return;
  const counters = await db
    .update(broadcastCampaigns)
    .set({ failedCount: sql`${broadcastCampaigns.failedCount} + 1` })
    .where(eq(broadcastCampaigns.id, campaignId))
    .returning({
      sentCount: broadcastCampaigns.sentCount,
      failedCount: broadcastCampaigns.failedCount,
      resolvedRecipientCount: broadcastCampaigns.resolvedRecipientCount,
      pausedForFailureRate: broadcastCampaigns.pausedForFailureRate,
    })
    .get() as { sentCount: number; failedCount: number; resolvedRecipientCount: number | null; pausedForFailureRate: boolean } | undefined;
  await emitToSession(env, waSessionId, { type: "campaign-progress", campaignId, recipientStatus: "failed" });
  if (!counters) return;
  const attempted = counters.sentCount + counters.failedCount;
  if (threshold != null && !counters.pausedForFailureRate && counters.failedCount >= threshold && attempted >= 3) {
    await db
      .update(broadcastCampaigns)
      .set({ pausedForFailureRate: true, status: "failed" })
      .where(eq(broadcastCampaigns.id, campaignId));
    log.warn({ campaignId, failed: counters.failedCount }, "campaign paused: failure rate threshold crossed");
    await emitToSession(env, waSessionId, { type: "campaign-progress", campaignId, campaignStatus: "failed" });
    return;
  }
  await completeIfDone(db, env, waSessionId, campaignId, counters);
}

async function completeIfDone(
  db: Db,
  env: Env,
  waSessionId: string,
  campaignId: string,
  counters: CampaignCounters | undefined,
) {
  if (!counters) return;
  const total = counters.resolvedRecipientCount;
  if (total == null) {
    // Legacy campaign without a resolved count: fall back to one indexed
    // probe on broadcast_recipients_campaign_status_idx.
    const stillPending = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .where(and(eq(broadcastRecipients.campaignId, campaignId), eq(broadcastRecipients.status, "pending")))
      .limit(1)
      .get();
    if (stillPending) return;
  } else if (counters.sentCount + counters.failedCount < total) {
    return;
  }
  // Conditional so only one consumer flips it, and a breaker-failed
  // campaign is never overwritten to "completed".
  const flipped = await db
    .update(broadcastCampaigns)
    .set({ status: "completed" })
    .where(
      and(
        eq(broadcastCampaigns.id, campaignId),
        inArray(broadcastCampaigns.status, ["draft", "scheduled", "running"]),
      ),
    )
    .returning({ id: broadcastCampaigns.id })
    .get() as { id: string } | undefined;
  if (flipped) {
    await emitToSession(env, waSessionId, { type: "campaign-progress", campaignId, campaignStatus: "completed" });
  }
}

/** Cron tick: fires every individually-scheduled message that's now due. */
export async function dispatchDueScheduledMessages(db: Db, env: Env) {
  const due = await db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, "pending"), lte(scheduledMessages.sendAt, new Date())))
    .limit(50)
    .all();

  for (const row of due) {
    if (!row.body && !row.mediaKey) {
      await db.update(scheduledMessages).set({ status: "failed" }).where(eq(scheduledMessages.id, row.id));
      await emitToSession(env, row.waSessionId, { type: "scheduled-message", scheduledMessageId: row.id, status: "failed" });
      continue;
    }
    let status: "sent" | "failed" = "sent";
    try {
      await sendViaSession(env, row.waSessionId, row.toJid, row.body ?? "", row.mediaKey ?? undefined, "scheduled");
      await db.update(scheduledMessages).set({ status: "sent" }).where(eq(scheduledMessages.id, row.id));
    } catch {
      status = "failed";
      await db.update(scheduledMessages).set({ status: "failed" }).where(eq(scheduledMessages.id, row.id));
    }
    await emitToSession(env, row.waSessionId, { type: "scheduled-message", scheduledMessageId: row.id, status });
  }
}

/** Cron tick: kicks off (enqueues) any broadcast campaign whose time has come. */
export async function dispatchDueCampaigns(db: Db, env: Env) {
  const due = await db
    .select({ id: broadcastCampaigns.id })
    .from(broadcastCampaigns)
    .where(and(eq(broadcastCampaigns.status, "scheduled"), lte(broadcastCampaigns.scheduledAt, new Date())))
    .all();

  for (const row of due) {
    await startCampaign(db, env, row.id);
  }
}
