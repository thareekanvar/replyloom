import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import {
  createDb,
  eq,
  and,
  inArray,
  isNull,
  isNotNull,
  desc,
  sql,
  contacts,
  groups,
  groupMembers,
  tags,
  contactTags,
  notes,
  conversations,
  waSessions,
  member,
  teams,
} from "@workspace/db"
import { normalizePhoneNumber } from "@workspace/db/phone"
import { withSafeErrors } from "@/lib/errors"
import { toEpochSeconds } from "@/lib/dates"
import { requireCurrentWorkspaceId, requirePermission, requireCurrentPermission } from "@/lib/auth"
import { cursorLimit, decodeCursor, toCursorPage } from "@/lib/cursor"
import { COUNTER, cappedCount, readCount } from "@/lib/counts"

async function requireOwnedContact(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  contactId: string
) {
  const row = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
    .get()
  if (!row) throw new Error("Contact not found.")
}

function getDb() {
  return createDb(env.DB)
}

const CONTACTS_PINNED_MAX = 100

const contactRowSelect = {
  id: contacts.id,
  name: contacts.name,
  phoneNumber: contacts.phoneNumber,
  jid: contacts.jid,
  lifecycleStage: contacts.lifecycleStage,
  assignedTo: contacts.assignedTo,
  lastContactedAt: contacts.lastContactedAt,
  createdAt: contacts.createdAt,
  avatarUrl: contacts.avatarUrl,
  about: contacts.about,
  pinnedAt: contacts.pinnedAt,
  blocked: contacts.blocked,
  // "View conversation" jumps straight to /inbox?conversationId=...
  conversationId: conversations.id,
  waSessionId: contacts.waSessionId,
  sessionLabel: waSessions.label,
  sortT: sql<number>`${contacts.createdAt}`,
}

/** LIKE pattern with %/_ escaped (use with ESCAPE '\\'). */
function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * Contacts screen feed: keyset pagination + server-side search.
 * Page 1 = pinned contacts (small segment, contacts_pinned_idx) + the first
 * page of the rest; later pages continue from the cursor [created_at, id]
 * on contacts_unpinned_idx -- an index range seek at any depth.
 */
export const getContactsPage = createServerFn()
  .validator(
    (data: {
      workspaceId: string
      q?: string
      cursor?: string | null
      limit?: number
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const limit = cursorLimit(data.limit)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)
      const q = (data.q ?? "").trim().slice(0, 100)
      const search = q
        ? sql`(${contacts.name} LIKE ${likePattern(q)} ESCAPE '\\' OR ${contacts.phoneNumber} LIKE ${likePattern(q)} ESCAPE '\\' OR ${contacts.jid} LIKE ${likePattern(q)} ESCAPE '\\')`
        : undefined
      const base = () =>
        db
          .select(contactRowSelect)
          .from(contacts)
          .leftJoin(conversations, eq(conversations.contactId, contacts.id))
          .leftJoin(waSessions, eq(waSessions.id, contacts.waSessionId))

      const pinned = cursor
        ? []
        : await base()
            .where(
              and(
                eq(contacts.workspaceId, data.workspaceId),
                isNotNull(contacts.pinnedAt),
                search
              )
            )
            .orderBy(desc(contacts.pinnedAt), desc(contacts.id))
            .limit(CONTACTS_PINNED_MAX)
            .all()

      const rows = await base()
        .where(
          and(
            eq(contacts.workspaceId, data.workspaceId),
            isNull(contacts.pinnedAt),
            search,
            cursor
              ? sql`(${contacts.createdAt}, ${contacts.id}) < (${cursor[0]}, ${cursor[1]})`
              : undefined
          )
        )
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(limit + 1)
        .all()

      const page = toCursorPage(rows, limit, (r) => [Number(r.sortT), r.id])
      // Exact total on the first page only (the client keeps it): O(1) from
      // the trigger-maintained counter, or a capped count when searching.
      const totals = cursor
        ? null
        : search
          ? await cappedCount(
              db,
              db.select({ one: sql`1` }).from(contacts).where(and(eq(contacts.workspaceId, data.workspaceId), search))
            )
          : await readCount(db, data.workspaceId, COUNTER.contacts)
      return {
        total: totals?.total ?? null,
        totalCapped: totals?.totalCapped ?? false,
        items: [...pinned, ...page.items].map(({ sortT: _s, ...r }) => ({
          ...r,
          lastContactedAt: toEpochSeconds(r.lastContactedAt),
          createdAt: toEpochSeconds(r.createdAt)!,
          pinnedAt: toEpochSeconds(r.pinnedAt),
        })),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      }
    })
  )

export const getContactTags = createServerFn()
  .validator((data: { contactId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const workspaceId = await requireCurrentWorkspaceId()
      const db = getDb()

      const rows = await db
        .select({
          tagId: tags.id,
          tagName: tags.name,
          tagColor: tags.color,
        })
        .from(contactTags)
        .innerJoin(tags, eq(contactTags.tagId, tags.id))
        .where(
          and(
            eq(contactTags.contactId, data.contactId),
            eq(tags.workspaceId, workspaceId)
          )
        )
        .all()

      return rows
    })
  )

/** A contact's notes, newest first, keyset-paged on notes_contact_idx
 * (contact_id, created_at DESC, id DESC). */
export const getContactNotes = createServerFn()
  .validator(
    (data: { contactId: string; cursor?: string | null; limit?: number }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      const workspaceId = await requireCurrentWorkspaceId()
      const db = getDb()
      const limit = cursorLimit(data.limit, 20)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)
      const rows = await db
        .select({ note: notes, sortT: sql<number>`${notes.createdAt}` })
        .from(notes)
        .where(
          and(
            eq(notes.contactId, data.contactId),
            eq(notes.workspaceId, workspaceId),
            cursor ? sql`(${notes.createdAt}, ${notes.id}) < (${cursor[0]}, ${cursor[1]})` : undefined
          )
        )
        .orderBy(desc(notes.createdAt), desc(notes.id))
        .limit(limit + 1)
        .all()
      const page = toCursorPage(rows, limit, (r) => [Number(r.sortT), r.note.id])
      const totals = cursor ? null : await readCount(db, data.contactId, COUNTER.notes)
      return {
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        total: totals?.total ?? null,
        totalCapped: false,
        items: page.items.map((r) => r.note),
      }
    })
  )
export const addNote = createServerFn({ method: "POST" })
  .validator(
    (data: {
      contactId: string
      workspaceId: string
      body: string
      authorId?: string
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "send_messages")
      const db = getDb()
      await requireOwnedContact(db, data.workspaceId, data.contactId)

      const note = await db
        .insert(notes)
        .values({
          contactId: data.contactId,
          workspaceId: data.workspaceId,
          authorId: data.authorId ?? null,
          body: data.body,
        })
        .returning()
        .get()

      return note
    }, "Couldn't save the note. Please try again.")
  )

export const updateContact = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      contactId: string
      name?: string
      lifecycleStage?: string
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_contacts")
      const db = getDb()
      const { workspaceId, contactId, ...updates } = data

      const fields: Record<string, unknown> = {}
      if (updates.name !== undefined) fields.name = updates.name
      if (updates.lifecycleStage !== undefined)
        fields.lifecycleStage = updates.lifecycleStage
      if (Object.keys(fields).length === 0) return null

      await db
        .update(contacts)
        .set(fields)
        .where(
          and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId))
        )

      return { ok: true }
    }, "Couldn't update the contact. Please try again.")
  )

export const assignContact = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      contactId: string
      assignedTo: string | null
      assignedTeamId?: string | null
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "assign_conversations")
      const db = getDb()
      const ownedContact = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, data.contactId),
            eq(contacts.workspaceId, data.workspaceId)
          )
        )
        .get()
      if (!ownedContact) throw new Error("Contact not found.")
      if (data.assignedTo && data.assignedTeamId)
        throw new Error("Choose either a user or a team, not both.")
      if (data.assignedTo) {
        const assignee = await db
          .select({ userId: member.userId })
          .from(member)
          .where(
            and(
              eq(member.organizationId, data.workspaceId),
              eq(member.userId, data.assignedTo)
            )
          )
          .get()
        if (!assignee)
          throw new Error("That user is not a member of this workspace.")
      }
      if (data.assignedTeamId) {
        const team = await db
          .select({ id: teams.id })
          .from(teams)
          .where(
            and(
              eq(teams.id, data.assignedTeamId),
              eq(teams.workspaceId, data.workspaceId)
            )
          )
          .get()
        if (!team)
          throw new Error("That team does not belong to this workspace.")
      }
      await db
        .update(contacts)
        .set({
          assignedTo: data.assignedTo,
          assignedTeamId: data.assignedTeamId ?? null,
        })
        .where(
          and(
            eq(contacts.id, data.contactId),
            eq(contacts.workspaceId, data.workspaceId)
          )
        )
      return {
        ok: true,
        assignedTo: data.assignedTo,
        assignedTeamId: data.assignedTeamId ?? null,
      }
    }, "Couldn't assign the contact. Please try again.")
  )

export const updateContactProfile = createServerFn({ method: "POST" })
  .validator(
    (data: {
      contactId: string
      avatarUrl?: string | null
      about?: string | null
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      const workspaceId = await requireCurrentPermission("manage_contacts")
      const db = getDb()

      const fields: Record<string, unknown> = { avatarFetchedAt: new Date() }
      if (data.avatarUrl !== undefined) fields.avatarUrl = data.avatarUrl
      if (data.about !== undefined) fields.about = data.about

      await db
        .update(contacts)
        .set(fields)
        .where(
          and(eq(contacts.id, data.contactId), eq(contacts.workspaceId, workspaceId))
        )

      return { ok: true }
    }, "Couldn't save the contact's profile. Please try again.")
  )

export const setContactPinned = createServerFn({ method: "POST" })
  .validator((data: { contactId: string; pinned: boolean }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const workspaceId = await requireCurrentPermission("send_messages")
      const db = getDb()

      await db
        .update(contacts)
        .set({ pinnedAt: data.pinned ? new Date() : null })
        .where(
          and(eq(contacts.id, data.contactId), eq(contacts.workspaceId, workspaceId))
        )

      return { ok: true, pinned: data.pinned }
    }, "Couldn't update pin. Please try again.")
  )

export const setContactBlocked = createServerFn({ method: "POST" })
  .validator((data: { contactId: string; blocked: boolean }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const workspaceId = await requireCurrentPermission("manage_contacts")
      const db = getDb()

      await db
        .update(contacts)
        .set({ blocked: data.blocked })
        .where(
          and(eq(contacts.id, data.contactId), eq(contacts.workspaceId, workspaceId))
        )

      return { ok: true, blocked: data.blocked }
    }, "Couldn't update block status. Please try again.")
  )

export const deleteContact = createServerFn({ method: "POST" })
  .validator((data: { contactId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const workspaceId = await requireCurrentPermission("manage_contacts")
      const db = getDb()

      // Contacts cascade-delete their conversations, messages, notes and
      // tag links (see FK onDelete: "cascade" in packages/db/src/schema).
      await db.delete(contacts).where(
          and(eq(contacts.id, data.contactId), eq(contacts.workspaceId, workspaceId))
        )

      return { ok: true }
    }, "Couldn't delete the contact. Please try again.")
  )

export const bulkDeleteContacts = createServerFn({ method: "POST" })
  .validator((data: { contactIds: string[] }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      if (data.contactIds.length === 0) return { ok: true, count: 0 }
      const workspaceId = await requireCurrentPermission("manage_contacts")
      const db = getDb()
      // Chunked: D1 caps bound parameters at 100 per statement.
      let deletedCount = 0
      for (let i = 0; i < data.contactIds.length; i += 90) {
        const deleted = await db
          .delete(contacts)
          .where(
            and(
              eq(contacts.workspaceId, workspaceId),
              inArray(contacts.id, data.contactIds.slice(i, i + 90))
            )
          )
          .returning({ id: contacts.id })
          .all()
        deletedCount += deleted.length
      }
      return { ok: true, count: deletedCount }
    }, "Couldn't delete the selected contacts. Please try again.")
  )

export const createContact = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      waSessionId: string
      name?: string
      phoneNumber: string
      defaultCountryCode?: string
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_contacts")
      const db = getDb()

      const normalized = normalizePhoneNumber(
        data.phoneNumber,
        data.defaultCountryCode
      )
      if (!normalized.ok)
        throw new Error(
          `That doesn't look like a valid phone number (${normalized.reason.toLowerCase()}).`
        )

      // Phone number is this app's durable contact identity (see
      // apps/worker/src/db/sync.ts's findOrCreateContact) — dedupe the same
      // way here rather than relying on the (session, jid) unique index.
      const existing = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.waSessionId, data.waSessionId),
            eq(contacts.phoneNumber, normalized.digits)
          )
        )
        .get()
      if (existing)
        throw new Error(
          "A contact with this phone number already exists for this integration."
        )

      const contact = await db
        .insert(contacts)
        .values({
          workspaceId: data.workspaceId,
          waSessionId: data.waSessionId,
          jid: normalized.jid,
          phoneNumber: normalized.digits,
          name: data.name?.trim() || null,
        })
        .returning({
          id: contacts.id,
          name: contacts.name,
          phoneNumber: contacts.phoneNumber,
          jid: contacts.jid,
        })
        .get()

      return contact
    }, "Couldn't create the contact. Please try again.")
  )

/** Bounded picker search (20 rows). Walks the same pinned/unpinned indexes
 * as getContactsPage newest-first and stops at 20 matches, instead of
 * collecting + sorting every match in the workspace per keystroke. */
export const searchContacts = createServerFn()
  .validator(
    (data: {
      workspaceId: string
      query: string
      waSessionId?: string
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()
      const q = data.query.trim().slice(0, 100)
      const conds = [
        eq(contacts.workspaceId, data.workspaceId),
        q
          ? sql`(${contacts.name} LIKE ${likePattern(q)} ESCAPE '\\' OR ${contacts.phoneNumber} LIKE ${likePattern(q)} ESCAPE '\\')`
          : undefined,
        data.waSessionId ? eq(contacts.waSessionId, data.waSessionId) : undefined,
      ]
      const base = () =>
        db
          .select({
            id: contacts.id,
            name: contacts.name,
            phoneNumber: contacts.phoneNumber,
            jid: contacts.jid,
            avatarUrl: contacts.avatarUrl,
            waSessionId: contacts.waSessionId,
            conversationId: conversations.id,
            sessionLabel: waSessions.label,
          })
          .from(contacts)
          .leftJoin(conversations, eq(conversations.contactId, contacts.id))
          .leftJoin(waSessions, eq(waSessions.id, contacts.waSessionId))
      const pinned = await base()
        .where(and(...conds, isNotNull(contacts.pinnedAt)))
        .orderBy(desc(contacts.pinnedAt), desc(contacts.id))
        .limit(20)
        .all()
      if (pinned.length >= 20) return pinned
      const rest = await base()
        .where(and(...conds, isNull(contacts.pinnedAt)))
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(20 - pinned.length)
        .all()
      return [...pinned, ...rest]
    })
  )

export interface BulkImportRow {
  name?: string
  phoneNumber: string
}

export interface BulkImportRowResult {
  phoneNumber: string
  name?: string
  status: "created" | "updated" | "skipped" | "invalid"
  reason?: string
}

/** Hard cap per call -- the dialog chunks bigger files (see bulk-import-dialog). */
export const MAX_IMPORT_ROWS_PER_CALL = 1000
const IMPORT_SQL_CHUNK = 250

export const bulkImportContacts = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      waSessionId: string
      defaultCountryCode?: string
      rows: BulkImportRow[]
    }) => {
      if (!Array.isArray(data.rows)) throw new Error("rows must be an array")
      if (data.rows.length > MAX_IMPORT_ROWS_PER_CALL) {
        throw new Error(`Import at most ${MAX_IMPORT_ROWS_PER_CALL} rows per request.`)
      }
      return data
    }
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_contacts")
      const db = getDb()

      // The session must belong to the caller's workspace -- otherwise a
      // client could plant contacts under another tenant's number.
      const session = await db
        .select({ id: waSessions.id })
        .from(waSessions)
        .where(and(eq(waSessions.id, data.waSessionId), eq(waSessions.workspaceId, data.workspaceId)))
        .get()
      if (!session) throw new Error("WhatsApp number not found.")

      const results: BulkImportRowResult[] = []
      let invalid = 0
      // Normalize + dedupe within the chunk (last non-empty name wins).
      const byDigits = new Map<string, { jid: string; e164: string; name?: string }>()
      for (const row of data.rows) {
        const name = row.name?.trim().slice(0, 200) || undefined
        const normalized = normalizePhoneNumber(String(row.phoneNumber).slice(0, 40), data.defaultCountryCode)
        if (!normalized.ok) {
          invalid++
          results.push({ phoneNumber: row.phoneNumber, name, status: "invalid", reason: normalized.reason })
          continue
        }
        const prev = byDigits.get(normalized.digits)
        byDigits.set(normalized.digits, { jid: normalized.jid, e164: normalized.e164, name: name ?? prev?.name })
      }

      // One indexed lookup (contacts_session_phone_idx) for the whole chunk
      // instead of loading every contact of the session into memory.
      const digits = [...byDigits.keys()]
      const existing = digits.length
        ? await db
            .select({ id: contacts.id, phoneNumber: contacts.phoneNumber })
            .from(contacts)
            .where(
              and(
                eq(contacts.waSessionId, data.waSessionId),
                sql`${contacts.phoneNumber} IN (SELECT value FROM json_each(${JSON.stringify(digits)}))`
              )
            )
            .all()
        : []
      const existingByPhone = new Map(existing.map((c) => [c.phoneNumber ?? "", c.id]))

      const toInsert: { id: string; jid: string; phone: string; name: string | null }[] = []
      const toRename: { id: string; name: string }[] = []
      let updated = 0
      let skipped = 0
      for (const [phone, row] of byDigits) {
        const existingId = existingByPhone.get(phone)
        if (existingId) {
          if (row.name) {
            toRename.push({ id: existingId, name: row.name })
            updated++
            results.push({ phoneNumber: row.e164, name: row.name, status: "updated" })
          } else {
            skipped++
            results.push({ phoneNumber: row.e164, name: row.name, status: "skipped", reason: "Already a contact" })
          }
          continue
        }
        toInsert.push({ id: crypto.randomUUID(), jid: row.jid, phone, name: row.name ?? null })
      }

      // Set-based writes: one statement per 250 rows, all in one batch
      // (was one D1 round trip per row). entity_counts triggers keep totals.
      const statements: unknown[] = []
      for (let i = 0; i < toInsert.length; i += IMPORT_SQL_CHUNK) {
        const chunk = JSON.stringify(toInsert.slice(i, i + IMPORT_SQL_CHUNK))
        statements.push(
          db.run(sql`
            INSERT INTO contacts (id, workspace_id, wa_session_id, jid, phone_number, name)
            SELECT json_extract(value, '$.id'), ${data.workspaceId}, ${data.waSessionId},
                   json_extract(value, '$.jid'), json_extract(value, '$.phone'), json_extract(value, '$.name')
            FROM json_each(${chunk})
            WHERE true
            ON CONFLICT (wa_session_id, jid) DO NOTHING
          `)
        )
      }
      for (let i = 0; i < toRename.length; i += IMPORT_SQL_CHUNK) {
        const chunk = JSON.stringify(toRename.slice(i, i + IMPORT_SQL_CHUNK))
        statements.push(
          db.run(sql`
            UPDATE contacts
            SET name = (SELECT json_extract(j.value, '$.name') FROM json_each(${chunk}) j WHERE json_extract(j.value, '$.id') = contacts.id),
                updated_at = unixepoch()
            WHERE workspace_id = ${data.workspaceId}
              AND id IN (SELECT json_extract(value, '$.id') FROM json_each(${chunk}))
          `)
        )
      }
      if (statements.length) await db.batch(statements as [any, ...any[]])

      // Which pre-generated ids actually landed (vs. ON CONFLICT skips).
      const insertedIds = new Set<string>()
      if (toInsert.length) {
        const landed = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(sql`${contacts.id} IN (SELECT value FROM json_each(${JSON.stringify(toInsert.map((r) => r.id))}))`)
          .all()
        for (const r of landed) insertedIds.add(r.id)
      }

      let created = 0
      for (const row of toInsert) {
        const e164 = byDigits.get(row.phone)?.e164 ?? row.phone
        if (insertedIds.has(row.id)) {
          created++
          results.push({ phoneNumber: e164, name: row.name ?? undefined, status: "created" })
        } else {
          skipped++ // lost a race with live sync (same jid inserted meanwhile)
          results.push({ phoneNumber: e164, name: row.name ?? undefined, status: "skipped", reason: "Already a contact" })
        }
      }

      return { total: data.rows.length, created, updated, skipped, invalid, results }
    }, "Couldn't import contacts. Please try again.")
  )

// A group participant JID never carries a device suffix ("12345:6@s...");
// the CRM's *own* connected number, sourced from Baileys' sock.user.id,
// always does. Strip it before comparing the two so "is our own number an
// admin of this group" doesn't silently always miss.
function bareJid(jid: string | null | undefined): string {
  if (!jid) return ""
  return jid.replace(/:\d+(?=@)/, "")
}

export const getGroupMembers = createServerFn()
  .validator((data: { workspaceId: string; groupJid: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = getDb()

      // Find the group by JID for this workspace
      const group = await db
        .select({
          id: groups.id,
          name: groups.name,
          participantCount: groups.participantCount,
          waSessionId: groups.waSessionId,
        })
        .from(groups)
        .where(and(eq(groups.workspaceId, data.workspaceId), eq(groups.jid, data.groupJid)))
        .get()
      if (!group) return { members: [], groupName: null, selfRole: "member" as const }

      const rows = await db
        .select({
          id: groupMembers.id,
          jid: groupMembers.jid,
          role: groupMembers.role,
          contactId: groupMembers.contactId,
          contactName: contacts.name,
          contactPhone: contacts.phoneNumber,
          contactAvatar: contacts.avatarUrl,
        })
        .from(groupMembers)
        .leftJoin(contacts, eq(groupMembers.contactId, contacts.id))
        .where(eq(groupMembers.groupId, group.id))
        .orderBy(
          sql`CASE WHEN ${groupMembers.role} = 'superadmin' THEN 0 WHEN ${groupMembers.role} = 'admin' THEN 1 ELSE 2 END`,
        )
        .all()

      // Whether *our own* connected WhatsApp number is an admin/owner of
      // this group -- promote/demote/remove all require that on WhatsApp's
      // side regardless of what the CRM lets you click, so the UI needs to
      // know it to avoid offering actions that'll just fail against WA.
      const session = await db
        .select({ connectedJid: waSessions.connectedJid })
        .from(waSessions)
        .where(eq(waSessions.id, group.waSessionId))
        .get()
      const selfBare = bareJid(session?.connectedJid)
      const selfMember = selfBare ? rows.find((r) => bareJid(r.jid) === selfBare) : undefined
      const selfRole = selfMember?.role ?? "member"

      return {
        groupName: group.name,
        participantCount: group.participantCount,
        selfRole,
        members: rows.map((r) => ({
          id: r.id,
          jid: r.jid,
          role: r.role,
          contactId: r.contactId,
          name: r.contactName ?? r.jid.split("@")[0],
          phone: r.contactPhone,
          avatar: r.contactAvatar,
        })),
      }
    }),
  )
