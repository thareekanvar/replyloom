import { useMutation, useQueryClient } from "@tanstack/react-query"
import { serverSendTemplate } from "@/lib/wa-server"
import { bumpTemplateUsage } from "@/features/templates/hooks/use-templates"

/**
 * Sends a (already variable-resolved) template as a normal message —
 * same shape as useSendMedia, just routed through /send-template so a
 * template's attachment can be reused straight from R2 without a
 * re-upload. Used for a media template picked in the composer; a
 * text-only template is just inserted into the draft instead (see
 * message-composer.tsx) so it can still be edited before sending.
 */
export function useSendTemplate({
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
    mutationFn: async ({
      templateId,
      text,
      mediaKey,
    }: {
      templateId: string
      text?: string
      mediaKey?: string
    }) => {
      if (!waSessionId || !toJid)
        throw new Error("This conversation has no linked WhatsApp session.")
      const result = await serverSendTemplate({
        data: {
          sessionId: waSessionId,
          to: toJid,
          text,
          mediaKey,
        },
      })
      bumpTemplateUsage({ data: { id: templateId } }).catch(() => {})
      return result
    },
    onSettled: () => {
      setTimeout(() => {
        if (conversationId)
          queryClient.invalidateQueries({
            queryKey: ["messages", conversationId],
          })
        queryClient.invalidateQueries({
          queryKey: ["conversations", workspaceId],
        })
      }, 600)
    },
  })
}
