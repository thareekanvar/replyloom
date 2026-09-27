import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverSendContactCard } from "@/lib/wa-server"

export function useSendContactCard({
  waSessionId,
  conversationId,
  workspaceId,
  toJid,
}: {
  waSessionId: string | null
  conversationId: string | null
  workspaceId: string
  toJid: string | null
}) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (vars: {
      contacts: Array<{ displayName: string; vcard: string }>
    }) => {
      if (!waSessionId || !toJid) throw new Error("No linked WhatsApp session")
      return serverSendContactCard({
        data: { sessionId: waSessionId, to: toJid, contacts: vars.contacts },
      })
    },
    onSettled: () => {
      if (conversationId)
        queryClient.invalidateQueries({ queryKey: ["messages", conversationId] })
      queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] })
    },
  })
}
