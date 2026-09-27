// Exact totals for lists, pages and badges.
//
// Unfiltered totals come from `entity_counts`, kept exact by SQLite triggers
// (packages/db/migrations/0031_entity_counts.sql): reading one is a single
// primary-key lookup, never a count(*) over the rows it counts.
//
// A total for a *search* can't be pre-computed, so cappedCount() counts the
// matches but stops at COUNT_CAP -- the UI shows "10,000+" beyond that --
// so even a broad search never reads more than COUNT_CAP + 1 rows to count.
import { sql, entityCounts, inArray, and } from "@workspace/db"
import type { createDb } from "@workspace/db"

type Db = ReturnType<typeof createDb>

export const COUNT_CAP = 10_000

/** Counter names maintained by the triggers (scope in the comment). */
export const COUNTER = {
  contacts: "contacts", // workspace
  contactsSuppressed: "contacts_suppressed", // workspace
  convActive: "conv_active", // workspace: not archived ("All" tab)
  convArchived: "conv_archived",
  convUnread: "conv_unread",
  convPinned: "conv_pinned",
  convGroups: "conv_groups",
  convDirect: "conv_direct",
  campaigns: "campaigns", // workspace
  scheduled: "scheduled", // workspace
  mediaAssets: "media_assets", // workspace
  templates: "templates", // workspace
  groups: "groups", // workspace
  membersOwned: "members_owned", // contact list
  membersDisabled: "members_disabled", // contact list
  deals: "deals", // pipeline stage
  dealsValue: "deals_value", // pipeline stage (sum of value_cents)
  notes: "notes", // contact
} as const

export type CounterName = (typeof COUNTER)[keyof typeof COUNTER]

export type Total = { total: number; totalCapped: boolean }

/** Reads many counters in one query. Missing rows read as 0. */
export async function readCounts(db: Db, scopeIds: string[], names: CounterName[]) {
  const out = new Map<string, number>()
  if (scopeIds.length === 0 || names.length === 0) return out
  const rows = await db
    .select({ scopeId: entityCounts.scopeId, name: entityCounts.name, n: entityCounts.n })
    .from(entityCounts)
    .where(
      and(
        sql`${entityCounts.scopeId} IN (SELECT value FROM json_each(${JSON.stringify(Array.from(new Set(scopeIds)))}))`,
        inArray(entityCounts.name, names)
      )
    )
    .all()
  for (const r of rows) out.set(`${r.scopeId}:${r.name}`, Math.max(0, r.n))
  return out
}

export function countOf(counts: Map<string, number>, scopeId: string, name: CounterName) {
  return counts.get(`${scopeId}:${name}`) ?? 0
}

export async function readCount(db: Db, scopeId: string, name: CounterName): Promise<Total> {
  const counts = await readCounts(db, [scopeId], [name])
  return { total: countOf(counts, scopeId, name), totalCapped: false }
}

/**
 * Counts the rows of `query` (a drizzle select, WITHOUT its own limit),
 * reading at most COUNT_CAP + 1 of them.
 */
// Any drizzle select builder (they embed into sql`` as a subquery).
type Countable = { limit: (n: number) => unknown }

export async function cappedCount(db: Db, query: Countable): Promise<Total> {
  const sub = query.limit(COUNT_CAP + 1) as any // drizzle builders embed as SQL subqueries
  const row = await db.get<{ n: number } | undefined>(sql`SELECT count(*) AS n FROM (${sub})`)
  const n = Number(row?.n ?? 0)
  return n > COUNT_CAP ? { total: COUNT_CAP, totalCapped: true } : { total: n, totalCapped: false }
}
