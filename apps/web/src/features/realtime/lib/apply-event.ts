import type { QueryClient } from "@tanstack/react-query"
import {
  conversationCountsKey,
  patchConversationCaches,
} from "@/features/inbox/lib/conversation-cache"
import type {
  CampaignProgressEvent,
  ConversationPatch,
  MessageStatusEvent,
  NewMessageEvent,
  RealtimeEvent,
} from "./types"

// Cache patching for realtime events -- applies app-wide, whatever page is
// open, so every screen reading these React Query keys stays live.

function patchConversation(conv: any, patch: ConversationPatch) {
  return {
    ...conv,
    lastBody: patch.lastBody,
    lastType: patch.lastType,
    lastDirection: patch.lastDirection,
    // Keep the list's own unit (epoch seconds) -- formatTime() and the
    // notification diff both compare numbers in seconds.
    lastMessageAt: Math.floor(patch.lastMessageAt / 1000),
    unreadCount: (conv.unreadCount ?? 0) + patch.unreadCountDelta,
  }
}

// A burst of events that each need the inbox lists refetched (history sync
// creating hundreds of new chats, archive/mute syncing from the phone) used
// to trigger one full refetch of every loaded tab + page per event, on
// every open browser. Coalesce: at most one refetch per window.
const LIST_REFETCH_WINDOW_MS = 1500
const pendingListRefetch = new Map<string, ReturnType<typeof setTimeout>>()

function invalidateConversationListsSoon(queryClient: QueryClient, workspaceId: string) {
  if (pendingListRefetch.has(workspaceId)) return
  pendingListRefetch.set(
    workspaceId,
    setTimeout(() => {
      pendingListRefetch.delete(workspaceId)
      queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] })
    }, LIST_REFETCH_WINDOW_MS)
  )
}

function handleNewMessage(
  queryClient: QueryClient,
  workspaceId: string,
  data: NewMessageEvent
) {
  const { conversationId, conversationPatch: patch } = data
  // Object (not a `let`) so TS doesn't narrow it to `false` -- it's set
  // inside the updater callback.
  const flags = { becameUnread: false }
  // Every cached tab/search variant of the inbox list.
  const known = patchConversationCaches(queryClient, workspaceId, (conv) => {
    if (conv.id !== conversationId) return conv
    if ((conv.unreadCount ?? 0) === 0 && patch.unreadCountDelta > 0) flags.becameUnread = true
    return patchConversation(conv, patch)
  })

  if (flags.becameUnread) {
    queryClient.setQueryData<any>(conversationCountsKey(workspaceId), (old: any) =>
      old ? { ...old, unread: old.unread + 1 } : old
    )
  }

  // A conversation the cached lists don't have yet (first message from a
  // new contact, or one that was archived) can't be patched in place --
  // refetch the lists once so it appears (and notifications see it).
  if (!known) {
    invalidateConversationListsSoon(queryClient, workspaceId)
  }

  // Only refetches if that thread is actually mounted (active query).
  queryClient.invalidateQueries({ queryKey: ["messages", conversationId] })
}

const STATUS_RANK: Partial<Record<string, number>> = {
  failed: 0.5, // only ever follows queued (server enforces the same)
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
}

// Patch ticks in place -- a busy thread gets a receipt per message, and a
// refetch per receipt would re-read the whole page from D1 each time. Falls
// back to one refetch only if the message isn't in the cache yet (e.g. an
// optimistic send whose waMessageId hasn't landed).
function handleMessageStatus(queryClient: QueryClient, data: MessageStatusEvent) {
  const key = ["messages", data.conversationId]
  const cached = queryClient.getQueryData<any>(key)
  if (!cached?.pages) return // thread not loaded -- nothing to update
  const ids = new Set(data.messageIds)
  const nextRank = STATUS_RANK[data.status] ?? 0
  let found = 0
  queryClient.setQueryData<any>(key, (old: any) => {
    if (!old?.pages) return old
    return {
      ...old,
      pages: old.pages.map((page: any) => ({
        ...page,
        items: page.items.map((m: any) => {
          if (!m.waMessageId || !ids.has(m.waMessageId)) return m
          found++
          return (STATUS_RANK[m.status] ?? 0) < nextRank
            ? { ...m, status: data.status }
            : m
        }),
      })),
    }
  })
  if (found < ids.size) queryClient.invalidateQueries({ queryKey: key })
}

function handleCampaignProgress(
  queryClient: QueryClient,
  workspaceId: string,
  data: CampaignProgressEvent
) {
  const key = ["broadcast-campaigns", workspaceId]
  if (data.campaignStatus) {
    // Status transitions are rare (running / completed / failed) --
    // one authoritative refetch each.
    queryClient.invalidateQueries({ queryKey: key })
    return
  }
  if (!data.recipientStatus) return
  // Per-recipient progress: patch the counters in place instead of
  // re-running getCampaigns' full aggregate for every single send.
  const field = data.recipientStatus
  // Campaigns are a cursor-paged infinite query: patch the counters in
  // place on whichever page holds this campaign.
  queryClient.setQueriesData<any>({ queryKey: key }, (old: any) => {
    if (!old?.pages) return old
    return {
      ...old,
      pages: old.pages.map((page: any) => ({
        ...page,
        items: page.items.map((c: any) => {
          if (c.id !== data.campaignId || !c.stats) return c
          return {
            ...c,
            stats: {
              ...c.stats,
              [field]: c.stats[field] + 1,
              pending: Math.max(0, c.stats.pending - 1),
            },
          }
        }),
      })),
    }
  })
}

/** Routes one realtime event into the React Query cache. */
export function applyRealtimeEvent(
  queryClient: QueryClient,
  workspaceId: string,
  event: RealtimeEvent
) {
  switch (event.type) {
    case "new-message":
      handleNewMessage(queryClient, workspaceId, event)
      break
    case "message-status":
      handleMessageStatus(queryClient, event)
      break
    case "session-status":
      queryClient.setQueryData(["sessions", workspaceId], (old: any) => {
        if (!Array.isArray(old)) return old
        return old.map((s: any) =>
          s.id !== event.sessionId
            ? s
            : {
                ...s,
                status: event.status,
                connectedJid: event.user ?? s.connectedJid,
              }
        )
      })
      break
    case "message-reaction":
    case "message-edited":
    case "message-deleted":
      // Scoped to the one thread when the engine could tell us which one --
      // a reaction in a busy workspace used to refetch every open thread's
      // history on every reaction/edit/delete.
      queryClient.invalidateQueries({
        queryKey: event.conversationId
          ? ["messages", event.conversationId]
          : ["messages"],
      })
      break
    case "chat-state":
      invalidateConversationListsSoon(queryClient, workspaceId)
      break
    case "campaign-progress":
      handleCampaignProgress(queryClient, workspaceId, event)
      break
    case "scheduled-message":
      queryClient.invalidateQueries({
        queryKey: ["scheduled-messages", workspaceId],
      })
      break
    case "socket-open":
      // Reconnect after a drop: one catch-up read for whatever arrived
      // while we were offline (the first open of a session skips this
      // -- the lists were just fetched).
      if (event.reconnect) {
        queryClient.invalidateQueries({
          queryKey: ["conversations", workspaceId],
        })
        queryClient.invalidateQueries({ queryKey: ["messages"] })
      }
      break
  }
}
