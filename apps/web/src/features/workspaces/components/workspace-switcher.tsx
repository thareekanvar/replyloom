import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import { ChevronsUpDownIcon, CheckIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"
import {
  getMyWorkspaces,
  createWorkspace,
  switchWorkspace,
} from "@/features/workspaces/hooks/use-workspaces"
import { CreateWorkspaceDialog } from "./create-workspace-dialog"

function workspaceInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

export function WorkspaceSwitcher({ fallbackName }: { fallbackName: string }) {
  const { isMobile } = useSidebar()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)

  const { data: workspaces } = useQuery({
    queryKey: ["my-workspaces"],
    queryFn: () => getMyWorkspaces(),
    staleTime: 30_000,
  })

  const switchMutation = useMutation({
    mutationFn: (organizationId: string) =>
      switchWorkspace({ data: { organizationId } }),
    onSuccess: () => {
      // workspaceId is baked into the router's beforeLoad context (see
      // routes/_app.tsx) -- a full reload is the simplest way to pick up
      // the switch everywhere (sidebar, inbox, contacts, all of it).
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

  const active = workspaces?.find((w) => w.active)
  const displayName = active?.name ?? fallbackName

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="aria-expanded:bg-sidebar-accent data-[slot=sidebar-menu-button]:p-1.5!"
                />
              }
            >
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                {workspaceInitials(displayName)}
              </div>
              <span className="truncate text-base font-semibold">
                {displayName}
              </span>
              <ChevronsUpDownIcon className="ms-auto size-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-64"
              side={isMobile ? "bottom" : "right"}
              align="start"
              sideOffset={4}
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Your workspaces
                </DropdownMenuLabel>
                {(workspaces ?? []).map((ws) => (
                  <DropdownMenuItem
                    key={ws.id}
                    onClick={() => !ws.active && switchMutation.mutate(ws.id)}
                    disabled={switchMutation.isPending}
                  >
                    <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold">
                      {workspaceInitials(ws.name)}
                    </div>
                    <span className="flex-1 truncate">{ws.name}</span>
                    {ws.active && <CheckIcon className="size-4 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                  <PlusIcon />
                  Create workspace
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={createMutation.isPending}
        onCreate={(name) => createMutation.mutate(name)}
      />
    </>
  )
}
