// `onError`'s `err` is typed `Error`, but createServerFn's RPC
// boundary doesn't actually guarantee that shape survives the
// round trip -- keep the `err?.message ?? fallback` defensive
// reads below rather than trust the annotation blindly.
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { createFileRoute, useRouteContext } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { toast } from "sonner"
import {
  getWorkspaceSettings,
  getWebhooks,
  createWebhook,
  toggleWebhook,
  deleteWebhook,
} from "@/features/settings/hooks/use-settings"
import { WebhookList } from "@/features/settings/components/webhook-list"
import {
  CreateWebhookDialog
  
} from "@/features/settings/components/create-webhook-dialog"
import type {CreateWebhookInput} from "@/features/settings/components/create-webhook-dialog";
import {
  getRoles,
  createRole,
  updateRole,
  deleteRole,
  getMembers,
  updateMemberRole,
  removeMember,
  getInvitations,
  inviteMember,
  cancelInvitation,
  PERMISSIONS,
  getTeams,
  createTeam,
  setTeamMembers,
} from "@/features/team/hooks/use-team"
import { MembersList } from "@/features/team/components/members-list"
import { RolesList } from "@/features/team/components/roles-list"
import { InviteMemberDialog } from "@/features/team/components/invite-member-dialog"
import { InvitationsList } from "@/features/team/components/invitations-list"
import { TeamsList } from "@/features/team/components/teams-list"
import { Panel } from "@workspace/ui/components/panel"
import {
  TableSkeleton,
  AvatarListSkeleton,
  CardGridSkeleton,
} from "@/components/skeletons"

// Workspace-level settings only (name, team, webhooks). Personal settings
// -- profile, notifications -- live at /account instead, reached from the
// user menu, not from here: this page is about the workspace, not any one
// person in it.
export const Route = createFileRoute("/_app/settings")({
  staticData: { title: "Settings" },
  validateSearch: (search: Record<string, unknown>): { tab?: "workspace" | "team" | "webhooks" } => {
    const tab = search.tab
    return tab === "team" || tab === "webhooks" ? { tab } : {}
  },
  component: SettingsPage,
})

function SettingsPage() {
  const { workspaceId, user } = useRouteContext({
    from: "/_app",
  })
  const queryClient = useQueryClient()
  const { tab: requestedTab } = Route.useSearch()
  const [tab, setTab] = useState<"workspace" | "team" | "webhooks">(requestedTab ?? "workspace")
  useEffect(() => {
    if (requestedTab) setTab(requestedTab)
  }, [requestedTab])

  const workspaceQuery = useQuery({
    queryKey: ["workspace-settings", workspaceId],
    queryFn: () => getWorkspaceSettings({ data: { workspaceId } }),
    staleTime: 60_000,
  })

  const webhooksQuery = useQuery({
    queryKey: ["webhooks", workspaceId],
    queryFn: () => getWebhooks({ data: { workspaceId } }),
    staleTime: 15_000,
  })

  const membersQuery = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () => getMembers({ data: { workspaceId } }),
    staleTime: 15_000,
  })

  const rolesQuery = useQuery({
    queryKey: ["roles", workspaceId],
    queryFn: () => getRoles({ data: { workspaceId } }),
    staleTime: 15_000,
  })
  const teamsQuery = useQuery({
    queryKey: ["teams", workspaceId],
    queryFn: () => getTeams({ data: { workspaceId } }),
  })

  const invitationsQuery = useQuery({
    queryKey: ["invitations", workspaceId],
    queryFn: () => getInvitations({ data: { workspaceId } }),
    staleTime: 15_000,
  })

  const createRoleMutation = useMutation({
    mutationFn: (data: {
      name: string
      description: string
      permissions: string[]
    }) => createRole({ data: { workspaceId, ...data } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["roles", workspaceId] })
      toast.success("Role created")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't create the role."),
  })

  const updateRoleMutation = useMutation({
    mutationFn: (vars: {
      roleId: string
      name: string
      description: string
      permissions: string[]
    }) => updateRole({ data: { workspaceId, ...vars } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["roles", workspaceId] })
      toast.success("Role updated")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't update the role."),
  })

  const deleteRoleMutation = useMutation({
    mutationFn: (roleId: string) =>
      deleteRole({ data: { roleId, workspaceId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["roles", workspaceId] })
      toast.success("Role deleted")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't delete the role."),
  })

  const updateMemberRoleMutation = useMutation({
    mutationFn: (vars: { memberId: string; role: string }) =>
      updateMemberRole({ data: { workspaceId, ...vars } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", workspaceId] })
      toast.success("Role updated")
    },
  })

  const createTeamMutation = useMutation({
    mutationFn: (name: string) => createTeam({ data: { workspaceId, name } }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["teams", workspaceId] }); toast.success("Team created") },
  })
  const saveTeamMembersMutation = useMutation({
    mutationFn: (vars: { teamId: string; userIds: string[] }) => setTeamMembers({ data: { workspaceId, ...vars } }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["teams", workspaceId] }); toast.success("Team members updated") },
  })

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) => removeMember({ data: { workspaceId, memberId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", workspaceId] })
      toast.success("Member removed")
    },
  })

  const inviteMemberMutation = useMutation({
    mutationFn: (vars: { email: string; role: string }) =>
      inviteMember({ data: { workspaceId, inviterId: user.id, ...vars } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations", workspaceId] })
      toast.success("Invitation sent")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't send the invitation."),
  })

  const cancelInvitationMutation = useMutation({
    mutationFn: (invitationId: string) =>
      cancelInvitation({ data: { workspaceId, invitationId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations", workspaceId] })
      toast.success("Invitation canceled")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't cancel the invitation."),
  })

  const createWebhookMutation = useMutation({
    mutationFn: (data: CreateWebhookInput) =>
      createWebhook({ data: { workspaceId, ...data } }),
    onSuccess: (webhook) => {
      queryClient.invalidateQueries({ queryKey: ["webhooks", workspaceId] })
      toast.success("Webhook created", {
        description: `Signing secret (shown once): ${webhook.secret}`,
        duration: 15000,
        action: {
          label: "Copy",
          onClick: () => {
            navigator.clipboard.writeText(webhook.secret)
            toast.success("Signing secret copied")
          },
        },
      })
    },
    onError: (err: Error) =>
      toast.error(err?.message ?? "Couldn't create the webhook."),
  })

  const toggleWebhookMutation = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      toggleWebhook({ data: vars }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["webhooks", workspaceId] }),
    onError: (err: Error) =>
      toast.error(err?.message ?? "Couldn't update the webhook."),
  })

  const deleteWebhookMutation = useMutation({
    mutationFn: (id: string) => deleteWebhook({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks", workspaceId] })
      toast.success("Webhook deleted")
    },
    onError: (err: Error) =>
      toast.error(err?.message ?? "Couldn't delete the webhook."),
  })

  return (
    <div className="flex flex-1 flex-col gap-4">
      <Tabs value={tab} onValueChange={(value) => setTab(value ?? "workspace")}>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="workspace" className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold">
              {workspaceQuery.data?.workspace?.name ?? "Workspace"}
            </h2>
            <p className="text-sm text-muted-foreground">
              Basic details for this workspace. Manage who has access and what
              they can do from the Team tab.
            </p>
          </div>
          <Panel className="divide-y divide-border">
            <div className="flex items-center justify-between gap-3 p-5">
              <span className="text-sm text-muted-foreground">Name</span>
              <span className="text-sm font-medium">
                {workspaceQuery.data?.workspace?.name ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 p-5">
              <span className="text-sm text-muted-foreground">Members</span>
              <span className="text-sm font-medium">
                {membersQuery.data?.length ?? 0}
              </span>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="team" className="flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Team</h2>
              <p className="text-sm text-muted-foreground">
                Invite teammates and control what each role can do.
              </p>
            </div>
            <InviteMemberDialog
              roles={rolesQuery.data ?? []}
              onInvite={(email, role) =>
                inviteMemberMutation.mutateAsync({ email, role })
              }
            />
          </div>

          {invitationsQuery.isLoading ? (
            <Panel>
              <AvatarListSkeleton rows={2} withAvatar={false} />
            </Panel>
          ) : (
            <InvitationsList
              invitations={invitationsQuery.data ?? []}
              onCancel={(id) => cancelInvitationMutation.mutate(id)}
            />
          )}

          <div className="flex flex-col gap-2">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              Members
            </p>
            <Panel>
              {membersQuery.isLoading ? (
                <AvatarListSkeleton rows={3} />
              ) : (
                <MembersList
                  members={membersQuery.data ?? []}
                  roles={rolesQuery.data ?? []}
                  currentUserId={user.id}
                  onChangeRole={(memberId, role) =>
                    updateMemberRoleMutation.mutate({ memberId, role })
                  }
                  onRemove={(memberId) => removeMemberMutation.mutate(memberId)}
                />
              )}
            </Panel>
          </div>

          <div className="flex flex-col gap-2">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              Roles
            </p>
            {rolesQuery.isLoading ? (
              <CardGridSkeleton count={4} columns="sm:grid-cols-2" />
            ) : (
              <RolesList
                roles={rolesQuery.data ?? []}
                permissions={PERMISSIONS}
                onCreate={(values) => createRoleMutation.mutate(values)}
                onUpdate={(roleId, values) =>
                  updateRoleMutation.mutate({ roleId, ...values })
                }
                onDelete={(roleId) => deleteRoleMutation.mutate(roleId)}
              />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              Assignment teams
            </p>
            <TeamsList
              teams={teamsQuery.data ?? []}
              members={membersQuery.data ?? []}
              onCreate={(name) => createTeamMutation.mutate(name)}
              onSaveMembers={(teamId, userIds) => saveTeamMembersMutation.mutate({ teamId, userIds })}
            />
          </div>
        </TabsContent>

        <TabsContent value="webhooks" className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Webhooks</h2>
              <p className="text-sm text-muted-foreground">
                Get signed HTTP callbacks for message events.
              </p>
            </div>
            <CreateWebhookDialog
              onCreate={(data) => createWebhookMutation.mutateAsync(data)}
            />
          </div>
          <Panel>
            {webhooksQuery.isLoading ? (
              <TableSkeleton rows={4} columns={4} />
            ) : (
              <WebhookList
                webhooks={webhooksQuery.data ?? []}
                onToggle={(id, enabled) =>
                  toggleWebhookMutation.mutate({ id, enabled })
                }
                onDelete={(id) => deleteWebhookMutation.mutate(id)}
              />
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* eslint-enable @typescript-eslint/no-unnecessary-condition */
