import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverSendPoll } from "@/lib/wa-server"

export function useSendPoll({
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
      name: string
      values: string[]
      selectableCount?: number
    }) => {
      if (!waSessionId || !toJid) throw new Error("No linked WhatsApp session")
      return serverSendPoll({
        data: {
          sessionId: waSessionId,
          to: toJid,
          name: vars.name,
          values: vars.values,
          selectableCount: vars.selectableCount,
        },
      })
    },
    onSettled: () => {
      if (conversationId)
        queryClient.invalidateQueries({ queryKey: ["messages", conversationId] })
      queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] })
    },
  })
}
