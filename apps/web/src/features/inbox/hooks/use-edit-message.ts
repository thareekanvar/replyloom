import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverEditMessage } from "@/lib/wa-server"

export function useEditMessage({
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
      newText,
    }: {
      messageId: string
      newText: string
    }) => {
      if (!waSessionId || !toJid) throw new Error("No linked WhatsApp session")

      return serverEditMessage({
        data: {
          sessionId: waSessionId,
          to: toJid,
          msgId: messageId,
          newText,
        },
      })
      // (server fn itself now maps msgId/newText -> the worker's
      // messageId/text fields -- see serverEditMessage in wa-server.ts)
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["messages", conversationId],
      })
    },
  })
}
