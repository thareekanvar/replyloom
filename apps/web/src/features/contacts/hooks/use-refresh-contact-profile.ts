import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { serverRefreshProfile } from "@/lib/wa-server"
import { updateContactProfile } from "./use-contacts"

/**
 * Fetches a contact's real WhatsApp photo + "about" status straight from
 * the engine (Baileys' profilePictureUrl/fetchStatus), then persists
 * whatever came back to D1. On demand only -- see the anti-ban note on
 * apps/worker/src/whatsapp-session.ts's /refresh-profile handler for why
 * this isn't done eagerly for a whole contact list.
 */
export function useRefreshContactProfile(workspaceId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      contactId,
      waSessionId,
      jid,
    }: {
      contactId: string
      waSessionId: string
      jid: string
    }) => {
      const result = await serverRefreshProfile({
        data: {
          sessionId: waSessionId,
          jid,
        },
      })
      await updateContactProfile({
        data: { contactId, avatarUrl: result.avatarUrl, about: result.about },
      })
      return result
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
      queryClient.invalidateQueries({
        queryKey: ["conversations", workspaceId],
      })
    },
    onError: (err: any) => {
      console.error("refreshProfile failed:", err)
      toast.error(
        err?.message ||
          "Couldn't refresh this contact's photo/about. Please try again."
      )
    },
  })
}
