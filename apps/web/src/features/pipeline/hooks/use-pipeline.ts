import { createServerFn } from "@tanstack/react-start"
import { requirePermission, requireCurrentPermission } from "@/lib/auth"
import { env } from "cloudflare:workers"
import {
  createDb,
  eq,
  and,
  asc,
  sql,
  pipelineStages,
  deals,
  contacts,
  conversations,
} from "@workspace/db"
import { withSafeErrors } from "@/lib/errors"
import { cursorLimit, decodeCursor, toCursorPage } from "@/lib/cursor"
import { COUNTER, countOf, readCounts } from "@/lib/counts"

function getDb() {
  return createDb(env.DB)
}

const DEFAULT_STAGES = [
  { name: "New Lead", color: "#6366f1" },
  { name: "Contacted", color: "#3b82f6" },
  { name: "Qualified", color: "#8b5cf6" },
  { name: "Won", color: "#22c55e" },
  { name: "Lost", color: "#ef4444" },
]

async function ensureStages(workspaceId: string) {
  const db = getDb()
  const existing = await db
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(eq(pipelineStages.workspaceId, workspaceId))
    .all()
  if (existing.length > 0) return

  // One batch instead of one round trip per stage.
  const statements = DEFAULT_STAGES.map((stage, i) =>
    db.insert(pipelineStages).values({ workspaceId, position: i, ...stage })
  )
  await db.batch(statements as [typeof statements[number], ...typeof statements[number][]])
}

/** The stage and the contact must both belong to the caller's workspace --
 *  otherwise a client could plant a deal against another tenant's ids. */
async function assertDealRefs(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  stageId: string,
  contactId: string
) {
  const [stage, contact] = await Promise.all([
    db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.workspaceId, workspaceId)))
      .get(),
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
      .get(),
  ])
  if (!stage) throw new Error("Stage not found.")
  if (!contact) throw new Error("Contact not found.")
}

const DEALS_PER_COLUMN = 50

const dealSelect = {
  id: deals.id,
  title: deals.title,
  valueCents: deals.valueCents,
  currency: deals.currency,
  stageId: deals.stageId,
  position: deals.position,
  contactId: deals.contactId,
  contactName: contacts.name,
  contactPhone: contacts.phoneNumber,
  contactAvatar: contacts.avatarUrl,
  lastContactedAt: contacts.lastContactedAt,
}

function stageDealsQuery(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  stageId: string,
  cursor: readonly [number, string] | null,
  limit: number
) {
  return db
    .select(dealSelect)
    .from(deals)
    // Join pinned to the workspace so a deal referencing another tenant's
    // contact can never surface that tenant's name/phone/avatar.
    .leftJoin(contacts, and(eq(deals.contactId, contacts.id), eq(contacts.workspaceId, workspaceId)))
    .where(
      and(
        eq(deals.stageId, stageId),
        eq(deals.workspaceId, workspaceId),
        cursor ? sql`(${deals.position}, ${deals.id}) > (${cursor[0]}, ${cursor[1]})` : undefined
      )
    )
    .orderBy(asc(deals.position), asc(deals.id))
    .limit(limit + 1)
}

/**
 * Board: stages + the first DEALS_PER_COLUMN deals of each column (one
 * indexed seek per stage on deals_stage_position_idx, all in one batch) +
 * per-column totals. Further cards load per column via getStageDeals.
 */
export const getPipeline = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await ensureStages(data.workspaceId)
      const db = getDb()

      const stages = await db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.workspaceId, data.workspaceId))
        .orderBy(asc(pipelineStages.position))
        .all()
      if (stages.length === 0) return { stages: [], deals: [] }

      // Column totals (count + value) are trigger-maintained counters: one
      // primary-key read per stage instead of aggregating every deal.
      const [perStage, counts] = await Promise.all([
        db.batch(
          stages.map((st) => stageDealsQuery(db, data.workspaceId, st.id, null, DEALS_PER_COLUMN)) as [
            ReturnType<typeof stageDealsQuery>,
            ...ReturnType<typeof stageDealsQuery>[],
          ]
        ),
        readCounts(
          db,
          stages.map((st) => st.id),
          [COUNTER.deals, COUNTER.dealsValue]
        ),
      ])

      const dealRows: (typeof perStage)[number] = []
      const stagesOut = stages.map((st, i) => {
        const page = toCursorPage(perStage[i], DEALS_PER_COLUMN, (d) => [d.position, d.id])
        dealRows.push(...page.items)
        return {
          ...st,
          dealCount: countOf(counts, st.id, COUNTER.deals),
          valueCents: countOf(counts, st.id, COUNTER.dealsValue),
          nextCursor: page.nextCursor,
        }
      })
      return { stages: stagesOut, deals: dealRows }
    })
  )

/** "Load more" for one board column, keyset on (position, id). */
export const getStageDeals = createServerFn()
  .validator(
    (data: { workspaceId: string; stageId: string; cursor: string; limit?: number }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const limit = cursorLimit(data.limit, DEALS_PER_COLUMN)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)
      const rows = await stageDealsQuery(db, data.workspaceId, data.stageId, cursor, limit).all()
      return toCursorPage(rows, limit, (d) => [d.position, d.id])
    })
  )

export const createDeal = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      stageId: string
      contactId: string
      title: string
      valueCents?: number
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_contacts")
      const db = getDb()
      await assertDealRefs(db, data.workspaceId, data.stageId, data.contactId)
      const deal = await db
        .insert(deals)
        .values({
          workspaceId: data.workspaceId,
          stageId: data.stageId,
          contactId: data.contactId,
          title: data.title,
          valueCents: data.valueCents ?? 0,
          position: Date.now(), // new cards land at the end; drag reorders explicitly
        })
        .returning()
        .get()
      return deal
    }, "Couldn't create the deal. Please try again.")
  )

export const updateDeal = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      dealId: string
      stageId: string
      contactId: string
      title: string
      valueCents?: number
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_contacts")
      const db = getDb()
      await assertDealRefs(db, data.workspaceId, data.stageId, data.contactId)
      await db
        .update(deals)
        .set({
          stageId: data.stageId,
          contactId: data.contactId,
          title: data.title,
          valueCents: data.valueCents ?? 0,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deals.id, data.dealId),
            eq(deals.workspaceId, data.workspaceId)
          )
        )
      return { ok: true }
    }, "Couldn't update the deal. Please try again.")
  )

export const deleteDeal = createServerFn({ method: "POST" })
  .validator((data: { dealId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const workspaceId = await requireCurrentPermission("manage_contacts")
      await db.delete(deals).where(and(eq(deals.id, data.dealId), eq(deals.workspaceId, workspaceId)))
      return { ok: true }
    }, "Couldn't delete the deal. Please try again.")
  )

export const moveDeal = createServerFn({ method: "POST" })
  .validator(
    (data: { dealId: string; stageId: string; position: number }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const workspaceId = await requireCurrentPermission("manage_contacts")
      const stage = await db
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .where(and(eq(pipelineStages.id, data.stageId), eq(pipelineStages.workspaceId, workspaceId)))
        .get()
      if (!stage) throw new Error("Stage not found.")
      await db
        .update(deals)
        .set({
          stageId: data.stageId,
          position: data.position,
          updatedAt: new Date(),
        })
        .where(and(eq(deals.id, data.dealId), eq(deals.workspaceId, workspaceId)))
      return { ok: true }
    }, "Couldn't move the deal. Please try again.")
  )

export const createDealFromConversation = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; conversationId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_contacts")
      const db = getDb()

      const conv = await db
        .select({
          contactId: conversations.contactId,
          contactName: contacts.name,
        })
        .from(conversations)
        .leftJoin(contacts, and(eq(conversations.contactId, contacts.id), eq(contacts.workspaceId, data.workspaceId)))
        .where(
          and(
            eq(conversations.id, data.conversationId),
            eq(conversations.workspaceId, data.workspaceId)
          )
        )
        .get()

      if (!conv) return { ok: false as const, reason: "not_found" as const }
      if (!conv.contactId)
        return { ok: false as const, reason: "group" as const }

      const existing = await db
        .select({ id: deals.id })
        .from(deals)
        .where(
          and(
            eq(deals.workspaceId, data.workspaceId),
            eq(deals.contactId, conv.contactId)
          )
        )
        .get()
      if (existing)
        return { ok: false as const, reason: "already_deal" as const }

      await ensureStages(data.workspaceId)

      const firstStage = await db
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .where(eq(pipelineStages.workspaceId, data.workspaceId))
        .orderBy(asc(pipelineStages.position))
        .limit(1)
        .get()
      if (!firstStage)
        return { ok: false as const, reason: "no_stage" as const }

      const deal = await db
        .insert(deals)
        .values({
          workspaceId: data.workspaceId,
          stageId: firstStage.id,
          contactId: conv.contactId,
          title: conv.contactName ?? "New deal",
          valueCents: 0,
          position: Date.now(),
        })
        .returning()
        .get()

      return { ok: true as const, deal }
    })
  )
