import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverSendMedia, serverSendTemplate } from "@/lib/wa-server"
import { fileToBase64 } from "@/lib/file-utils"

/** Shared post-send invalidation so the thread + list update within ~half a second. */
function useSendInvalidation(
  conversationId: string | null,
  workspaceId: string
) {
  const queryClient = useQueryClient()
  return () => {
    setTimeout(() => {
      if (conversationId)
        queryClient.invalidateQueries({
          queryKey: ["messages", conversationId],
        })
      queryClient.invalidateQueries({
        queryKey: ["conversations", workspaceId],
      })
    }, 600)
  }
}

/**
 * Sends an attachment via a server function.
 */
export function useSendMedia({
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
  const invalidate = useSendInvalidation(conversationId, workspaceId)

  return useMutation({
    mutationFn: async ({
      file,
      type,
      caption,
    }: {
      file: File
      type: "image" | "video" | "audio" | "document"
      caption?: string
    }) => {
      if (!waSessionId || !toJid)
        throw new Error("This conversation has no linked WhatsApp session.")
      return serverSendMedia({
        data: {
          sessionId: waSessionId,
          to: toJid,
          type,
          caption,
          fileBase64: await fileToBase64(file),
          fileName: file.name,
          fileMime: file.type || "application/octet-stream",
        },
      })
    },
    onSettled: invalidate,
  })
}

/**
 * Sends an existing gallery asset via a server function.
 */
export function useSendMediaKey({
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
  const invalidate = useSendInvalidation(conversationId, workspaceId)

  return useMutation({
    mutationFn: async ({
      text,
      mediaKey,
    }: {
      text?: string
      mediaKey: string
    }) => {
      if (!waSessionId || !toJid)
        throw new Error("This conversation has no linked WhatsApp session.")
      return serverSendTemplate({
        data: {
          sessionId: waSessionId,
          to: toJid,
          text,
          mediaKey,
        },
      })
    },
    onSettled: invalidate,
  })
}
