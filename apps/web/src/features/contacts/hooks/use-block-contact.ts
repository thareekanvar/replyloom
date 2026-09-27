import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { setContactBlocked } from "@/features/contacts/hooks/use-contacts"
import { serverBlockUser } from "@/lib/wa-server"

/**
 * Blocking a contact needs to do two things: flip our own `blocked` flag
 * (so blocked contacts are visibly marked and can be filtered/excluded from
 * campaigns) *and* tell WhatsApp itself via the engine, or the contact never
 * actually stops being able to message in. Previously only the first half
 * happened — this ties them together so "Block" in the UI matches reality.
 *
 * The engine call needs a live session + jid; the DB flag still gets set
 * even if that's missing (e.g. contact has no linked session), so the CRM
 * side of blocking always works, with a toast warning when WhatsApp itself
 * couldn't be reached.
 */
export function useBlockContact(workspaceId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (vars: {
      contactId: string
      jid: string | null
      waSessionId: string | null
      blocked: boolean
    }) => {
      const [dbResult, engineResult] = await Promise.all([
        setContactBlocked({
          data: { contactId: vars.contactId, blocked: vars.blocked },
        }),
        vars.jid && vars.waSessionId
          ? serverBlockUser({
              data: {
                sessionId: vars.waSessionId,
                jid: vars.jid,
                block: vars.blocked,
              },
            }).catch(() => ({ ok: false }))
          : Promise.resolve({ ok: true }),
      ])
      return {
        ok: dbResult.ok,
        engineOk: engineResult.ok,
        blocked: vars.blocked,
      }
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
      queryClient.invalidateQueries({
        queryKey: ["conversations", workspaceId],
      })
      if (res.engineOk) {
        toast.success(res.blocked ? "Contact blocked" : "Contact unblocked")
      } else {
        toast.warning(
          res.blocked
            ? "Marked as blocked here, but WhatsApp couldn't confirm the block — check the session is connected."
            : "Marked as unblocked here, but WhatsApp couldn't confirm the unblock — check the session is connected."
        )
      }
    },
    onError: () => toast.error("Couldn't update block status."),
  })
}
