import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Panel } from "@workspace/ui/components/panel"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"
import {
  getMyWorkspaces,
  createWorkspace,
  switchWorkspace,
} from "@/features/workspaces/hooks/use-workspaces"
import { CreateWorkspaceDialog } from "./create-workspace-dialog"
import { AvatarListSkeleton } from "@/components/skeletons"

function workspaceInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

export function WorkspacesPanel() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)

  const { data: workspaces, isLoading } = useQuery({
    queryKey: ["my-workspaces"],
    queryFn: () => getMyWorkspaces(),
    staleTime: 30_000,
  })

  const switchMutation = useMutation({
    mutationFn: (organizationId: string) =>
      switchWorkspace({ data: { organizationId } }),
    onSuccess: () => {
      window.location.href = "/inbox"
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't switch workspaces."),
  })

  const createMutation = useMutation({
    mutationFn: (name: string) => createWorkspace({ data: { name } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-workspaces"] })
      setCreateOpen(false)
      toast.success("Workspace created")
      window.location.href = "/inbox"
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't create the workspace."),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Workspaces</h2>
          <p className="text-sm text-muted-foreground">
            Switch between workspaces you belong to, or start a new one.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon />
          Create workspace
        </Button>
      </div>

      {isLoading ? (
        <Panel className="p-5">
          <AvatarListSkeleton rows={2} />
        </Panel>
      ) : (
        <Panel className="divide-y divide-border">
          {(workspaces ?? []).map((ws) => (
            <div
              key={ws.id}
              className="flex items-center justify-between gap-3 p-5"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold">
                  {workspaceInitials(ws.name)}
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{ws.name}</span>
                  <span className="text-xs text-muted-foreground capitalize">
                    {ws.role}
                  </span>
                </div>
              </div>
              {ws.active ? (
                <Badge variant="secondary">Active</Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => switchMutation.mutate(ws.id)}
                  disabled={switchMutation.isPending}
                >
                  Switch to this
                </Button>
              )}
            </div>
          ))}
        </Panel>
      )}

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={createMutation.isPending}
        onCreate={(name) => createMutation.mutate(name)}
      />
    </div>
  )
}
