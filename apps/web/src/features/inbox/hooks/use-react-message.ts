import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverReact } from "@/lib/wa-server"

export function useReactMessage({
  waSessionId,
  conversationId,
  workspaceId,
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
      emoji,
      fromMe,
      participant,
    }: {
      messageId: string
      emoji: string
      fromMe: boolean
      participant?: string | null
    }) => {
      if (!waSessionId || !toJid) throw new Error("No linked WhatsApp session")

      return serverReact({
        data: {
          sessionId: waSessionId,
          to: toJid,
          msgId: messageId,
          emoji,
          fromMe,
          participant: participant ?? undefined,
        },
      })
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["messages", conversationId],
      })
      queryClient.invalidateQueries({
        queryKey: ["conversations", workspaceId],
      })
    },
  })
}
