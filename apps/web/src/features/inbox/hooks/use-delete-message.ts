import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverDeleteMessage } from "@/lib/wa-server"

export function useDeleteMessage({
  waSessionId,
  conversationId,
   
  workspaceId: _workspaceId,
  toJid,
}: {
  waSessionId: string | null
  conversationId: string
  workspaceId: string
  toJid: string | null
}) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      messageId,
      forEveryone,
      fromMe,
      participant,
    }: {
      messageId: string
      forEveryone: boolean
      fromMe: boolean
      participant?: string | null
    }) => {
      if (!waSessionId || !toJid) throw new Error("No linked WhatsApp session")

      return serverDeleteMessage({
        data: {
          sessionId: waSessionId,
          to: toJid,
          msgId: messageId,
          forEveryone,
          fromMe,
          participant: participant ?? undefined,
        },
      })
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["messages", conversationId],
      })
    },
  })
}
