import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { serverChatModify } from "@/lib/wa-server"
import { patchConversationById } from "../lib/conversation-cache"

/**
 * Archive/mute a chat. Both are WhatsApp-native chat state (synced back to
 * the phone via chatModify, same call WhatsApp Web itself uses), not just a
 * local flag -- the worker mirrors the result into `conversations.archived`
 * / `.muted` on success, so we optimistically patch the same fields here
 * and reconcile once the mutation settles.
 */
export function useChatModify(workspaceId: string) {
  const queryClient = useQueryClient()
  function patch(id: string, fields: Record<string, unknown>) {
    patchConversationById(queryClient, workspaceId, id, fields)
  }

  const archive = useMutation({
    mutationFn: (vars: {
      conversationId: string
      waSessionId: string
      jid: string
      archived: boolean
    }) =>
      serverChatModify({
        data: {
          sessionId: vars.waSessionId,
          jid: vars.jid,
          archive: vars.archived,
        },
      }),
    onMutate: (vars) => patch(vars.conversationId, { archived: vars.archived }),
    onSuccess: (_res, vars) =>
      toast.success(vars.archived ? "Conversation archived" : "Conversation unarchived"),
    onError: (_err, vars) => {
      patch(vars.conversationId, { archived: !vars.archived })
      toast.error("Couldn't update the chat. Please try again.")
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] })
    },
  })

  const mute = useMutation({
    mutationFn: (vars: {
      conversationId: string
      waSessionId: string
      jid: string
      muted: boolean
    }) =>
      serverChatModify({
        data: {
          sessionId: vars.waSessionId,
          jid: vars.jid,
          // 8 hours -- WhatsApp's own shortest "mute" preset -- rather than
          // a picker; unmuting clears it.
          mute: vars.muted ? Date.now() + 8 * 60 * 60 * 1000 : null,
        },
      }),
    onMutate: (vars) => patch(vars.conversationId, { muted: vars.muted }),
    onSuccess: (_res, vars) =>
      toast.success(vars.muted ? "Conversation muted for 8 hours" : "Conversation unmuted"),
    onError: (_err, vars) => {
      patch(vars.conversationId, { muted: !vars.muted })
      toast.error("Couldn't update notifications. Please try again.")
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] })
    },
  })

  return { archive, mute }
}
