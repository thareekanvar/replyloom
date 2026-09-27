import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverSendLocation } from "@/lib/wa-server"

export function useSendLocation({
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
      latitude: number
      longitude: number
      name?: string
      address?: string
    }) => {
      if (!waSessionId || !toJid) throw new Error("No linked WhatsApp session")
      return serverSendLocation({
        data: {
          sessionId: waSessionId,
          to: toJid,
          latitude: vars.latitude,
          longitude: vars.longitude,
          name: vars.name,
          address: vars.address,
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
