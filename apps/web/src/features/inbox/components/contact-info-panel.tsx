import { useEffect, useState } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LoadMoreButton } from "@/components/load-more-button"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Badge } from "@workspace/ui/components/badge"
import { Textarea } from "@workspace/ui/components/textarea"
import { Separator } from "@workspace/ui/components/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import {
  PinIcon,
  StickyNoteIcon,
  UsersIcon,
  TrendingUpIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RefreshCwIcon,
  BanIcon,
  ShieldCheckIcon,
  EllipsisVerticalIcon,
  ShieldIcon,
  ShieldOffIcon,
  UserMinusIcon,
  UserPlusIcon,
  LogOutIcon,
  LinkIcon,
  CopyIcon,
  TimerIcon,
  PencilIcon,
} from "lucide-react"
import {
  getContactTags,
  getContactNotes,
  getGroupMembers,
  addNote,
  updateContact,
  setContactPinned,
  assignContact,
} from "@/features/contacts/hooks/use-contacts"
import { useBlockContact } from "@/features/contacts/hooks/use-block-contact"
import { useGroupActions } from "../hooks/use-group-actions"
import { syncGroupMembersNow } from "@/features/integrations/hooks/use-sessions"
import { serverSetDisappearing } from "@/lib/wa-server"
import { getMembers, getTeams } from "@/features/team/hooks/use-team"
import { useRefreshContactProfile } from "@/features/contacts/hooks/use-refresh-contact-profile"
import { shownOf, totalOf } from "@/lib/format-count"

const STAGES = ["lead", "active", "customer", "churned"] as const

export interface ConversationContactInfo {
  kind: "direct" | "group"
  contactId: string | null
  contactName: string | null
  contactAvatar: string | null
  contactJid: string | null
  contactPhone: string | null
  contactLifecycleStage: string | null
  contactAssignedTo: string | null
  contactAssignedTeamId: string | null
  contactPinnedAt: number | null
  contactAbout: string | null
  contactAvatarFetchedAt: number | null
  contactBlocked: boolean | null
  sessionLabel: string | null
  groupName: string | null
  groupJid: string | null
  waSessionId: string
}

function getInitials(name: string | null, jid: string | null): string {
  if (name)
    return name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()
  if (jid) return jid.split("@")[0].slice(-2)
  return "??"
}

/**
 * Right-hand "who am I talking to" panel for the currently open conversation
 * -- the same contact fields as the Contacts page's detail sheet, but
 * inline next to the thread so there's no context switch mid-conversation.
 */
// Base UI's <Select.Value> only shows the human label automatically when
// <Select.Root> is given an `items` map (or <Select.Value> is given a
// render function) -- a bare `<SelectValue />` otherwise falls back to
// printing the raw selected value ("86400" instead of "24 hours"), which
// is exactly the bug this was showing. Every other Select in this file
// works around it by passing computed label text as SelectValue's
// children; this does the same for the disappearing-messages selects.
const DISAPPEARING_LABELS: Record<string, string> = {
  "0": "Off",
  "86400": "24 hours",
  "604800": "7 days",
  "7776000": "90 days",
}

export function ContactInfoPanel({
  conversation,
  workspaceId,
  onConvertToDeal,
  convertingToDeal,
}: {
  conversation: ConversationContactInfo
  workspaceId: string
  onConvertToDeal?: () => void
  convertingToDeal?: boolean
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(conversation.contactName ?? "")
  const [noteText, setNoteText] = useState("")
  const contactId = conversation.contactId
  const refreshProfile = useRefreshContactProfile(workspaceId)
  const blockMutation = useBlockContact(workspaceId)

  // ── Group management state ──
  const groupActions = useGroupActions(workspaceId, conversation.groupJid)
  const [groupSubject, setGroupSubject] = useState(conversation.groupName ?? "")
  const [editingGroupSubject, setEditingGroupSubject] = useState(false)
  const [newParticipant, setNewParticipant] = useState("")
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [confirmLeaveGroup, setConfirmLeaveGroup] = useState(false)
  const [disappearing, setDisappearing] = useState<string>("0")
  const disappearingMutation = useMutation({
    mutationFn: (duration: number) => {
      const to =
        conversation.kind === "group" ? conversation.groupJid : conversation.contactJid
      if (!to) throw new Error("No linked chat")
      return serverSetDisappearing({
        data: { sessionId: conversation.waSessionId, to, duration },
      })
    },
    onSuccess: () => toast.success("Disappearing messages updated"),
    onError: () => toast.error("Couldn't update disappearing messages."),
  })

  useEffect(() => {
    setGroupSubject(conversation.groupName ?? "")
    setEditingGroupSubject(false)
    setInviteLink(null)
  }, [conversation.groupJid])

  // The panel stays mounted across conversation switches, so sync local
  // editable state whenever the underlying contact changes.
  useEffect(() => {
    setName(conversation.contactName ?? "")
    setNoteText("")
  }, [contactId])

  // First look at this contact and we've never fetched their real photo —
  // do it once, quietly, rather than making the user hunt for a button.
  // Never re-triggers on its own afterwards (contactAvatarFetchedAt is set
  // whether or not WhatsApp actually had anything to give back).
  useEffect(() => {
    if (
      contactId &&
      conversation.contactJid &&
      !conversation.contactAvatarFetchedAt &&
      !refreshProfile.isPending
    ) {
      refreshProfile.mutate({
        contactId,
        waSessionId: conversation.waSessionId,
        jid: conversation.contactJid,
      })
    }
  }, [contactId])

  const tagsQuery = useQuery({
    queryKey: ["contact-tags", contactId],
    queryFn: () => getContactTags({ data: { contactId: contactId! } }),
    enabled: !!contactId,
  })

  const groupMembersQuery = useQuery({
    queryKey: ["group-members", workspaceId, conversation.groupJid],
    queryFn: () => getGroupMembers({ data: { workspaceId, groupJid: conversation.groupJid! } }),
    enabled: conversation.kind === "group" && !!conversation.groupJid,
  })
  // On-demand escape hatch for a session connected with "sync group
  // members" off (see QrConnectDialog), or just to refresh a roster that's
  // gone stale -- pulls this one group's current members right now instead
  // of waiting for the next full reconnect.
  const syncMembers = useMutation({
    mutationFn: () =>
      syncGroupMembersNow({
        data: { sessionId: conversation.waSessionId, groupJid: conversation.groupJid! },
      }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ["group-members", workspaceId, conversation.groupJid] })
      toast.success(`Synced ${res?.memberCount ?? 0} member${res?.memberCount === 1 ? "" : "s"}`)
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't sync group members."),
  })
  // Promote/demote/remove all require our own connected WhatsApp number to
  // actually be an admin (or owner) of this group -- WhatsApp enforces that
  // server-side no matter what the CRM shows, so the member-actions menu
  // should only appear when it'd actually work. See getGroupMembers, which
  // resolves this by matching the session's own JID against the synced
  // member list.
  const canManageGroupMembers =
    groupMembersQuery.data?.selfRole === "admin" || groupMembersQuery.data?.selfRole === "superadmin"

  const notesQuery = useInfiniteQuery({
    queryKey: ["contact-notes", contactId],
    queryFn: ({ pageParam }) =>
      getContactNotes({ data: { contactId: contactId!, cursor: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!contactId,
  })
  const noteItems = notesQuery.data?.pages.flatMap((p) => p.items) ?? []
  const membersQuery = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () => getMembers({ data: { workspaceId } }),
  })
  const teamsQuery = useQuery({
    queryKey: ["teams", workspaceId],
    queryFn: () => getTeams({ data: { workspaceId } }),
  })
  const assignMutation = useMutation({
    mutationFn: (assignment: { assignedTo: string | null; assignedTeamId: string | null }) =>
      assignContact({ data: { workspaceId, contactId: contactId!, ...assignment } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] })
      queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
      toast.success("Assignment updated")
    },
  })

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["conversations", workspaceId] })
    queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
  }

  const saveNameMutation = useMutation({
    mutationFn: (value: string) =>
      updateContact({ data: { workspaceId, contactId: contactId!, name: value } }),
    onSuccess: () => {
      invalidate()
      toast.success("Contact updated")
    },
  })

  const stageMutation = useMutation({
    mutationFn: (stage: string) =>
      updateContact({ data: { workspaceId, contactId: contactId!, lifecycleStage: stage } }),
    onSuccess: invalidate,
  })

  const pinMutation = useMutation({
    mutationFn: (pinned: boolean) =>
      setContactPinned({ data: { contactId: contactId!, pinned } }),
    onSuccess: invalidate,
  })

  const addNoteMutation = useMutation({
    mutationFn: (body: string) =>
      addNote({ data: { contactId: contactId!, workspaceId, body } }),
    onSuccess: () => {
      setNoteText("")
      queryClient.invalidateQueries({ queryKey: ["contact-notes", contactId] })
    },
  })

  const assignedTeam = teamsQuery.data?.find(
    (team) => team.id === conversation.contactAssignedTeamId
  )
  const assignedMember = membersQuery.data?.find(
    (member) => member.userId === conversation.contactAssignedTo
  )
  const assignmentLabel = assignedTeam
    ? `Team: ${assignedTeam.name}`
    : assignedMember?.name ?? "Unassigned"

  if (conversation.kind === "group") {
    const sessionId = conversation.waSessionId
    const groupJid = conversation.groupJid

    return (
      <div className="flex flex-col gap-4 px-5 py-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-muted">
            <UsersIcon className="size-6 text-muted-foreground" />
          </div>
          {editingGroupSubject ? (
            <div className="flex w-full items-center gap-1.5">
              <Input
                value={groupSubject}
                onChange={(e) => setGroupSubject(e.target.value)}
                className="h-8 text-center"
                autoFocus
              />
              <Button
                size="sm"
                className="h-8 shrink-0"
                disabled={!groupSubject.trim() || groupActions.updateSettings.isPending}
                onClick={() =>
                  groupActions.updateSettings.mutate(
                    { sessionId, subject: groupSubject.trim() },
                    { onSuccess: () => setEditingGroupSubject(false) }
                  )
                }
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => {
                  setEditingGroupSubject(false)
                  setGroupSubject(conversation.groupName ?? "")
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="group flex items-center gap-1.5">
              <div>
                <div className="font-semibold">
                  {conversation.groupName ?? "Group"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {groupJid?.split("@")[0]}
                </div>
              </div>
              <button
                type="button"
                aria-label="Rename group"
                onClick={() => setEditingGroupSubject(true)}
                className="flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
              >
                <PencilIcon className="size-3.5" />
              </button>
            </div>
          )}
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5">
              <UsersIcon className="size-3.5" />
              Members {groupMembersQuery.data?.participantCount ? `(${groupMembersQuery.data.participantCount})` : ""}
            </Label>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground"
              disabled={syncMembers.isPending}
              onClick={() => syncMembers.mutate()}
            >
              {syncMembers.isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
              Sync members
            </Button>
          </div>

          <div className="flex items-center gap-1.5">
            <Input
              value={newParticipant}
              onChange={(e) => setNewParticipant(e.target.value)}
              placeholder="Add by phone number"
              className="h-8"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5"
              disabled={!newParticipant.trim() || groupActions.updateParticipants.isPending}
              onClick={() => {
                groupActions.updateParticipants.mutate({
                  sessionId,
                  participants: [newParticipant.trim()],
                  action: "add",
                })
                setNewParticipant("")
              }}
            >
              <UserPlusIcon className="size-3.5" /> Add
            </Button>
          </div>

          {groupMembersQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading members…</p>
          ) : groupMembersQuery.data?.members.length === 0 ? (
            <p className="text-xs text-muted-foreground">No members synced yet.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {groupMembersQuery.data?.members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                >
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                    {m.avatar ? (
                      <img src={m.avatar} alt="" className="size-7 rounded-full object-cover" />
                    ) : (
                      getInitials(m.name, m.jid)
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.name}</div>
                    {m.phone && (
                      <div className="truncate text-xs text-muted-foreground">{m.phone}</div>
                    )}
                  </div>
                  {m.role !== "member" && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {m.role === "superadmin" ? "Owner" : "Admin"}
                    </Badge>
                  )}
                  {m.role !== "superadmin" && canManageGroupMembers && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Member actions"
                            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                          />
                        }
                      >
                        <EllipsisVerticalIcon className="size-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {m.role === "admin" ? (
                          <DropdownMenuItem
                            onClick={() =>
                              groupActions.updateParticipants.mutate({
                                sessionId,
                                participants: [m.jid],
                                action: "demote",
                              })
                            }
                          >
                            <ShieldOffIcon /> Remove as admin
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() =>
                              groupActions.updateParticipants.mutate({
                                sessionId,
                                participants: [m.jid],
                                action: "promote",
                              })
                            }
                          >
                            <ShieldIcon /> Make admin
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            groupActions.updateParticipants.mutate({
                              sessionId,
                              participants: [m.jid],
                              action: "remove",
                            })
                          }
                        >
                          <UserMinusIcon /> Remove from group
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Label className="flex items-center gap-1.5">
            <TimerIcon className="size-3.5" /> Disappearing messages
          </Label>
          <Select
            value={disappearing}
            onValueChange={(v) => {
              if (!v) return
              setDisappearing(v)
              disappearingMutation.mutate(Number(v))
            }}
          >
            <SelectTrigger>
              <SelectValue>{DISAPPEARING_LABELS[disappearing] ?? "Off"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Off</SelectItem>
              <SelectItem value="86400">24 hours</SelectItem>
              <SelectItem value="604800">7 days</SelectItem>
              <SelectItem value="7776000">90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Label className="flex items-center gap-1.5">
            <LinkIcon className="size-3.5" /> Invite link
          </Label>
          {inviteLink ? (
            <div className="flex items-center gap-1.5">
              <Input value={inviteLink} readOnly className="h-8 text-xs" />
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Copy invite link"
                onClick={() => {
                  navigator.clipboard.writeText(inviteLink)
                  toast.success("Invite link copied")
                }}
              >
                <CopyIcon className="size-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-fit gap-1.5"
              disabled={groupActions.inviteLink.isPending}
              onClick={() =>
                groupActions.inviteLink.mutate(
                  { sessionId, action: "get" },
                  { onSuccess: (res) => setInviteLink(res.link) }
                )
              }
            >
              <LinkIcon className="size-3.5" /> Get invite link
            </Button>
          )}
          {inviteLink && (
            <Button
              variant="ghost"
              size="sm"
              className="w-fit gap-1.5 text-muted-foreground"
              disabled={groupActions.inviteLink.isPending}
              onClick={() =>
                groupActions.inviteLink.mutate(
                  { sessionId, action: "revoke" },
                  {
                    onSuccess: (res) => {
                      setInviteLink(res.link)
                      toast.success("Invite link reset")
                    },
                  }
                )
              }
            >
              Reset link
            </Button>
          )}
        </div>

        <Separator />

        <Button
          variant="outline"
          size="sm"
          className="w-fit gap-1.5 text-destructive hover:text-destructive"
          onClick={() => setConfirmLeaveGroup(true)}
        >
          <LogOutIcon className="size-3.5" /> Leave group
        </Button>

        <AlertDialog open={confirmLeaveGroup} onOpenChange={setConfirmLeaveGroup}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Leave {conversation.groupName ?? "this group"}?</AlertDialogTitle>
              <AlertDialogDescription>
                You&rsquo;ll stop receiving messages from this group until someone adds you back.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  groupActions.leave.mutate({ sessionId })
                  setConfirmLeaveGroup(false)
                }}
              >
                Leave group
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }


  const isPinned = !!conversation.contactPinnedAt
  const displayName = conversation.contactName ?? "Unknown contact"

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="group relative flex size-16 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-medium">
          {conversation.contactAvatar ? (
            <img
              src={conversation.contactAvatar}
              alt=""
              className="size-16 rounded-full object-cover"
            />
          ) : (
            getInitials(conversation.contactName, conversation.contactJid)
          )}
          {contactId && conversation.contactJid && (
            <button
              type="button"
              aria-label="Refresh photo"
              title="Refresh photo & about from WhatsApp"
              disabled={refreshProfile.isPending}
              onClick={() =>
                refreshProfile.mutate({
                  contactId,
                  waSessionId: conversation.waSessionId,
                  jid: conversation.contactJid!,
                })
              }
              className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-transparent transition-colors group-hover:bg-black/40 group-hover:text-white disabled:opacity-100"
            >
              <RefreshCwIcon
                className={`size-4 ${refreshProfile.isPending ? "animate-spin text-white" : ""}`}
              />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">{displayName}</span>
          <button
            type="button"
            aria-label={isPinned ? "Unpin contact" : "Pin contact"}
            onClick={() => contactId && pinMutation.mutate(!isPinned)}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {isPinned ? (
              <PinIcon className="size-3.5 fill-current" />
            ) : (
              <PinIcon className="size-3.5 opacity-30" />
            )}
          </button>
          {contactId && (
            <button
              type="button"
              aria-label={conversation.contactBlocked ? "Unblock contact" : "Block contact"}
              title={conversation.contactBlocked ? "Unblock contact" : "Block contact"}
              disabled={blockMutation.isPending}
              onClick={() =>
                blockMutation.mutate({
                  contactId,
                  jid: conversation.contactJid,
                  waSessionId: conversation.waSessionId,
                  blocked: !conversation.contactBlocked,
                })
              }
              className={`flex size-6 items-center justify-center rounded hover:bg-muted ${
                conversation.contactBlocked
                  ? "text-destructive"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {conversation.contactBlocked ? (
                <ShieldCheckIcon className="size-3.5" />
              ) : (
                <BanIcon className="size-3.5" />
              )}
            </button>
          )}
        </div>
        {conversation.contactBlocked && (
          <Badge variant="destructive" className="text-[10px]">
            Blocked
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {conversation.contactPhone ?? conversation.contactJid?.split("@")[0]}
        </span>
        {conversation.contactAbout && (
          <span
            className="max-w-full truncate text-xs text-muted-foreground italic"
            title={conversation.contactAbout}
          >
            &ldquo;{conversation.contactAbout}&rdquo;
          </span>
        )}
        {conversation.sessionLabel && (
          <Badge variant="outline" className="mt-1">
            {conversation.sessionLabel}
          </Badge>
        )}
        {contactId && (
          <div className="flex w-full flex-col gap-2 text-left">
            <Label>Assigned to</Label>
            <Select
              value={conversation.contactAssignedTo ?? (conversation.contactAssignedTeamId ? `team:${conversation.contactAssignedTeamId}` : "unassigned")}
              onValueChange={(value) => value && assignMutation.mutate({
                assignedTo: value === "unassigned" || value.startsWith("team:") ? null : value,
                assignedTeamId: value.startsWith("team:") ? value.slice(5) : null,
              })}
            >
              <SelectTrigger>
              <SelectValue>{assignmentLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {(teamsQuery.data ?? []).map((team) => (
                  <SelectItem key={team.id} value={`team:${team.id}`}>Team: {team.name}</SelectItem>
                ))}
                {(membersQuery.data ?? []).map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>{member.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {contactId && conversation.contactJid && (
          <button
            type="button"
            disabled={refreshProfile.isPending}
            onClick={() =>
              refreshProfile.mutate({
                contactId,
                waSessionId: conversation.waSessionId,
                jid: conversation.contactJid!,
              })
            }
            className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            <RefreshCwIcon
              className={`size-3 ${refreshProfile.isPending ? "animate-spin" : ""}`}
            />
            {refreshProfile.isPending ? "Refreshing…" : "Refresh photo & about"}
          </button>
        )}
      </div>

      <Separator />

      {onConvertToDeal && (
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={onConvertToDeal}
          disabled={convertingToDeal}
        >
          {convertingToDeal ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <TrendingUpIcon className="size-4" />
          )}
          Convert to deal
        </Button>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="panel-contact-name">Name</Label>
        <div className="flex gap-2">
          <Input
            id="panel-contact-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={
              !contactId ||
              saveNameMutation.isPending ||
              name.trim() === (conversation.contactName ?? "")
            }
            onClick={() => contactId && saveNameMutation.mutate(name.trim())}
          >
            Save
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Lifecycle stage</Label>
        <Select
          value={conversation.contactLifecycleStage ?? "lead"}
          onValueChange={(v) => v && contactId && stageMutation.mutate(v)}
        >
          <SelectTrigger>
            <SelectValue>
              {(v) =>
                typeof v === "string" && v
                  ? v.charAt(0).toUpperCase() + v.slice(1)
                  : ""
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STAGES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {conversation.contactJid && (
        <div className="flex flex-col gap-2">
          <Label className="flex items-center gap-1.5">
            <TimerIcon className="size-3.5" /> Disappearing messages
          </Label>
          <Select
            value={disappearing}
            onValueChange={(v) => {
              if (!v) return
              setDisappearing(v)
              disappearingMutation.mutate(Number(v))
            }}
          >
            <SelectTrigger>
              <SelectValue>{DISAPPEARING_LABELS[disappearing] ?? "Off"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Off</SelectItem>
              <SelectItem value="86400">24 hours</SelectItem>
              <SelectItem value="604800">7 days</SelectItem>
              <SelectItem value="7776000">90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {tagsQuery.data && tagsQuery.data.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label>Tags</Label>
          <div className="flex flex-wrap gap-1">
            {tagsQuery.data.map((t) => (
              <Badge key={t.tagId} variant="outline">
                {t.tagName}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {contactId && (
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          className="justify-start gap-2 text-muted-foreground"
          render={<Link to="/contacts" />}
        >
          <ExternalLinkIcon className="size-3.5" />
          View full contact record
        </Button>
      )}

      <Separator />

      <div className="flex flex-col gap-2">
        <Label className="flex items-center gap-1.5">
          <StickyNoteIcon className="size-3.5" /> Notes
        </Label>
        <div className="flex flex-col gap-2">
          <Textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Add a note about this contact…"
            className="min-h-16"
          />
          <Button
            size="sm"
            className="self-end"
            disabled={
              !contactId || !noteText.trim() || addNoteMutation.isPending
            }
            onClick={() => contactId && addNoteMutation.mutate(noteText.trim())}
          >
            Add note
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          {noteItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No notes yet.</p>
          ) : (
            noteItems.map((n) => (
              <div
                key={n.id}
                className="rounded-xl border border-border bg-muted/40 p-2.5 text-sm"
              >
                <p className="break-words whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {new Date(n.createdAt).toLocaleString()}
                </p>
              </div>
            ))
          )}
          <LoadMoreButton
            hasMore={!!notesQuery.hasNextPage}
            shown={shownOf(notesQuery.data)}
            total={totalOf(notesQuery.data)}
            loading={notesQuery.isFetchingNextPage}
            onLoadMore={() => notesQuery.fetchNextPage()}
            label="Older notes"
          />
        </div>
      </div>
    </div>
  )
}
