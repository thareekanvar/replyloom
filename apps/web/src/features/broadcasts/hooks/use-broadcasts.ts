import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import {
  createDb,
  eq,
  and,
  desc,
  sql,
  broadcastCampaigns,
  broadcastRecipients,
  scheduledMessages,
  waSessions,
  contacts,
  contactLists,
  resolveEligibleContactIds,
  getBroadcastSettings,
  effectiveDailyBroadcastLimit,
  warmUpMultiplier,
  BROADCAST_DAILY_SEND_LIMIT,
} from "@workspace/db"
import { UserFacingError, withSafeErrors } from "@/lib/errors"
import { createCampaignInput } from "@/lib/server-schemas"
import { assertIntInRange, assertShortText } from "@/lib/validate"
import {
  MAX_PENDING_SCHEDULED_PER_WORKSPACE,
  PERSONALIZATION_REQUIRED_MESSAGE,
  TYPE_TO_CONFIRM_THRESHOLD,
  isPersonalized,
} from "../lib/confirm"
import { toEpochSeconds } from "@/lib/dates"
import { callEngine } from "@/lib/wa-engine"
import { requireWorkspaceAccess, requirePermission, requireCurrentPermission } from "@/lib/auth"
import { cursorLimit, decodeCursor, toCursorPage } from "@/lib/cursor"
import { COUNTER, readCount } from "@/lib/counts"

function getDb() {
  return createDb(env.DB)
}

/** A session id from another workspace must never be usable to send. */
async function requireSession(db: ReturnType<typeof getDb>, workspaceId: string, waSessionId: string) {
  const session = await db
    .select({ id: waSessions.id })
    .from(waSessions)
    .where(and(eq(waSessions.id, waSessionId), eq(waSessions.workspaceId, workspaceId)))
    .get()
  if (!session) throw new UserFacingError("WhatsApp number not found in this workspace.")
  return session
}

// ── Audience picker data: everything the create-campaign / schedule-message
// dialogs need, in one round trip (contacts + tags + which contact has
// which tags), so recipient filtering happens client-side, instantly. ──
// ── Per-number sending limits (warm-up) ──
/** What each connected number may broadcast today -- same helper the
 * worker enforces with, so the UI never promises more than will send. */
export const getSendingLimits = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const sessions = await db
        .select({
          id: waSessions.id,
          label: waSessions.label,
          phoneNumber: waSessions.phoneNumber,
          status: waSessions.status,
          createdAt: waSessions.createdAt,
          dailyBroadcastCount: waSessions.dailyBroadcastCount,
          dailyBroadcastResetAt: waSessions.dailyBroadcastResetAt,
        })
        .from(waSessions)
        .where(eq(waSessions.workspaceId, data.workspaceId))
        .all()

      const now = new Date()
      return sessions.map((s) => {
        const windowActive = !!s.dailyBroadcastResetAt && s.dailyBroadcastResetAt > now
        const sentToday = windowActive ? s.dailyBroadcastCount : 0
        const dailyLimit = effectiveDailyBroadcastLimit(s.createdAt, now)
        return {
          id: s.id,
          label: s.label,
          phoneNumber: s.phoneNumber,
          status: s.status,
          ageDays: Math.floor((now.getTime() - s.createdAt.getTime()) / 86_400_000),
          warmUpPercent: Math.round(warmUpMultiplier(s.createdAt, now) * 100),
          dailyLimit,
          fullLimit: BROADCAST_DAILY_SEND_LIMIT,
          sentToday,
          remainingToday: Math.max(0, dailyLimit - sentToday),
          resetsAt: windowActive ? toEpochSeconds(s.dailyBroadcastResetAt) : null,
        }
      })
    })
  )

// ── Broadcast campaigns ──
/** Newest-first, keyset-paged on broadcast_campaigns_workspace_created_idx
 * (workspace_id, created_at DESC, id DESC). */
export const getCampaigns = createServerFn()
  .validator(
    (data: { workspaceId: string; cursor?: string | null; limit?: number }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const limit = cursorLimit(data.limit)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)

      const rows = await db
        .select({ campaign: broadcastCampaigns, sortT: sql<number>`${broadcastCampaigns.createdAt}` })
        .from(broadcastCampaigns)
        .where(
          and(
            eq(broadcastCampaigns.workspaceId, data.workspaceId),
            cursor
              ? sql`(${broadcastCampaigns.createdAt}, ${broadcastCampaigns.id}) < (${cursor[0]}, ${cursor[1]})`
              : undefined
          )
        )
        .orderBy(desc(broadcastCampaigns.createdAt), desc(broadcastCampaigns.id))
        .limit(limit + 1)
        .all()
      const page = toCursorPage(rows, limit, (r) => [Number(r.sortT), r.campaign.id])
      const totals = cursor ? null : await readCount(db, data.workspaceId, COUNTER.campaigns)

      return { hasMore: page.hasMore, nextCursor: page.nextCursor, total: totals?.total ?? null, totalCapped: false, items: page.items.map(({ campaign: c }) => ({
        ...c,
        scheduledAt: toEpochSeconds(c.scheduledAt),
        createdAt: toEpochSeconds(c.createdAt)!,
        // Denormalized counters (bumped by the engine's queue consumer) --
        // the old per-load GROUP BY re-read every recipient of every
        // campaign in the workspace.
        stats: {
          total: c.resolvedRecipientCount ?? 0,
          sent: c.sentCount,
          failed: c.failedCount,
          pending: Math.max(
            0,
            (c.resolvedRecipientCount ?? 0) - c.sentCount - c.failedCount
          ),
        },
      })) }
    })
  )

export const createCampaign = createServerFn({ method: "POST" })
  .validator(createCampaignInput)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireCurrentPermission("manage_broadcasts")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      await requireSession(db, data.workspaceId, data.waSessionId)
      if (!isPersonalized(data.messageText)) {
        throw new UserFacingError(PERSONALIZATION_REQUIRED_MESSAGE)
      }

      // Campaigns only ever target a contact list -- see
      // claude/broadcast-anti-spam-design-2026-09-23.md. Every guard below
      // runs server-side so this can't be bypassed by a client that skips
      // the UI's own checks.
      const list = await db
        .select()
        .from(contactLists)
        .where(and(eq(contactLists.id, data.contactListId), eq(contactLists.workspaceId, data.workspaceId)))
        .get()
      if (!list) throw new UserFacingError("Contact list not found")
      if (list.status === "archived") {
        throw new UserFacingError("This list is archived and can't be used for broadcasts.")
      }

      const settings = await getBroadcastSettings(db, data.workspaceId)
      const now = new Date()

      if (list.usableAfter && list.usableAfter > now) {
        throw new UserFacingError(
          `This list isn't usable yet -- it's still aging (usable at ${list.usableAfter.toLocaleString()}). New members must sit for 24h before a list can be broadcast to.`
        )
      }
      if (list.lastUsedAt) {
        const minIntervalMs = settings.listMinIntervalHours * 60 * 60 * 1000
        const nextUsable = new Date(list.lastUsedAt.getTime() + minIntervalMs)
        if (nextUsable > now) {
          throw new UserFacingError(
            `This list was already used for a broadcast recently. It can be used again after ${nextUsable.toLocaleString()}.`
          )
        }
      }

      const eligibleContactIds = await resolveEligibleContactIds(db, {
        listId: data.contactListId,
        workspaceId: data.workspaceId,
        cooldownDays: settings.cooldownDays,
      })

      if (eligibleContactIds.length === 0) {
        throw new UserFacingError("No eligible recipients -- everyone in this list is suppressed, on cooldown, or owned by another list.")
      }
      if (eligibleContactIds.length > settings.recipientCeiling) {
        throw new UserFacingError(
          `This list resolves to ${eligibleContactIds.length} eligible contacts, which exceeds this workspace's broadcast limit of ${settings.recipientCeiling}. Split it into multiple lists/campaigns spread over multiple days.`
        )
      }

      if (
        eligibleContactIds.length >= TYPE_TO_CONFIRM_THRESHOLD &&
        data.confirmedRecipientCount !== eligibleContactIds.length
      ) {
        throw new UserFacingError(
          `This broadcast goes to ${eligibleContactIds.length} people. Type that number to confirm before sending.`
        )
      }

      const campaign = await db
        .insert(broadcastCampaigns)
        .values({
          workspaceId: data.workspaceId,
          waSessionId: data.waSessionId,
          name: data.name,
          messageText: data.messageText,
          mediaKey: data.mediaKey ?? null,
          contactListId: data.contactListId,
          resolvedRecipientCount: eligibleContactIds.length,
          // A spiking failure rate on this specific campaign auto-pauses it
          // -- 15% of the resolved count, floor of 3 so tiny campaigns
          // aren't tripped by a single bad number.
          failureRatePauseThreshold: Math.max(3, Math.ceil(eligibleContactIds.length * 0.15)),
          status: data.scheduledAt ? "scheduled" : "draft",
          scheduledAt: data.scheduledAt
            ? new Date(data.scheduledAt * 1000)
            : null,
        })
        .returning()
        .get()

      // One multi-row INSERT with 3 bound params per row blew D1's
      // 100-parameter cap past ~33 recipients. Ids now travel as a single
      // JSON parameter per 500 rows (json_each), all in one batch.
      const recipientStatements = []
      for (let i = 0; i < eligibleContactIds.length; i += 500) {
        const rows = JSON.stringify(
          eligibleContactIds
            .slice(i, i + 500)
            .map((contactId) => [crypto.randomUUID(), contactId])
        )
        recipientStatements.push(
          db.run(sql`
            INSERT INTO broadcast_recipients (id, campaign_id, contact_id, status, attempts)
            SELECT json_extract(value, '$[0]'), ${campaign.id}, json_extract(value, '$[1]'), 'pending', 0
            FROM json_each(${rows})`)
        )
      }
      if (recipientStatements.length > 0) {
        await db.batch(recipientStatements as [any, ...any[]])
      }
      await db.update(contactLists).set({ lastUsedAt: now }).where(eq(contactLists.id, data.contactListId))

      // "Send now": hand off to the engine worker, which enqueues one
      // staggered Queue message per recipient (anti-ban delay). A
      // scheduled campaign is left as-is, but the engine's Scheduler is
      // poked so its alarm fires at `scheduledAt` (sub-minute) instead of
      // waiting for the next cron sweep.
      if (!data.scheduledAt) {
        await callEngine(`/broadcast/${campaign.id}/start`, data.workspaceId, {
          method: "POST",
        })
      } else {
        await callEngine("/schedule/arm", data.workspaceId, { method: "POST" })
      }

      return campaign
    }, "Couldn't create the campaign. Please try again.")
  )

export const deleteCampaign = createServerFn({ method: "POST" })
  .validator((data: { campaignId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireCurrentPermission("manage_broadcasts")
      const db = getDb()
      // Only campaigns that aren't actively sending can be deleted —
      // a running campaign already has recipients queued on the engine.
      const row = await db
        .select({
          status: broadcastCampaigns.status,
          workspaceId: broadcastCampaigns.workspaceId,
        })
        .from(broadcastCampaigns)
        .where(eq(broadcastCampaigns.id, data.campaignId))
        .get()
      if (!row || row.status === "running") {
        return { ok: false, reason: "running" as const }
      }
      await requireWorkspaceAccess(row.workspaceId)
      await db
        .delete(broadcastRecipients)
        .where(eq(broadcastRecipients.campaignId, data.campaignId))
      await db
        .delete(broadcastCampaigns)
        .where(eq(broadcastCampaigns.id, data.campaignId))
      return { ok: true }
    }, "Couldn't delete the broadcast. Please try again.")
  )

// ── Individually scheduled messages ──
/** Latest send time first, keyset-paged on
 * scheduled_messages_workspace_send_idx (workspace_id, send_at DESC, id DESC). */
export const getScheduledMessages = createServerFn()
  .validator(
    (data: { workspaceId: string; cursor?: string | null; limit?: number }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const limit = cursorLimit(data.limit)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)

      const rows = await db
        .select({ row: scheduledMessages, sortT: sql<number>`${scheduledMessages.sendAt}` })
        .from(scheduledMessages)
        .where(
          and(
            eq(scheduledMessages.workspaceId, data.workspaceId),
            cursor
              ? sql`(${scheduledMessages.sendAt}, ${scheduledMessages.id}) < (${cursor[0]}, ${cursor[1]})`
              : undefined
          )
        )
        .orderBy(desc(scheduledMessages.sendAt), desc(scheduledMessages.id))
        .limit(limit + 1)
        .all()
      const page = toCursorPage(rows, limit, (r) => [Number(r.sortT), r.row.id])
      const totals = cursor ? null : await readCount(db, data.workspaceId, COUNTER.scheduled)

      return {
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        total: totals?.total ?? null,
        totalCapped: false,
        items: page.items.map(({ row: r }) => ({
          ...r,
          sendAt: toEpochSeconds(r.sendAt)!,
          createdAt: toEpochSeconds(r.createdAt)!,
        })),
      }
    })
  )

export const createScheduledMessage = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      waSessionId: string
      toJid: string
      body: string
      sendAt: number
    }) => {
      // `sendAt` is seconds and becomes `new Date(sendAt * 1000)` below --
      // a string/NaN would turn into an Invalid Date (or a send centuries
      // away that the scheduler has to keep re-reading).
      assertIntInRange(
        data.sendAt,
        "schedule time",
        Math.floor(Date.now() / 1000) - 300,
        Math.floor(Date.now() / 1000) + 366 * 24 * 3600
      )
      assertShortText(data.body, "message", 4096)
      assertShortText(data.toJid, "recipient", 256)
      return data
    }
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "send_messages")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      await requireSession(db, data.workspaceId, data.waSessionId)

      // Scheduled messages are 1:1, but without limits they'd be a way to
      // script a broadcast around every campaign guard. Both lookups below
      // lead with `status` so they ride scheduled_messages_due_idx.
      const pending = await db
        .select({ toJid: scheduledMessages.toJid })
        .from(scheduledMessages)
        .where(and(eq(scheduledMessages.status, "pending"), eq(scheduledMessages.workspaceId, data.workspaceId)))
        .all()
      if (pending.length >= MAX_PENDING_SCHEDULED_PER_WORKSPACE) {
        throw new UserFacingError(
          `This workspace already has ${pending.length} scheduled messages waiting (limit ${MAX_PENDING_SCHEDULED_PER_WORKSPACE}). Use a broadcast to a contact list for bulk sends.`
        )
      }
      if (pending.some((p) => p.toJid === data.toJid)) {
        throw new UserFacingError("There's already a scheduled message waiting for this contact.")
      }

      // Automated sends never reach someone who opted out. One targeted row
      // lookup (workspace + jid) instead of loading every suppressed
      // contact of the workspace into memory just to test this one jid.
      const suppressed = await db
        .select({ jid: contacts.jid })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, data.workspaceId),
            eq(contacts.jid, data.toJid),
            eq(contacts.doNotBroadcast, true)
          )
        )
        .limit(1)
        .get()
      if (suppressed) {
        throw new UserFacingError("This contact is on the do-not-contact list, so automated messages can't be scheduled to them.")
      }

      const row = await db
        .insert(scheduledMessages)
        .values({
          workspaceId: data.workspaceId,
          waSessionId: data.waSessionId,
          toJid: data.toJid,
          body: data.body,
          sendAt: new Date(data.sendAt * 1000),
        })
        .returning()
        .get()
      // Re-arm the engine's Scheduler so this message's alarm fires at
      // `sendAt` (sub-minute) instead of on the next cron sweep.
      await callEngine("/schedule/arm", data.workspaceId, { method: "POST" })
      return row
    }, "Couldn't schedule the message. Please try again.")
  )

export const cancelScheduledMessage = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireCurrentPermission("send_messages")
      const db = getDb()
      const schedule = await db
        .select({ workspaceId: scheduledMessages.workspaceId })
        .from(scheduledMessages)
        .where(eq(scheduledMessages.id, data.id))
        .get()
      if (!schedule) throw new Error("Scheduled message not found")
      await requireWorkspaceAccess(schedule.workspaceId)
      await db
        .update(scheduledMessages)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(scheduledMessages.id, data.id),
            eq(scheduledMessages.status, "pending")
          )
        )
      // Re-arm in case the cancelled message was the one the alarm pointed at.
      await callEngine("/schedule/arm", schedule.workspaceId, {
        method: "POST",
      })
      return { ok: true }
    }, "Couldn't cancel the scheduled message. Please try again.")
  )
