import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  setConversationPinned,
  setConversationStatus,
  markConversationRead,
  assignConversation,
} from "./use-conversations"
import { patchConversationById } from "../lib/conversation-cache"

/**
 * Pin/unpin, read/unread and status mutations for a conversation. All
 * three optimistically patch the ["conversations", workspaceId] cache so
 * the list re-sorts/re-badges instantly, then reconcile with the server
 * on settle (same "optimistic now, authoritative shortly after" pattern
 * as use-send-message.ts).
 */
export function useConversationActions(workspaceId: string) {
  const queryClient = useQueryClient()
  // Prefix: invalidates every tab/search variant of the list + the counts.
  const queryKey = ["conversations", workspaceId] as const

  function patch(id: string, fields: Record<string, unknown>) {
    patchConversationById(queryClient, workspaceId, id, fields)
  }

  const pin = useMutation({
    mutationFn: (vars: { conversationId: string; pinned: boolean }) =>
      setConversationPinned({ data: { ...vars, workspaceId } }),
    onMutate: (vars) =>
      patch(vars.conversationId, {
        pinnedAt: vars.pinned ? Math.floor(Date.now() / 1000) : null,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  const markRead = useMutation({
    mutationFn: (vars: { conversationId: string }) =>
      markConversationRead({ data: { ...vars, workspaceId } }),
    onMutate: (vars) => patch(vars.conversationId, { unreadCount: 0 }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  const markUnread = useMutation({
    // No dedicated "mark unread" server fn — bumping to 1 is enough to
    // show the unread dot/badge again; the next real inbound message
    // will set the true count anyway.
    mutationFn: (vars: { conversationId: string }) => {
      patch(vars.conversationId, { unreadCount: 1 })
      return Promise.resolve({ ok: true })
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: [...queryKey, "counts"] }),
  })

  const setStatus = useMutation({
    mutationFn: (vars: {
      conversationId: string
      status: "open" | "pending" | "resolved"
    }) => setConversationStatus({ data: { ...vars, workspaceId } }),
    onMutate: (vars) => patch(vars.conversationId, { status: vars.status }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  const assign = useMutation({
    mutationFn: (vars: { conversationId: string; assignedTo: string | null; assignedTeamId?: string | null }) =>
      assignConversation({ data: { ...vars, workspaceId } }),
    onMutate: (vars) => patch(vars.conversationId, { assignedTo: vars.assignedTo, assignedTeamId: vars.assignedTeamId ?? null }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  return { pin, markRead, markUnread, setStatus, assign }
}
