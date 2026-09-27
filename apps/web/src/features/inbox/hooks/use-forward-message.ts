import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverForwardMessage } from "@/lib/wa-server"

export function useForwardMessage({
  waSessionId,
  workspaceId,
}: {
  waSessionId: string | null
  workspaceId: string
}) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      messageId,
      from,
      to,
      text,
    }: {
      messageId: string
      from: string
      to: string
      text?: string
    }) => {
      if (!waSessionId) throw new Error("No linked WhatsApp session")

      return serverForwardMessage({
        data: {
          sessionId: waSessionId,
          msgId: messageId,
          from,
          to,
          text,
        },
      })
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["conversations", workspaceId],
      })
    },
  })
}
