import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  serverCreateGroup,
  serverUpdateGroupParticipants,
  serverUpdateGroupSettings,
  serverLeaveGroup,
  serverGroupInviteLink,
  serverToggleGroupEphemeral,
} from "@/lib/wa-server"

export function useCreateGroup(_workspaceId: string) {
  return useMutation({
    mutationFn: (vars: {
      sessionId: string
      subject: string
      participants: string[]
    }) => serverCreateGroup({ data: vars }),
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't create the group."),
  })
}

/** Add/remove/promote/demote members + subject/description/settings edits
 * + leaving + the invite link — everything the contact-info panel's group
 * view needs, sharing one query-invalidation strategy (group members +
 * conversations both depend on this). */
export function useGroupActions(workspaceId: string, groupJid: string | null) {
  const queryClient = useQueryClient()

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["group-members", workspaceId, groupJid] })
    queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] })
    queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId, "paged"] })
  }

  const updateParticipants = useMutation({
    mutationFn: (vars: {
      sessionId: string
      participants: string[]
      action: "add" | "remove" | "promote" | "demote"
    }) =>
      serverUpdateGroupParticipants({
        data: { sessionId: vars.sessionId, groupJid: groupJid!, participants: vars.participants, action: vars.action },
      }),
    onSuccess: (_res, vars) => {
      invalidate()
      const verb = { add: "added", remove: "removed", promote: "promoted", demote: "demoted" }[vars.action]
      toast.success(`Participant${vars.participants.length > 1 ? "s" : ""} ${verb}`)
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't update participants."),
  })

  const updateSettings = useMutation({
    mutationFn: (vars: {
      sessionId: string
      subject?: string
      description?: string
      setting?: "announcement" | "not_announcement" | "locked" | "unlocked"
    }) =>
      serverUpdateGroupSettings({
        data: { sessionId: vars.sessionId, groupJid: groupJid!, subject: vars.subject, description: vars.description, setting: vars.setting },
      }),
    onSuccess: () => {
      invalidate()
      toast.success("Group updated")
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't update the group."),
  })

  const leave = useMutation({
    mutationFn: (vars: { sessionId: string }) =>
      serverLeaveGroup({ data: { sessionId: vars.sessionId, groupJid: groupJid! } }),
    onSuccess: () => {
      invalidate()
      toast.success("Left the group")
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't leave the group."),
  })

  const inviteLink = useMutation({
    mutationFn: (vars: { sessionId: string; action: "get" | "revoke" }) =>
      serverGroupInviteLink({ data: { sessionId: vars.sessionId, groupJid: groupJid!, action: vars.action } }),
    onError: (err: any) => toast.error(err?.message ?? "Couldn't fetch the invite link."),
  })

  const setEphemeral = useMutation({
    mutationFn: (vars: { sessionId: string; duration: number }) =>
      serverToggleGroupEphemeral({ data: { sessionId: vars.sessionId, groupJid: groupJid!, duration: vars.duration } }),
    onSuccess: () => toast.success("Disappearing messages updated"),
    onError: (err: any) => toast.error(err?.message ?? "Couldn't update disappearing messages."),
  })

  return { updateParticipants, updateSettings, leave, inviteLink, setEphemeral }
}
