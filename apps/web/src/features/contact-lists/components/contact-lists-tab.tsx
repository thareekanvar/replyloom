import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Panel } from "@workspace/ui/components/panel"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import {
  ArchiveIcon,
  ChevronRightIcon,
  EllipsisVerticalIcon,
  ListChecksIcon,
  SearchIcon,
  SearchXIcon,
  UsersIcon,
} from "lucide-react"
import { TableSkeleton } from "@/components/skeletons"
import { CreateListSheet } from "./create-list-sheet"
import { ListDetailSheet } from "./list-detail-sheet"
import { archiveContactList, getContactLists } from "../hooks/use-contact-lists"

type ContactList = Awaited<ReturnType<typeof getContactLists>>[number]

export function ContactListsTab({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [openListId, setOpenListId] = useState<string | null>(null)
  const [archiving, setArchiving] = useState<ContactList | null>(null)

  const { data: lists = [], isLoading } = useQuery({
    queryKey: ["contact-lists", workspaceId],
    queryFn: () => getContactLists({ data: { workspaceId } }),
  })

  const archiveMutation = useMutation({
    mutationFn: archiveContactList,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contact-lists", workspaceId] })
      setArchiving(null)
      toast.success("List archived")
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't archive the list."),
  })

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q ? lists.filter((l) => l.name.toLowerCase().includes(q)) : lists
    // Active lists first, archived ones sink to the bottom.
    return [...filtered].sort(
      (a, b) => Number(a.status === "archived") - Number(b.status === "archived")
    )
  }, [lists, search])

  const openList = lists.find((l) => l.id === openListId) ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search lists..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-72 ps-8"
            aria-label="Search lists"
          />
        </div>
        <CreateListSheet workspaceId={workspaceId} onCreated={(id) => setOpenListId(id)} />
      </div>

      {isLoading ? (
        <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TableSkeleton rows={6} columns={5} />
        </Panel>
      ) : (
        <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Table containerClassName="min-h-0 flex-1 overflow-auto">
            <TableHeader className="sticky top-0 z-10 bg-muted">
              <TableRow>
                <TableHead>List</TableHead>
                <TableHead className="text-right">Approved</TableHead>
                <TableHead className="text-right">Disabled</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-48 text-center">
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          {search ? <SearchXIcon /> : <ListChecksIcon />}
                        </EmptyMedia>
                        <EmptyTitle>{search ? "No matching lists" : "No contact lists yet"}</EmptyTitle>
                        <EmptyDescription>
                          {search
                            ? `Nothing matches "${search}".`
                            : "Broadcasts can only target a list. Create one to get started."}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((l) => {
                  const archived = l.status === "archived"
                  const usable = !l.usableAfter || new Date(l.usableAfter) <= new Date()
                  return (
                    <TableRow
                      key={l.id}
                      className={`group cursor-pointer ${archived ? "opacity-60" : ""}`}
                      onClick={() => setOpenListId(l.id)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                            <UsersIcon className="size-3.5 text-muted-foreground" />
                          </div>
                          <div>
                            <div className="font-medium group-hover:underline">{l.name}</div>
                            <div className="text-xs capitalize text-muted-foreground">
                              {l.kind === "smart" ? "Smart · rule-based" : "Static · manual"}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.stats.owned}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {l.stats.disabled}
                      </TableCell>
                      <TableCell>
                        {archived ? (
                          <Badge variant="secondary">Archived</Badge>
                        ) : usable ? (
                          <Badge variant="outline">Ready</Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            title={`Usable after ${new Date(l.usableAfter!).toLocaleString()}`}
                          >
                            Aging
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(l.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {!archived && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-8 text-muted-foreground"
                                    aria-label="List actions"
                                  />
                                }
                              >
                                <EllipsisVerticalIcon />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-40">
                                <DropdownMenuItem onClick={() => setOpenListId(l.id)}>
                                  <UsersIcon /> Manage members
                                </DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" onClick={() => setArchiving(l)}>
                                  <ArchiveIcon /> Archive
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                          <ChevronRightIcon className="size-4 text-muted-foreground" />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </Panel>
      )}

      <ListDetailSheet
        workspaceId={workspaceId}
        list={openList}
        onOpenChange={(open) => !open && setOpenListId(null)}
      />

      <AlertDialog open={!!archiving} onOpenChange={(open) => !open && setArchiving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archiving?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Archived lists can&rsquo;t be targeted by new broadcasts. Existing campaigns aren&rsquo;t affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveMutation.isPending}
              onClick={() =>
                archiving && archiveMutation.mutate({ data: { workspaceId, listId: archiving.id } })
              }
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
