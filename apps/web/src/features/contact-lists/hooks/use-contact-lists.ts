// Contact-lists CRUD + settings for the broadcast anti-spam system.
// Design doc: claude/broadcast-anti-spam-design-2026-09-23.md (project docs).
// A campaign may only target a list (see use-broadcasts.ts createCampaign) --
// this file is the only place lists/membership/settings are written.
import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import {
  createDb,
  eq,
  and,
  desc,
  like,
  gte,
  lte,
  sql,
  contacts,
  contactLists,
  contactListMembers,
  contactTags,
  tags,
  groups,
  groupMembers,
  waSessions,
  workspaceBroadcastSettings,
  addContactsToListBulk,
  reassignContactOwnership as reassignOwnership,
  recomputeListUsableAfter,
  resolveEligibleContactIds,
  getBroadcastSettings,
  ANTI_BAN_HARD_MAX_CEILING,
} from "@workspace/db"
import type { ALLOWED_COOLDOWN_DAYS } from "@workspace/db"
import { UserFacingError, withSafeErrors } from "@/lib/errors"
import { requireWorkspaceAccess, getCurrentUser, requirePermission } from "@/lib/auth"
import { cursorLimit, decodeCursor, toCursorPage } from "@/lib/cursor"
import { COUNTER, cappedCount, countOf, readCount, readCounts } from "@/lib/counts"

/** LIKE pattern with %/_ escaped (pair with ESCAPE '\\'). */
function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

function getDb() {
  return createDb(env.DB)
}

type Db = ReturnType<typeof getDb>

/** Max contacts accepted by a single add call -- stops one request from
 * bulk-dumping thousands of numbers into a list. */
const MAX_CONTACTS_PER_ADD = 200
/** Ids per json_each statement in filterAddableContacts. */
const FILTER_CHUNK = 5000

/** Every list-scoped call goes through this -- a list id from another
 * workspace must never be readable or writable. */
async function requireList(
  db: Db,
  workspaceId: string,
  listId: string,
  opts: { writable?: boolean } = {}
) {
  const list = await db
    .select()
    .from(contactLists)
    .where(and(eq(contactLists.id, listId), eq(contactLists.workspaceId, workspaceId)))
    .get()
  if (!list) throw new UserFacingError("List not found")
  if (opts.writable && list.status === "archived") {
    throw new UserFacingError("This list is archived and can't be changed")
  }
  return list
}

/**
 * Applies the workspace's list-sourcing mode to a batch of candidate
 * contacts: drops anything outside this workspace, and in
 * `conversation_only` mode drops contacts with no existing conversation
 * (cold / imported numbers are the biggest ban + spam risk).
 */
async function filterAddableContacts(db: Db, workspaceId: string, contactIds: string[]) {
  const unique = Array.from(new Set(contactIds))
  if (unique.length === 0) return { allowed: [] as string[], skipped: 0 }
  const settings = await getBroadcastSettings(db, workspaceId)
  const needsConversation = settings.listSourcingMode === "conversation_only"
  // One statement per 5,000 ids -- the ids travel as a single bound JSON
  // parameter (json_each), so D1's 100-parameter cap doesn't force the old
  // 2-queries-per-90-ids loop (which alone blew the per-invocation query
  // budget on large smart lists). Both checks in one indexed pass:
  // contacts PK + conversations_contact_idx.
  const allowed: string[] = []
  for (let i = 0; i < unique.length; i += FILTER_CHUNK) {
    const ids = JSON.stringify(unique.slice(i, i + FILTER_CHUNK))
    const rows = await db.all<{ id: string }>(sql`
      SELECT c.id AS id FROM json_each(${ids}) j
      JOIN contacts c ON c.id = j.value AND c.workspace_id = ${workspaceId}
      WHERE ${needsConversation ? sql`EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = c.id AND v.workspace_id = ${workspaceId})` : sql`1`}`)
    for (const r of rows) allowed.push(r.id)
  }
  return { allowed, skipped: unique.length - allowed.length }
}

// ── Lists ──
export const getContactLists = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()

      const lists = await db
        .select()
        .from(contactLists)
        .where(eq(contactLists.workspaceId, data.workspaceId))
        .orderBy(desc(contactLists.createdAt))
        .all()

      // Exact per-list totals from the trigger-maintained counters: one
      // primary-key read per list instead of a GROUP BY over every
      // membership row in the workspace.
      const counts = await readCounts(
        db,
        lists.map((l) => l.id),
        [COUNTER.membersOwned, COUNTER.membersDisabled]
      )
      return lists.map((l) => ({
        ...l,
        stats: {
          owned: countOf(counts, l.id, COUNTER.membersOwned),
          disabled: countOf(counts, l.id, COUNTER.membersDisabled),
        },
      }))
    })
  )

type ListRule = NonNullable<(typeof contactLists.$inferSelect)["rule"]>

const CUSTOM_FIELD_KEY_RE = /^[A-Za-z0-9_]{1,40}$/

/** Rules are a closed set -- validate shape server-side so nothing
 * unexpected is ever stored or compiled into a query. */
async function validateRule(
  db: Db,
  workspaceId: string,
  rule: { field: string; op: string; value: string; key?: string }
): Promise<ListRule> {
  const value = rule.value.trim()
  if (!value) throw new UserFacingError("Enter a value for the rule.")
  switch (rule.field) {
    case "tag":
      if (rule.op !== "has_tag") break
      return { field: "tag", op: "has_tag", value }
    case "lifecycleStage":
      if (rule.op !== "equals") break
      return { field: "lifecycleStage", op: "equals", value }
    case "organizationName":
      if (rule.op !== "contains") break
      return { field: "organizationName", op: "contains", value }
    case "lastContactedAt":
      if (rule.op !== "before" && rule.op !== "after") break
      if (Number.isNaN(new Date(value).getTime())) throw new UserFacingError("Enter a valid date (YYYY-MM-DD).")
      return { field: "lastContactedAt", op: rule.op, value }
    case "whatsappGroup": {
      if (rule.op !== "member_of") break
      const group = await db
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.id, value), eq(groups.workspaceId, workspaceId)))
        .get()
      if (!group) throw new UserFacingError("That WhatsApp group wasn't found in this workspace.")
      return { field: "whatsappGroup", op: "member_of", value }
    }
    case "customField": {
      const key = rule.key?.trim() ?? ""
      if (!CUSTOM_FIELD_KEY_RE.test(key)) {
        throw new UserFacingError("Custom field key can only use letters, numbers and underscores.")
      }
      if (rule.op !== "contains" && rule.op !== "equals") break
      return { field: "customField", op: rule.op, value, key }
    }
  }
  throw new UserFacingError("Unsupported rule.")
}

/** WhatsApp groups synced for this workspace -- options for the
 * "Member of WhatsApp group" smart-list rule. */
/** Group picker for the "Member of WhatsApp group" smart-list rule:
 * searchable, keyset-paged by (name, id) on groups_workspace_name_idx
 * instead of returning every group in the workspace. */
export const getWorkspaceGroups = createServerFn()
  .validator(
    (data: { workspaceId: string; q?: string; cursor?: string | null; limit?: number }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const limit = cursorLimit(data.limit, 50)
      const cursor = decodeCursor(data.cursor, ["s", "s"] as const)
      const q = (data.q ?? "").trim().slice(0, 100)
      const rows = await db
        .select({
          id: groups.id,
          name: groups.name,
          jid: groups.jid,
          participantCount: groups.participantCount,
          sessionLabel: waSessions.label,
          sortName: sql<string>`coalesce(${groups.name}, '')`,
        })
        .from(groups)
        .innerJoin(waSessions, eq(waSessions.id, groups.waSessionId))
        .where(
          and(
            eq(groups.workspaceId, data.workspaceId),
            q ? sql`${groups.name} LIKE ${likePattern(q)} ESCAPE '\\'` : undefined,
            cursor ? sql`(coalesce(${groups.name}, ''), ${groups.id}) > (${cursor[0]}, ${cursor[1]})` : undefined
          )
        )
        .orderBy(sql`coalesce(${groups.name}, '')`, groups.id)
        .limit(limit + 1)
        .all()
      const page = toCursorPage(rows, limit, (r) => [r.sortName, r.id])
      const totals = cursor
        ? null
        : q
          ? await cappedCount(
              db,
              db
                .select({ one: sql`1` })
                .from(groups)
                .where(and(eq(groups.workspaceId, data.workspaceId), sql`${groups.name} LIKE ${likePattern(q)} ESCAPE '\\'`))
            )
          : await readCount(db, data.workspaceId, COUNTER.groups)
      return {
        ...page,
        total: totals?.total ?? null,
        totalCapped: totals?.totalCapped ?? false,
        items: page.items.map(({ sortName: _n, ...r }) => r),
      }
    })
  )

/** One group by id -- for showing a smart list's current group rule
 * without loading the whole group list. */
export const getWorkspaceGroup = createServerFn()
  .validator((data: { workspaceId: string; groupId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      return (
        (await db
          .select({
            id: groups.id,
            name: groups.name,
            jid: groups.jid,
            participantCount: groups.participantCount,
            sessionLabel: waSessions.label,
          })
          .from(groups)
          .innerJoin(waSessions, eq(waSessions.id, groups.waSessionId))
          .where(and(eq(groups.id, data.groupId), eq(groups.workspaceId, data.workspaceId)))
          .get()) ?? null
      )
    })
  )

export const createContactList = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      name: string
      kind: "static" | "smart"
      rule?: { field: string; op: string; value: string; key?: string } | null
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_broadcasts")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const user = await getCurrentUser()
      const list = await db
        .insert(contactLists)
        .values({
          workspaceId: data.workspaceId,
          name: data.name.trim(),
          kind: data.kind,
          rule:
            data.kind === "smart"
              ? await validateRule(db, data.workspaceId, data.rule ?? { field: "", op: "", value: "" })
              : null,
          createdBy: user?.user.id ?? null,
        })
        .returning()
        .get()
      return list
    }, "Couldn't create the list. Please try again.")
  )

export const archiveContactList = createServerFn({ method: "POST" })
  .validator((data: { listId: string; workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_broadcasts")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      await requireList(db, data.workspaceId, data.listId)
      await db.update(contactLists).set({ status: "archived" }).where(eq(contactLists.id, data.listId))
      return { ok: true }
    }, "Couldn't archive the list. Please try again.")
  )

// ── Membership ──
/** One tab (approved = owned / disabled) of a list's members, newest-added
 * first, keyset-paged on contact_list_members_list_ownership_idx
 * (list_id, ownership, added_at DESC, id DESC), with server-side search. */
export const getContactListMembers = createServerFn()
  .validator(
    (data: {
      workspaceId: string
      listId: string
      ownership: "owned" | "disabled"
      q?: string
      cursor?: string | null
      limit?: number
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      await requireList(db, data.workspaceId, data.listId)
      const limit = cursorLimit(data.limit, 50)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)
      const q = (data.q ?? "").trim().slice(0, 100)
      const rows = await db
        .select({
          memberId: contactListMembers.id,
          contactId: contacts.id,
          name: contacts.name,
          phoneNumber: contacts.phoneNumber,
          jid: contacts.jid,
          ownership: contactListMembers.ownership,
          source: contactListMembers.source,
          addedAt: contactListMembers.addedAt,
          currentOwnerListId: contacts.broadcastListId,
          doNotBroadcast: contacts.doNotBroadcast,
          lastBroadcastAt: contacts.lastBroadcastAt,
          sortT: sql<number>`${contactListMembers.addedAt}`,
        })
        .from(contactListMembers)
        .innerJoin(contacts, eq(contacts.id, contactListMembers.contactId))
        .where(
          and(
            eq(contactListMembers.listId, data.listId),
            eq(contactListMembers.ownership, data.ownership),
            q
              ? sql`(${contacts.name} LIKE ${likePattern(q)} ESCAPE '\\' OR ${contacts.phoneNumber} LIKE ${likePattern(q)} ESCAPE '\\' OR ${contacts.jid} LIKE ${likePattern(q)} ESCAPE '\\')`
              : undefined,
            cursor
              ? sql`(${contactListMembers.addedAt}, ${contactListMembers.id}) < (${cursor[0]}, ${cursor[1]})`
              : undefined
          )
        )
        .orderBy(desc(contactListMembers.addedAt), desc(contactListMembers.id))
        .limit(limit + 1)
        .all()
      const page = toCursorPage(rows, limit, (r) => [Number(r.sortT), r.memberId])
      const totals = cursor
        ? null
        : q
          ? await cappedCount(
              db,
              db
                .select({ one: sql`1` })
                .from(contactListMembers)
                .innerJoin(contacts, eq(contacts.id, contactListMembers.contactId))
                .where(
                  and(
                    eq(contactListMembers.listId, data.listId),
                    eq(contactListMembers.ownership, data.ownership),
                    sql`(${contacts.name} LIKE ${likePattern(q)} ESCAPE '\\' OR ${contacts.phoneNumber} LIKE ${likePattern(q)} ESCAPE '\\' OR ${contacts.jid} LIKE ${likePattern(q)} ESCAPE '\\')`
                  )
                )
            )
          : await readCount(
              db,
              data.listId,
              data.ownership === "owned" ? COUNTER.membersOwned : COUNTER.membersDisabled
            )
      return {
        ...page,
        total: totals?.total ?? null,
        totalCapped: totals?.totalCapped ?? false,
        items: page.items.map(({ sortT: _t, ...r }) => r),
      }
    })
  )

/** Is this contact already in the list? (search-add dedupe without loading
 * every member) -- returns the subset of ids that are members. */
export const getListMembership = createServerFn()
  .validator((data: { workspaceId: string; listId: string; contactIds: string[] }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      await requireList(db, data.workspaceId, data.listId)
      const ids = Array.from(new Set(data.contactIds)).slice(0, 200)
      if (ids.length === 0) return [] as string[]
      const rows = await db.all<{ id: string }>(sql`
        SELECT m.contact_id AS id FROM contact_list_members m
        WHERE m.list_id = ${data.listId}
          AND m.contact_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`)
      return rows.map((r) => r.id)
    })
  )

export const addContactsToList = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; listId: string; contactIds: string[] }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_broadcasts")
      await requireWorkspaceAccess(data.workspaceId)
      if (data.contactIds.length > MAX_CONTACTS_PER_ADD) {
        throw new UserFacingError(`You can add at most ${MAX_CONTACTS_PER_ADD} contacts at a time.`)
      }
      const db = getDb()
      const list = await requireList(db, data.workspaceId, data.listId, { writable: true })
      if (list.kind !== "static") throw new UserFacingError("Smart lists are filled by their rule -- use Refresh instead")
      const { allowed, skipped } = await filterAddableContacts(db, data.workspaceId, data.contactIds)
      await addContactsToListBulk(db, {
        workspaceId: data.workspaceId,
        listId: data.listId,
        contactIds: allowed,
        source: "manual",
      })
      if (allowed.length) await recomputeListUsableAfter(db, data.listId, 24)
      return { ok: true, added: allowed.length, skipped }
    }, "Couldn't add contacts to the list. Please try again.")
  )

export const removeContactFromList = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; listId: string; contactId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_broadcasts")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      await requireList(db, data.workspaceId, data.listId, { writable: true })
      await db
        .delete(contactListMembers)
        .where(and(eq(contactListMembers.listId, data.listId), eq(contactListMembers.contactId, data.contactId)))
      // If this contact owned this list, clear ownership so it can be
      // reassigned/re-added cleanly -- never leave a dangling owner pointer.
      const contact = await db
        .select({ broadcastListId: contacts.broadcastListId })
        .from(contacts)
        .where(eq(contacts.id, data.contactId))
        .get()
      if (contact?.broadcastListId === data.listId) {
        await db
          .update(contacts)
          .set({ broadcastListId: null, broadcastListSince: null })
          .where(eq(contacts.id, data.contactId))
      }
      return { ok: true }
    }, "Couldn't remove the contact. Please try again.")
  )

/** "Use this list instead" -- the only way ownership moves once set. */
export const reassignContactOwnership = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; contactId: string; toListId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_broadcasts")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      await requireList(db, data.workspaceId, data.toListId, { writable: true })
      const contact = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, data.contactId), eq(contacts.workspaceId, data.workspaceId)))
        .get()
      if (!contact) throw new UserFacingError("Contact not found")
      await reassignOwnership(db, { contactId: data.contactId, toListId: data.toListId })
      return { ok: true }
    }, "Couldn't reassign the contact. Please try again.")
  )

/** Real resolved eligible count -- what the campaign-creation UI must show before allowing send. */
export const getListEligibility = createServerFn()
  .validator((data: { workspaceId: string; listId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const settings = await getBroadcastSettings(db, data.workspaceId)
      const list = await requireList(db, data.workspaceId, data.listId)
      const eligibleContactIds = await resolveEligibleContactIds(db, {
        listId: data.listId,
        workspaceId: data.workspaceId,
        cooldownDays: settings.cooldownDays,
      })
      const now = new Date()
      // Earliest time this list can be broadcast to: membership aging AND
      // the list-level minimum interval since its last campaign.
      const recentUseUntil = list.lastUsedAt
        ? new Date(list.lastUsedAt.getTime() + settings.listMinIntervalHours * 60 * 60 * 1000)
        : null
      const candidates = [list.usableAfter, recentUseUntil].filter(
        (d): d is Date => !!d && d > now
      )
      const usableAfter = candidates.length
        ? new Date(Math.max(...candidates.map((d) => d.getTime())))
        : null
      return {
        eligibleCount: eligibleContactIds.length,
        usable: !usableAfter && list.status !== "archived",
        usableAfter,
        recentlyUsed: !!recentUseUntil && recentUseUntil > now,
        ceiling: settings.recipientCeiling,
        overCeiling: eligibleContactIds.length > settings.recipientCeiling,
      }
    })
  )

/**
 * Evaluates a smart list's rule and materializes matching contacts into
 * contact_list_members as a one-time snapshot (never re-evaluated live) --
 * this is what makes the 24h-aging rule meaningful for smart lists too,
 * and keeps campaign eligibility a plain read instead of a live rule scan
 * over the full contacts table. Re-run manually to refresh membership.
 */
export const materializeSmartList = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; listId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_broadcasts")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const list = await requireList(db, data.workspaceId, data.listId, { writable: true })
      if (list.kind !== "smart" || !list.rule) {
        throw new UserFacingError("Not a smart list, or it has no rule configured")
      }
      const { field, op, value } = list.rule

      let matchedContactIds: string[] = []
      if (field === "tag" && op === "has_tag") {
        const rows = await db
          .select({ contactId: contacts.id })
          .from(contactTags)
          .innerJoin(tags, eq(tags.id, contactTags.tagId))
          .innerJoin(contacts, eq(contacts.id, contactTags.contactId))
          .where(and(eq(contacts.workspaceId, data.workspaceId), eq(tags.name, value)))
          .all()
        matchedContactIds = rows.map((r) => r.contactId)
      } else if (field === "lifecycleStage" && op === "equals") {
        const rows = await db
          .select({ contactId: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, data.workspaceId), eq(contacts.lifecycleStage, value as never)))
          .all()
        matchedContactIds = rows.map((r) => r.contactId)
      } else if (field === "organizationName" && op === "contains") {
        // customFields is a JSON blob -- LIKE against the raw JSON text is
        // an acceptable full scan here since this runs once, on-demand,
        // per materialize click, not on every eligibility check.
        const rows = await db
          .select({ contactId: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, data.workspaceId), like(contacts.customFields, `%${value}%`)))
          .all()
        matchedContactIds = rows.map((r) => r.contactId)
      } else if (field === "lastContactedAt" && (op === "before" || op === "after")) {
        const cutoff = new Date(value)
        const rows = await db
          .select({ contactId: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, data.workspaceId),
              op === "before" ? lte(contacts.lastContactedAt, cutoff) : gte(contacts.lastContactedAt, cutoff)
            )
          )
          .all()
        matchedContactIds = rows.map((r) => r.contactId)
      } else if (field === "whatsappGroup" && op === "member_of") {
        // Only participants already linked to a contact record -- a group
        // member we've never synced as a contact has nothing to target.
        // group_members_group_idx makes this a single indexed read.
        const rows = await db
          .selectDistinct({ contactId: groupMembers.contactId })
          .from(groupMembers)
          .innerJoin(contacts, eq(contacts.id, groupMembers.contactId))
          .where(and(eq(groupMembers.groupId, value), eq(groupMembers.workspaceId, data.workspaceId)))
          .all()
        matchedContactIds = rows.flatMap((r) => (r.contactId ? [r.contactId] : []))
      } else if (field === "customField" && list.rule.key && CUSTOM_FIELD_KEY_RE.test(list.rule.key)) {
        // JSON path is a bound parameter (key validated above), never
        // interpolated into the SQL text.
        const path = `$.${list.rule.key}`
        const extracted = sql<string>`lower(cast(json_extract(${contacts.customFields}, ${path}) as text))`
        const needle = value.toLowerCase()
        const rows = await db
          .select({ contactId: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, data.workspaceId),
              op === "equals" ? sql`${extracted} = ${needle}` : sql`${extracted} like ${`%${needle}%`}`
            )
          )
          .all()
        matchedContactIds = rows.map((r) => r.contactId)
      } else {
        throw new UserFacingError("Unsupported rule")
      }

      // Same sourcing gate as manual adds -- a rule can't be used to
      // sweep cold contacts into a list the workspace wouldn't allow by hand.
      const { allowed } = await filterAddableContacts(db, data.workspaceId, matchedContactIds)
      matchedContactIds = allowed
      await addContactsToListBulk(db, {
        workspaceId: data.workspaceId,
        listId: data.listId,
        contactIds: matchedContactIds,
        source: "rule",
      })
      await recomputeListUsableAfter(db, data.listId, 24)
      await db
        .update(contactLists)
        .set({ lastMaterializedAt: new Date() })
        .where(eq(contactLists.id, data.listId))

      return { ok: true, matched: matchedContactIds.length }
    }, "Couldn't refresh this smart list. Please try again.")
  )

// ── Suppression ──
/** "Do not contact" tab: newest-suppressed first, keyset-paged on the
 * contacts_suppressed_idx partial index, with server-side search. */
export const getSuppressedContacts = createServerFn()
  .validator(
    (data: { workspaceId: string; q?: string; cursor?: string | null; limit?: number }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const limit = cursorLimit(data.limit, 50)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)
      const q = (data.q ?? "").trim().slice(0, 100)
      // Same expression as the index (comma-free CASE -- see schema).
      const t = sql<number>`(CASE WHEN ${contacts.doNotBroadcastAt} IS NULL THEN 0 ELSE ${contacts.doNotBroadcastAt} END)`
      const rows = await db
        .select({
          id: contacts.id,
          name: contacts.name,
          phoneNumber: contacts.phoneNumber,
          doNotBroadcastReason: contacts.doNotBroadcastReason,
          doNotBroadcastAt: contacts.doNotBroadcastAt,
          sortT: t,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, data.workspaceId),
            eq(contacts.doNotBroadcast, true),
            q
              ? sql`(${contacts.name} LIKE ${likePattern(q)} ESCAPE '\\' OR ${contacts.phoneNumber} LIKE ${likePattern(q)} ESCAPE '\\')`
              : undefined,
            cursor ? sql`${t} <= ${cursor[0]} AND (${t} < ${cursor[0]} OR ${contacts.id} < ${cursor[1]})` : undefined
          )
        )
        .orderBy(desc(t), desc(contacts.id))
        .limit(limit + 1)
        .all()
      const page = toCursorPage(rows, limit, (r) => [Number(r.sortT), r.id])
      const totals = cursor
        ? null
        : q
          ? await cappedCount(
              db,
              db
                .select({ one: sql`1` })
                .from(contacts)
                .where(
                  and(
                    eq(contacts.workspaceId, data.workspaceId),
                    eq(contacts.doNotBroadcast, true),
                    sql`(${contacts.name} LIKE ${likePattern(q)} ESCAPE '\\' OR ${contacts.phoneNumber} LIKE ${likePattern(q)} ESCAPE '\\')`
                  )
                )
            )
          : await readCount(db, data.workspaceId, COUNTER.contactsSuppressed)
      return {
        ...page,
        total: totals?.total ?? null,
        totalCapped: totals?.totalCapped ?? false,
        items: page.items.map(({ sortT: _t, ...r }) => r),
      }
    })
  )

export const setContactSuppression = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; contactId: string; suppressed: boolean }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_contacts")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const contact = await db
        .select({ reason: contacts.doNotBroadcastReason })
        .from(contacts)
        .where(and(eq(contacts.id, data.contactId), eq(contacts.workspaceId, data.workspaceId)))
        .get()
      if (!contact) throw new UserFacingError("Contact not found")
      // Someone who replied STOP opted out themselves -- an admin must never
      // be able to silently re-subscribe them. Only they can opt back in.
      if (!data.suppressed && contact.reason === "opted_out") {
        throw new UserFacingError("This contact opted out themselves and can't be re-added to broadcasts.")
      }
      await db
        .update(contacts)
        .set(
          data.suppressed
            ? { doNotBroadcast: true, doNotBroadcastReason: "admin_suppressed", doNotBroadcastAt: new Date() }
            : { doNotBroadcast: false, doNotBroadcastReason: null, doNotBroadcastAt: null }
        )
        .where(and(eq(contacts.id, data.contactId), eq(contacts.workspaceId, data.workspaceId)))
      return { ok: true }
    }, "Couldn't update suppression. Please try again.")
  )

// ── Workspace anti-ban settings ──
export const getWorkspaceBroadcastSettings = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      return getBroadcastSettings(db, data.workspaceId)
    })
  )

export const updateWorkspaceBroadcastSettings = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      recipientCeiling: number
      cooldownDays: (typeof ALLOWED_COOLDOWN_DAYS)[number]
      listSourcingMode: "warn" | "conversation_only" | "unrestricted"
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_settings")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const ceiling = Math.max(1, Math.min(data.recipientCeiling, ANTI_BAN_HARD_MAX_CEILING))
      await db
        .insert(workspaceBroadcastSettings)
        .values({
          workspaceId: data.workspaceId,
          recipientCeiling: ceiling,
          cooldownDays: data.cooldownDays,
          listSourcingMode: data.listSourcingMode,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: workspaceBroadcastSettings.workspaceId,
          set: {
            recipientCeiling: ceiling,
            cooldownDays: data.cooldownDays,
            listSourcingMode: data.listSourcingMode,
            updatedAt: new Date(),
          },
        })
      return { ok: true, recipientCeiling: ceiling }
    }, "Couldn't update broadcast settings. Please try again.")
  )
