import { useMutation } from "@tanstack/react-query"
import { serverPinMessage } from "@/lib/wa-server"

/** Pin/unpin a message to the top of the chat on WhatsApp itself. There's
 * no local "pinned messages" table to reconcile against (WhatsApp doesn't
 * expose a list-pinned-messages API either), so this is a straight
 * fire-and-confirm action — the caller tracks the toggled-on-screen state. */
export function usePinMessage({
  waSessionId,
  toJid,
}: {
  waSessionId: string | null
  toJid: string | null
}) {
  return useMutation({
    mutationFn: async ({
      messageId,
      pin,
      fromMe,
      participant,
    }: {
      messageId: string
      pin: boolean
      fromMe: boolean
      participant?: string | null
    }) => {
      if (!waSessionId || !toJid) throw new Error("No linked WhatsApp session")
      return serverPinMessage({
        data: {
          sessionId: waSessionId,
          to: toJid,
          msgId: messageId,
          pin,
          fromMe,
          participant: participant ?? undefined,
        },
      })
    },
  })
}
