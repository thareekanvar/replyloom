import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverSendMsg } from "@/lib/wa-server"

interface OptimisticMessage {
  id: string
  waMessageId: string | null
  direction: "out"
  senderJid: string | null
  type: "text"
  body: string
  mediaKey: null
  mediaMime: null
  status: "queued"
  createdAt: number
}

/**
 * Sends straight to the engine Worker via a server function.
 * The server function attaches the required secrets and workspace headers.
 */
export function useSendMessage({
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
    mutationFn: async (text: string) => {
      if (!waSessionId || !toJid)
        throw new Error("This conversation has no linked WhatsApp session.")

      const optimistic: OptimisticMessage = {
        id: `optimistic-${crypto.randomUUID()}`,
        waMessageId: null,
        direction: "out",
        senderJid: null,
        type: "text",
        body: text,
        mediaKey: null,
        mediaMime: null,
        status: "queued",
        createdAt: Math.floor(Date.now() / 1000),
      }
      if (conversationId) {
        queryClient.setQueryData<{
          pages: Array<{ items: OptimisticMessage[] }>
          pageParams: unknown[]
        }>(["messages", conversationId], (prev) => {
          if (!prev?.pages.length) return prev
          const pages = prev.pages.slice()
          const lastPage = pages[0]
          pages[0] = { ...lastPage, items: [...lastPage.items, optimistic] }
          return { ...prev, pages }
        })
      }

      return serverSendMsg({
        data: {
          sessionId: waSessionId,
          to: toJid,
          text,
        },
      })
    },
    onSuccess: (_result, text) => {
      if (!conversationId) return
      queryClient.setQueryData<any>(
        ["messages", conversationId],
        (prev: any) =>
          prev
            ? {
                ...prev,
                pages: prev.pages.map((page: any) => ({
                  ...page,
                  items: page.items.map((message: any) =>
                    message.id.startsWith("optimistic-") &&
                    message.status === "queued" &&
                    message.body === text
                      ? { ...message, status: "sent" }
                      : message
                  ),
                })),
              }
            : prev
      )
    },
    onError: (_error, text) => {
      if (!conversationId) return
      queryClient.setQueryData<any>(
        ["messages", conversationId],
        (prev: any) =>
          prev
            ? {
                ...prev,
                pages: prev.pages.map((page: any) => ({
                  ...page,
                  items: page.items.map((message: any) =>
                    message.id.startsWith("optimistic-") &&
                    message.status === "queued" &&
                    message.body === text
                      ? { ...message, status: "failed" }
                      : message
                  ),
                })),
              }
            : prev
      )
    },
    onSettled: () => {
      // Do not immediately refetch the thread: that would overwrite the
      // optimistic bubble during the short window before D1 is queryable.
      // The inbox poll reconciles it with the authoritative row shortly.
      queryClient.invalidateQueries({
        queryKey: ["conversations", workspaceId],
      })
    },
  })
}
