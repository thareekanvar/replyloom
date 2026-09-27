import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  FlexRender,
  tableFeatures,
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  useTable
  
  
  
} from "@tanstack/react-table"
import type {ColumnFiltersState, ColumnVisibilityState, SortingState} from "@tanstack/react-table";
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Input } from "@workspace/ui/components/input"
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
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
  AlertDialogAction,
} from "@workspace/ui/components/alert-dialog"
import { toast } from "sonner"
import {
  EllipsisVerticalIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PinIcon,
  PinOffIcon,
  MessageSquareIcon,
  PencilIcon,
  TrashIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
  BanIcon,
  ShieldCheckIcon, UsersIcon, ListPlusIcon, Trash2Icon
} from "lucide-react"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import {
  setContactPinned,
  deleteContact,
  bulkDeleteContacts,
} from "../hooks/use-contacts"
import { useBlockContact } from "../hooks/use-block-contact"
import { ContactDetailSheet  } from "./contact-detail-sheet"
import type {ContactSummary} from "./contact-detail-sheet";
import { BulkImportDialog } from "./bulk-import-dialog"
import { AddContactDialog } from "./add-contact-dialog"
import {
  addContactsToList,
  getContactLists,
} from "@/features/contact-lists/hooks/use-contact-lists"
import { Panel } from "@workspace/ui/components/panel"
import { TableSkeleton } from "@/components/skeletons"
import { useNavigate } from "@tanstack/react-router"
import { shouldFetchNextPage } from "@/lib/pagination"
import { formatTotal } from "@/lib/format-count"

interface Contact {
  id: string
  name: string | null
  phoneNumber: string | null
  jid: string
  lifecycleStage: string
  assignedTo: string | null
  lastContactedAt: number | null
  createdAt: number
  avatarUrl: string | null
  pinnedAt: number | null
  blocked: boolean
  conversationId: string | null
  waSessionId: string
  sessionLabel: string | null
}

const features = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
})

const columnHelper = createColumnHelper<typeof features, Contact>()

export function ContactsTable({
  data,
  workspaceId,
  isLoading,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  searchQuery,
  onSearchQueryChange,
  total,
}: {
  data: Contact[]
  workspaceId: string
  isLoading?: boolean
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
  /** Controlled + applied server-side by the parent (getContactsPage q). */
  searchQuery: string
  onSearchQueryChange: (q: string) => void
  /** Exact total from the server (first page), for "Page X of Y". */
  total?: { total: number; capped: boolean } | null
}) {
  const [rowSelection, setRowSelection] = useState({})
  const [columnVisibility, setColumnVisibility] =
    useState<ColumnVisibilityState>({})
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [sorting, setSorting] = useState<SortingState>([])
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 })
  const setSearchQuery = onSearchQueryChange
  const [editingContact, setEditingContact] = useState<ContactSummary | null>(
    null
  )
  const [deletingContact, setDeletingContact] = useState<Contact | null>(null)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Contact[]>([])
  const [pendingNextPage, setPendingNextPage] = useState(false)
  const previousDataLength = useRef(data.length)

  const queryClient = useQueryClient()
  const navigate = useNavigate()

  useEffect(() => {
    if (pendingNextPage && data.length > previousDataLength.current) {
      setPendingNextPage(false)
      setPagination((current) => ({
        ...current,
        pageIndex: current.pageIndex + 1,
      }))
    }
    previousDataLength.current = data.length
  }, [data.length, pendingNextPage])

  function handleNextPage() {
    if (table.getCanNextPage()) {
      table.nextPage()
      return
    }
    if (
      shouldFetchNextPage(table.getCanNextPage(), hasMore) &&
      onLoadMore &&
      !isLoadingMore
    ) {
      setPendingNextPage(true)
      onLoadMore()
    }
  }

  function invalidateContacts() {
    queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
  }

  const pinMutation = useMutation({
    mutationFn: (vars: { contactId: string; pinned: boolean }) =>
      setContactPinned({ data: vars }),
    onSuccess: invalidateContacts,
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't update the contact pin."),
  })

  const blockMutation = useBlockContact(workspaceId)

  const deleteMutation = useMutation({
    mutationFn: (contactId: string) => deleteContact({ data: { contactId } }),
    onSuccess: () => {
      invalidateContacts()
      setDeletingContact(null)
      toast.success("Contact deleted")
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't delete the contact."),
  })

  const bulkDeleteMutation = useMutation({
    mutationFn: (contactIds: string[]) =>
      bulkDeleteContacts({ data: { contactIds } }),
    onSuccess: (result) => {
      invalidateContacts()
      setRowSelection({})
      setBulkDeleteOpen(false)
      setPendingDelete([])
      toast.success(
        `Deleted ${result.count} contact${result.count === 1 ? "" : "s"}`
      )
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't delete the selected contacts."),
  })

  // Broadcasting straight from a contact selection is intentionally not
  // possible (anti-spam) -- selected contacts can only be added to a
  // static list, which then goes through aging/ownership/cooldown/ceiling
  // before any campaign can target it.
  const { data: contactLists = [] } = useQuery({
    queryKey: ["contact-lists", workspaceId],
    queryFn: () => getContactLists({ data: { workspaceId } }),
    staleTime: 30_000,
  })
  const staticLists = contactLists.filter(
    (l) => l.kind === "static" && l.status !== "archived"
  )

  const addToListMutation = useMutation({
    mutationFn: (vars: { listId: string; listName: string; contactIds: string[] }) =>
      addContactsToList({
        data: { workspaceId, listId: vars.listId, contactIds: vars.contactIds },
      }),
    onSuccess: (res, vars) => {
      queryClient.invalidateQueries({ queryKey: ["contact-lists", workspaceId] })
      queryClient.invalidateQueries({
        queryKey: ["contact-list-members", workspaceId, vars.listId],
      })
      setRowSelection({})
      if (res.skipped > 0) {
        toast.warning(
          `Added ${res.added} to ${vars.listName}. Skipped ${res.skipped} with no existing conversation.`
        )
      } else {
        toast.success(`Added ${res.added} to ${vars.listName}`)
      }
    },
    onError: (err: any) =>
      toast.error(err?.message ?? "Couldn't add contacts to the list."),
  })

  const columns = columnHelper.columns([
    columnHelper.display({
      id: "select",
      header: ({ table }) => (
        <div className="flex items-center justify-center">
          <Checkbox
            checked={table.getIsAllPageRowsSelected()}
            indeterminate={
              table.getIsSomePageRowsSelected() &&
              !table.getIsAllPageRowsSelected()
            }
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(!!value)
            }
            aria-label="Select all"
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Select row"
          />
        </div>
      ),
      enableSorting: false,
      enableHiding: false,
    }),
    columnHelper.display({
      id: "pin",
      header: "",
      cell: ({ row }) => {
        const pinned = !!row.original.pinnedAt
        return (
          <button
            type="button"
            aria-label={pinned ? "Unpin contact" : "Pin contact"}
            onClick={() =>
              pinMutation.mutate({
                contactId: row.original.id,
                pinned: !pinned,
              })
            }
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {pinned ? (
              <PinIcon className="size-3.5 fill-current" />
            ) : (
              <PinIcon className="size-3.5 opacity-30" />
            )}
          </button>
        )
      },
      enableSorting: false,
      enableHiding: false,
    }),
    columnHelper.accessor("name", {
      header: "Name",
      cell: ({ row }) => (
        <button
          type="button"
          className="flex items-center gap-2 text-left"
          onClick={() => setEditingContact(row.original)}
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
            {row.original.avatarUrl ? (
              <img
                src={row.original.avatarUrl}
                alt=""
                className="size-8 rounded-full object-cover"
              />
            ) : (
              (row.original.name ?? row.original.phoneNumber ?? "??")
                .split(" ")
                .map((w: string) => w[0])
                .join("")
                .slice(0, 2)
                .toUpperCase()
            )}
          </div>
          <div>
            <div className="flex items-center gap-1.5 font-medium hover:underline">
              {row.original.name ?? "Unknown"}
              {row.original.blocked && (
                <Badge variant="destructive" className="text-[10px] px-1 py-0">
                  Blocked
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {row.original.phoneNumber ?? row.original.jid.split("@")[0]}
            </div>
          </div>
        </button>
      ),
    }),
    columnHelper.accessor("lifecycleStage", {
      header: "Stage",
      cell: ({ row }) => {
        const stage = row.original.lifecycleStage
        const variant =
          stage === "customer"
            ? "default"
            : stage === "active"
              ? "secondary"
              : "outline"
        return (
          <Badge variant={variant} className="capitalize">
            {stage}
          </Badge>
        )
      },
    }),
    columnHelper.accessor("sessionLabel", {
      header: "Integration",
      cell: ({ row }) => {
        const label = row.original.sessionLabel
        return label ? (
          <Badge variant="outline">{label}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    }),
    columnHelper.accessor("lastContactedAt", {
      header: "Last Contacted",
      cell: ({ row }) => {
        const ts = row.original.lastContactedAt
        if (!ts) return <span className="text-muted-foreground">Never</span>
        return new Date(ts * 1000).toLocaleDateString()
      },
    }),
    columnHelper.display({
      id: "actions",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className="flex size-8 text-muted-foreground"
                size="icon"
              />
            }
          >
            <EllipsisVerticalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setEditingContact(row.original)}>
              <PencilIcon /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!row.original.conversationId}
              onClick={() =>
                row.original.conversationId &&
                navigate({
                  to: "/inbox",
                  search: { conversationId: row.original.conversationId },
                })
              }
            >
              <MessageSquareIcon /> View conversation
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                pinMutation.mutate({
                  contactId: row.original.id,
                  pinned: !row.original.pinnedAt,
                })
              }
            >
              {row.original.pinnedAt ? <PinOffIcon /> : <PinIcon />}
              {row.original.pinnedAt ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                blockMutation.mutate({
                  contactId: row.original.id,
                  jid: row.original.jid,
                  waSessionId: row.original.waSessionId,
                  blocked: !row.original.blocked,
                })
              }
            >
              {row.original.blocked ? <ShieldCheckIcon /> : <BanIcon />}
              {row.original.blocked ? "Unblock" : "Block"}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeletingContact(row.original)}
            >
              <TrashIcon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    }),
  ])

  // Already filtered by the server for `searchQuery`.
  const filteredData = data

  const table = useTable({
    features,
    data: filteredData,
    columns,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
      pagination,
    },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    // Server pagination appends the next batch to `data`. Keep the current
    // table page when that happens; otherwise TanStack resets to page 1.
    autoResetPageIndex: false,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
  })

  const selectedRows = table.getFilteredSelectedRowModel().rows
  const selectedContacts = selectedRows.map((r) => r.original)

  const searching = searchQuery.trim().length > 0
  // Real page count from the server's exact total -- the table itself only
  // knows the pages loaded so far ("Page 2 of 2").
  const pageSize = table.state.pagination.pageSize
  const totalPages = total
    ? Math.max(1, Math.ceil(total.total / pageSize), table.getPageCount())
    : table.getPageCount()
  const totalPagesLabel = `${totalPages.toLocaleString()}${total?.capped ? "+" : ""}`
  const hasNoContacts = data.length === 0 && !searching
  const noMatches = data.length === 0 && searching

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search name, phone, or JID..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                setPagination((p) => ({ ...p, pageIndex: 0 }))
              }}
              className="h-8 w-72 ps-8"
              aria-label="Search contacts"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                className="absolute end-2 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </div>
          {selectedRows.length > 0 && (
            <div className="flex items-center gap-2 border-l pl-2">
              <span className="text-xs text-muted-foreground">
                {selectedRows.length} selected
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={addToListMutation.isPending}
                    />
                  }
                >
                  <ListPlusIcon />
                  <span className="hidden lg:inline">Add to list</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuGroup>
                  <DropdownMenuLabel>Add to static list</DropdownMenuLabel>
                  {staticLists.length === 0 ? (
                    <DropdownMenuItem
                      onClick={() =>
                        navigate({ to: "/contacts", search: { tab: "lists" } })
                      }
                    >
                      No lists yet — create one
                    </DropdownMenuItem>
                  ) : (
                    staticLists.map((l) => (
                      <DropdownMenuItem
                        key={l.id}
                        onClick={() =>
                          addToListMutation.mutate({
                            listId: l.id,
                            listName: l.name,
                            contactIds: selectedContacts.map((c) => c.id),
                          })
                        }
                      >
                        {l.name}
                      </DropdownMenuItem>
                    ))
                  )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPendingDelete(selectedContacts)
                  setBulkDeleteOpen(true)
                }}
              >
                <Trash2Icon />
                <span className="hidden lg:inline">Delete</span>
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <BulkImportDialog workspaceId={workspaceId} />
          <AddContactDialog workspaceId={workspaceId} />
        </div>
      </div>
      {isLoading ? (
        <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TableSkeleton rows={8} columns={6} />
        </Panel>
      ) : (
        <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Table containerClassName="min-h-0 flex-1 overflow-auto">
            <TableHeader className="sticky top-0 z-10 bg-muted">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} colSpan={header.colSpan}>
                      {header.isPlaceholder ? null : (
                        <FlexRender header={header} />
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() && "selected"}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-48 text-center"
                  >
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          {noMatches ? <SearchXIcon /> : <UsersIcon />}
                        </EmptyMedia>
                        <EmptyTitle>
                          {hasNoContacts
                            ? "No contacts yet"
                            : "No matching contacts"}
                        </EmptyTitle>
                        <EmptyDescription>
                          {hasNoContacts
                            ? "Messages from WhatsApp will create contacts automatically."
                            : `Nothing matches "${searchQuery}". Try a name, phone number, or JID.`}
                        </EmptyDescription>
                      </EmptyHeader>
                      {noMatches && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => setSearchQuery("")}
                        >
                          Clear search
                        </Button>
                      )}
                    </Empty>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Panel>
      )}

      <div className="flex shrink-0 items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {selectedRows.length > 0
            ? `${selectedRows.length.toLocaleString()} selected · `
            : ""}
          {total
            ? `${formatTotal(total.total, total.capped)} ${searching ? "match" : "contact"}${total.total === 1 && !total.capped ? "" : searching ? "es" : "s"}`
            : `${table.getFilteredRowModel().rows.length.toLocaleString()} loaded`}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
          >
            <ChevronLeftIcon />
          </Button>
          <span className="text-sm">
            Page {(table.state.pagination.pageIndex + 1).toLocaleString()} of{" "}
            {totalPagesLabel}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={handleNextPage}
            disabled={isLoadingMore || (!table.getCanNextPage() && !hasMore)}
            aria-label="Next page"
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      <ContactDetailSheet
        contact={editingContact}
        workspaceId={workspaceId}
        onOpenChange={(open) => !open && setEditingContact(null)}
      />

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete.length} contact
              {pendingDelete.length === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes these contacts along with their
              conversations, messages and notes. This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkDeleteMutation.isPending}
              onClick={() =>
                bulkDeleteMutation.mutate(pendingDelete.map((c) => c.id))
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!deletingContact}
        onOpenChange={(open) => !open && setDeletingContact(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deletingContact?.name ?? "this contact"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the contact along with their
              conversation, messages and notes. This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() =>
                deletingContact && deleteMutation.mutate(deletingContact.id)
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
