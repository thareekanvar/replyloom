import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import {
  createDb,
  eq,
  and,
  gt,
  desc,
  ne,
  isNull,
  isNotNull,
  sql,
  conversations,
  contacts,
  groups,
  messages,
  waSessions,
  member,
  user,
  teams,
} from "@workspace/db"
import { withSafeErrors } from "@/lib/errors"
import { assertOneOf } from "@/lib/validate"
import { toEpochSeconds } from "@/lib/dates"
import { requirePermission, requireWorkspaceAccess } from "@/lib/auth"
import { readEngineJson } from "@/lib/wa-engine"
import { cursorLimit, decodeCursor, toCursorPage } from "@/lib/cursor"
import { COUNTER, countOf, readCounts } from "@/lib/counts"

function getDb() {
  return createDb(env.DB)
}

export type InboxFilter = "all" | "direct" | "groups" | "unread" | "pinned" | "archived"

// Epoch-seconds sort key for unpinned rows, identical (modulo column
// qualification, which SQLite resolves) to the conversations_*_idx index
// expression -- that's what makes the cursor predicate an index range seek.
const convSortT = sql<number>`(CASE WHEN ${conversations.lastMessageAt} IS NULL THEN 0 ELSE ${conversations.lastMessageAt} END)`
const PINNED_SEGMENT_MAX = 100

const conversationRowSelect = {
  id: conversations.id,
  kind: conversations.kind,
  status: conversations.status,
  assignedTo: conversations.assignedTo,
  assignedTeamId: conversations.assignedTeamId,
  unreadCount: conversations.unreadCount,
  lastMessageAt: conversations.lastMessageAt,
  lastBody: conversations.lastBody,
  lastType: conversations.lastType,
  lastDirection: conversations.lastDirection,
  pinnedAt: conversations.pinnedAt,
  archived: conversations.archived,
  muted: conversations.muted,
  waSessionId: conversations.waSessionId,
  contactId: contacts.id,
  contactName: contacts.name,
  contactAvatar: contacts.avatarUrl,
  contactJid: contacts.jid,
  contactPhone: contacts.phoneNumber,
  contactLifecycleStage: contacts.lifecycleStage,
  contactAssignedTo: contacts.assignedTo,
  contactAssignedTeamId: contacts.assignedTeamId,
  contactPinnedAt: contacts.pinnedAt,
  contactAbout: contacts.about,
  contactAvatarFetchedAt: contacts.avatarFetchedAt,
  contactBlocked: contacts.blocked,
  sessionLabel: waSessions.label,
  assigneeName: user.name,
  assigneeEmail: user.email,
  groupName: groups.name,
  groupJid: groups.jid,
  sortT: convSortT,
}

function inboxFilterWhere(filter: InboxFilter, q: string) {
  const conds = [eq(conversations.archived, filter === "archived")]
  if (filter === "unread") conds.push(gt(conversations.unreadCount, 0))
  if (filter === "groups") conds.push(eq(conversations.kind, "group"))
  if (filter === "direct") conds.push(eq(conversations.kind, "direct"))
  if (q) {
    // Residual filter along the index walk; stops as soon as a page of
    // matches is found. (Full-text search is the next step for huge inboxes.)
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    conds.push(
      sql`(${contacts.name} LIKE ${like} ESCAPE '\\' OR ${contacts.phoneNumber} LIKE ${like} ESCAPE '\\' OR ${contacts.jid} LIKE ${like} ESCAPE '\\' OR ${groups.name} LIKE ${like} ESCAPE '\\' OR ${conversations.lastBody} LIKE ${like} ESCAPE '\\')`
    )
  }
  return conds
}

function normalizeConversationRow<T extends Record<string, any>>(conv: T) {
  const { sortT: _sortT, ...rest } = conv
  return {
    ...rest,
    lastMessageAt: toEpochSeconds(conv.lastMessageAt),
    pinnedAt: toEpochSeconds(conv.pinnedAt),
    contactPinnedAt: toEpochSeconds(conv.contactPinnedAt),
    contactAvatarFetchedAt: toEpochSeconds(conv.contactAvatarFetchedAt),
    lastBody: conv.lastBody ?? null,
    lastType: conv.lastType ?? null,
    lastDirection: conv.lastDirection ?? null,
  }
}

/**
 * Inbox list with server-side tab filters + search and keyset pagination.
 * Page 1 = the (small) pinned segment + the first page of unpinned chats;
 * later pages continue the unpinned walk from the cursor
 * [last_message_at-or-0, id]. Every query is an index range seek on one of
 * the conversations_*_idx partial indexes, so page 500 costs the same as
 * page 1 and a chat arriving mid-scroll can't shift/skip rows.
 */
export const getConversationsPage = createServerFn()
  .validator(
    (data: {
      workspaceId: string
      filter?: InboxFilter
      q?: string
      cursor?: string | null
      limit?: number
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const filter: InboxFilter = data.filter ?? "all"
      const q = (data.q ?? "").trim().slice(0, 100)
      const limit = cursorLimit(data.limit)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)
      const conds = inboxFilterWhere(filter, q)

      const base = () =>
        db
          .select(conversationRowSelect)
          .from(conversations)
          .leftJoin(contacts, eq(conversations.contactId, contacts.id))
          .leftJoin(groups, eq(conversations.groupId, groups.id))
          .leftJoin(waSessions, eq(waSessions.id, conversations.waSessionId))
          .leftJoin(user, eq(user.id, conversations.assignedTo))

      const pinned = cursor
        ? []
        : await base()
            .where(
              and(
                eq(conversations.workspaceId, data.workspaceId),
                isNotNull(conversations.pinnedAt),
                ...conds
              )
            )
            .orderBy(desc(conversations.pinnedAt), desc(conversations.id))
            .limit(PINNED_SEGMENT_MAX)
            .all()

      if (filter === "pinned") {
        return { items: pinned.map(normalizeConversationRow), hasMore: false, nextCursor: null }
      }

      const unpinned = await base()
        .where(
          and(
            eq(conversations.workspaceId, data.workspaceId),
            isNull(conversations.pinnedAt),
            ...conds,
            cursor
              ? sql`${convSortT} <= ${cursor[0]} AND (${convSortT} < ${cursor[0]} OR ${conversations.id} < ${cursor[1]})`
              : undefined
          )
        )
        .orderBy(desc(convSortT), desc(conversations.id))
        .limit(limit + 1)
        .all()

      const page = toCursorPage(unpinned, limit, (r) => [Number(r.sortT), r.id])
      return {
        items: [...pinned, ...page.items].map(normalizeConversationRow),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      }
    })
  )

/** Exact tab badges, O(1): six trigger-maintained counters in one query. */
export const getConversationCounts = createServerFn()
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const ws = data.workspaceId
      const c = await readCounts(db, [ws], [
        COUNTER.convActive,
        COUNTER.convDirect,
        COUNTER.convGroups,
        COUNTER.convUnread,
        COUNTER.convPinned,
        COUNTER.convArchived,
      ])
      return {
        all: countOf(c, ws, COUNTER.convActive),
        direct: countOf(c, ws, COUNTER.convDirect),
        groups: countOf(c, ws, COUNTER.convGroups),
        unread: countOf(c, ws, COUNTER.convUnread),
        pinned: countOf(c, ws, COUNTER.convPinned),
        archived: countOf(c, ws, COUNTER.convArchived),
      }
    })
  )

/** Thread messages, newest page first, keyset on (created_at, id) -- the id
 * tie-breaker matters: created_at is whole seconds, so a plain timestamp
 * cursor skipped every message that shared a second with a page boundary. */
export const getMessagesPage = createServerFn()
  .validator(
    (data: {
      conversationId: string
      workspaceId: string
      cursor?: string | null
      pageSize?: number
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()
      const owned = await db
        .select({ id: conversations.id, waSessionId: conversations.waSessionId })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, data.conversationId),
            eq(conversations.workspaceId, data.workspaceId)
          )
        )
        .get()
      if (!owned) throw new Error("Unauthorized")

      const limit = cursorLimit(data.pageSize)
      const cursor = decodeCursor(data.cursor, ["n", "s"] as const)
      const rows = await db
        .select({
          id: messages.id,
          waMessageId: messages.waMessageId,
          conversationId: messages.conversationId,
          direction: messages.direction,
          senderJid: messages.senderJid,
          type: messages.type,
          body: messages.body,
          mediaKey: messages.mediaKey,
          mediaMime: messages.mediaMime,
          mediaMeta: messages.mediaMeta,
          status: messages.status,
          reactions: messages.reactions,
          editedAt: messages.editedAt,
          deleted: messages.deleted,
          createdAt: messages.createdAt,
          senderName: contacts.name,
          sortT: sql<number>`${messages.createdAt}`,
        })
        .from(messages)
        // contacts is only unique per (wa_session_id, jid): pin the join to
        // this conversation's session or messages duplicate per session.
        .leftJoin(
          contacts,
          and(eq(messages.senderJid, contacts.jid), eq(contacts.waSessionId, owned.waSessionId))
        )
        .where(
          and(
            eq(messages.conversationId, data.conversationId),
            cursor ? sql`(${messages.createdAt}, ${messages.id}) < (${cursor[0]}, ${cursor[1]})` : undefined
          )
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1)
        .all()

      const page = toCursorPage(rows, limit, (r) => [Number(r.sortT), r.id])
      return {
        items: page.items
          .slice()
          .reverse() // oldest first within the page for the thread view
          .map(({ sortT: _s, ...row }) => ({
            ...row,
            createdAt: toEpochSeconds(row.createdAt)!,
            editedAt: row.editedAt ? toEpochSeconds(row.editedAt) : null,
          })),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      }
    })
  )

export const setConversationPinned = createServerFn({ method: "POST" })
  .validator(
    (data: { conversationId: string; workspaceId: string; pinned: boolean }) =>
      data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "send_messages")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()

      await db
        .update(conversations)
        .set({ pinnedAt: data.pinned ? new Date() : null })
        .where(
          and(
            eq(conversations.id, data.conversationId),
            eq(conversations.workspaceId, data.workspaceId)
          )
        )

      return { ok: true, pinned: data.pinned }
    }, "Couldn't update pin. Please try again.")
  )

export const setConversationStatus = createServerFn({ method: "POST" })
  .validator(
    (data: {
      conversationId: string
      workspaceId: string
      status: "open" | "pending" | "resolved"
    }) => {
      // The TS union is erased on the wire -- reject anything SQLite would
      // otherwise happily store in the enum column.
      assertOneOf(data.status, ["open", "pending", "resolved"] as const, "status")
      return data
    }
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "send_messages")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()

      await db
        .update(conversations)
        .set({ status: data.status })
        .where(
          and(
            eq(conversations.id, data.conversationId),
            eq(conversations.workspaceId, data.workspaceId)
          )
        )

      return { ok: true }
    }, "Couldn't update the conversation. Please try again.")
  )

export const assignConversation = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      conversationId: string
      assignedTo: string | null
      assignedTeamId?: string | null
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "assign_conversations")
      const db = getDb()
      const ownedConversation = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, data.conversationId),
            eq(conversations.workspaceId, data.workspaceId)
          )
        )
        .get()
      if (!ownedConversation) throw new Error("Conversation not found.")
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
        .update(conversations)
        .set({
          assignedTo: data.assignedTo,
          assignedTeamId: data.assignedTeamId ?? null,
        })
        .where(eq(conversations.id, data.conversationId))
      return {
        ok: true,
        assignedTo: data.assignedTo,
        assignedTeamId: data.assignedTeamId ?? null,
      }
    }, "Couldn't assign the conversation. Please try again.")
  )

export const markConversationRead = createServerFn({ method: "POST" })
  .validator((data: { conversationId: string; workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "view_inbox")
      await requireWorkspaceAccess(data.workspaceId)
      const db = getDb()

      const target = await db
        .select({
          waSessionId: conversations.waSessionId,
          kind: conversations.kind,
          contactJid: contacts.jid,
          groupJid: groups.jid,
        })
        .from(conversations)
        .leftJoin(contacts, eq(conversations.contactId, contacts.id))
        .leftJoin(groups, eq(conversations.groupId, groups.id))
        .where(
          and(
            eq(conversations.id, data.conversationId),
            eq(conversations.workspaceId, data.workspaceId)
          )
        )
        .get()
      if (!target) throw new Error("Conversation not found.")

      // Only messages we haven't already marked read -- this used to send a
      // receipt for the conversation's ENTIRE inbound history on every open
      // (and never recorded that it had). Capped to the newest 100: WhatsApp
      // treats a read of the latest messages as reading the chat anyway.
      const unreadInbound = and(
        eq(messages.conversationId, data.conversationId),
        eq(messages.direction, "in"),
        ne(messages.status, "read")
      )
      const inbound = await db
        .select({
          waMessageId: messages.waMessageId,
          senderJid: messages.senderJid,
        })
        .from(messages)
        .where(unreadInbound)
        .orderBy(desc(messages.createdAt))
        .limit(100)
        .all()
      const remoteJid =
        target.kind === "group" ? target.groupJid : target.contactJid
      const keys = inbound
        .filter((message) => !!message.waMessageId && !!remoteJid)
        .map((message) => ({
          remoteJid: remoteJid!,
          id: message.waMessageId!,
          fromMe: false,
          ...(target.kind === "group" && message.senderJid
            ? { participant: message.senderJid }
            : {}),
        }))
      if (keys.length > 0) {
        await readEngineJson(
          `/session/${target.waSessionId}/read`,
          data.workspaceId,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keys }),
          }
        )
          .then(() =>
            db.update(messages).set({ status: "read" }).where(unreadInbound)
          )
          .catch(() => undefined)
      }

      await db
        .update(conversations)
        .set({ unreadCount: 0 })
        .where(
          and(
            eq(conversations.id, data.conversationId),
            eq(conversations.workspaceId, data.workspaceId)
          )
        )

      return { ok: true }
    }, "Couldn't mark as read. Please try again.")
  )
