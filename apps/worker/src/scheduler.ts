// Exact-time delivery for scheduled messages, scheduled campaigns and
// failing webhook retries.
//
// Instead of a per-minute cron polling D1 forever, a single global
// `Scheduler` Durable Object arms a one-shot alarm to the *soonest* thing
// that needs doing (a pending scheduled message, a scheduled campaign, or a
// webhook delivery waiting on a retry). When the alarm fires it dispatches
// everything due and re-arms to the next one, so nothing idles.
//
// The DO alarm is the single dispatcher: the `*/5 * * * *` cron trigger
// (see wrangler.jsonc) no longer dispatches itself, it only pokes the
// Scheduler (POST /arm). That keeps one writer mutating `pending -> sent`
// rows, so a cron sweep and an alarm can never double-fire the same
// message, and a missed poke from apps/web is recovered within five
// minutes. Apps/web pokes the same endpoint right after it schedules or
// cancels anything, which is what turns "send at 14:00" from a minute-ish
// `scheduled_at <= now` scan into a sub-second alarm fire.
import {
  createDb,
  
  eq,
  and,
  lt,
  scheduledMessages,
  broadcastCampaigns,
  webhookDeliveries
} from "@workspace/db";
import type {Db} from "@workspace/db";
import type { Env } from "./index";
import { dispatchDueScheduledMessages, dispatchDueCampaigns } from "./broadcast";
import { retryFailedWebhookDeliveries, MAX_WEBHOOK_ATTEMPTS } from "./automation";
import { captureError } from "./error-tracking";

// Never re-arm closer than this: it caps an unhealthy (permanently-failing)
// pending row at ~one alarm per second at worst, and still lets a batch of
// more than 50 overdue messages drain one sweep per tick.
const MIN_REARM_DELAY_MS = 2_000;
// While at least one webhook delivery is waiting for a retry, keep the
// alarm ticking on this cadence (mirrors the old per-minute cron, but only
// while there's actually a retry to do).
const RETRY_CADENCE_MS = 60_000;

export class Scheduler implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/arm") {
      await this.arm();
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      const db = createDb(this.env.DB);
      await Promise.all([
        dispatchDueScheduledMessages(db, this.env),
        dispatchDueCampaigns(db, this.env),
        retryFailedWebhookDeliveries(db, this.env),
      ]);
    } finally {
      // Always re-arm, even (especially) when a dispatch threw, or a
      // stuck row would strand the scheduler in a dormant state.
      await this.arm();
    }
  }

  /** Points the alarm at the soonest pending item, or leaves it dormant. */
  async arm(): Promise<void> {
    try {
      const earliest = await this.earliestDueMs();
      if (earliest === null) return; // nothing pending: stay dormant
      const atMs = Math.max(earliest, Date.now() + MIN_REARM_DELAY_MS);
      await this.state.storage.setAlarm(new Date(atMs));
    } catch (err) {
      captureError(err, { module: "scheduler-arm" });
    }
  }

  private async earliestDueMs(): Promise<number | null> {
    const db = createDb(this.env.DB);
    const [nextMessage, nextCampaign, pendingRetry] = await Promise.all([
      db
        .select({ dueAt: scheduledMessages.sendAt })
        .from(scheduledMessages)
        .where(eq(scheduledMessages.status, "pending"))
        .orderBy(scheduledMessages.sendAt)
        .limit(1)
        .get(),
      db
        .select({ dueAt: broadcastCampaigns.scheduledAt })
        .from(broadcastCampaigns)
        .where(eq(broadcastCampaigns.status, "scheduled"))
        .orderBy(broadcastCampaigns.scheduledAt)
        .limit(1)
        .get(),
      // A webhook retry isn't an exact-time event like the two above, so
      // it gets a rolling deadline. Only count deliveries that still have
      // attempts left -- a permanently dead endpoint stops waking us.
      db
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.status, "failed"), lt(webhookDeliveries.attempts, MAX_WEBHOOK_ATTEMPTS)))
        .limit(1)
        .get(),
    ]);

    const candidates: number[] = [];
    if (nextMessage?.dueAt) candidates.push(nextMessage.dueAt.getTime());
    if (nextCampaign?.dueAt) candidates.push(nextCampaign.dueAt.getTime());
    if (pendingRetry) candidates.push(Date.now() + RETRY_CADENCE_MS);
    return candidates.length ? Math.min(...candidates) : null;
  }
}