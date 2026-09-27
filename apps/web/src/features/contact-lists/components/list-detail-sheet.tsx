import { useMemo, useState } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LoadMoreButton } from "@/components/load-more-button"
import { toast } from "sonner"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import {
  ArrowRightLeftIcon,
  ClockIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { searchContacts } from "@/features/contacts/hooks/use-contacts"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import {
  addContactsToList,
  getContactListMembers,
  getListMembership,
  getWorkspaceGroup,
  materializeSmartList,
  reassignContactOwnership,
  removeContactFromList,
} from "../hooks/use-contact-lists"
import type { getContactLists } from "../hooks/use-contact-lists"
import { shownOf, totalOf } from "@/lib/format-count"

type ContactList = Awaited<ReturnType<typeof getContactLists>>[number]

export function ListDetailSheet({
  workspaceId,
  list,
  onOpenChange,
}: {
  workspaceId: string
  list: ContactList | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={!!list} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        {list && <ListDetailBody workspaceId={workspaceId} list={list} />}
      </SheetContent>
    </Sheet>
  )
}

function ListDetailBody({ workspaceId, list }: { workspaceId: string; list: ContactList }) {
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState("")
  const queryClient = useQueryClient()
  const archived = list.status === "archived"
  const canAdd = list.kind === "static" && !archived

  // Each tab is its own cursor-paged, server-filtered query -- a list can
  // hold tens of thousands of members; they're never all loaded at once.
  const memberQ = useDebouncedValue(filter.trim())
  const useMembers = (ownership: "owned" | "disabled") =>
    useInfiniteQuery({
      queryKey: ["contact-list-members", workspaceId, list.id, ownership, memberQ],
      queryFn: ({ pageParam }) =>
        getContactListMembers({
          data: { workspaceId, listId: list.id, ownership, q: memberQ, cursor: pageParam },
        }),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    })
  const approvedQuery = useMembers("owned")
  const disabledQuery = useMembers("disabled")
  const isLoading = approvedQuery.isLoading

  // Server-side, bounded search instead of pulling the whole workspace's
  // contacts into the browser for every open list.
  const debouncedSearch = useDebouncedValue(search.trim())
  const { data: searchHits = [] } = useQuery({
    queryKey: ["contact-search", workspaceId, null, debouncedSearch],
    queryFn: () => searchContacts({ data: { workspaceId, query: debouncedSearch } }),
    enabled: canAdd && debouncedSearch.length > 0,
    staleTime: 30_000,
  })

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["contact-list-members", workspaceId, list.id] })
    queryClient.invalidateQueries({ queryKey: ["contact-lists", workspaceId] })
  }

  const addMutation = useMutation({
    mutationFn: addContactsToList,
    onSuccess: (res) => {
      invalidate()
      if (res.skipped > 0) {
        toast.warning(
          `Added ${res.added}. Skipped ${res.skipped} -- no existing conversation (workspace only allows contacts you've chatted with).`
        )
      } else {
        toast.success("Contact added")
      }
      setSearch("")
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't add contacts."),
  })
  const removeMutation = useMutation({
    mutationFn: removeContactFromList,
    onSuccess: invalidate,
    onError: (err: any) => toast.error(err?.message ?? "Couldn't remove the contact."),
  })
  const reassignMutation = useMutation({
    mutationFn: reassignContactOwnership,
    onSuccess: () => {
      invalidate()
      toast.success("Ownership moved to this list")
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't reassign the contact."),
  })
  const materializeMutation = useMutation({
    mutationFn: materializeSmartList,
    onSuccess: (res) => {
      invalidate()
      toast.success(`Refreshed -- ${res.matched} contact${res.matched === 1 ? "" : "s"} matched`)
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't refresh this list."),
  })

  // Which search hits are already members -- asked for just those ids.
  const hitIds = searchHits.map((c) => c.id)
  const { data: alreadyMembers = [] } = useQuery({
    queryKey: ["contact-list-membership", workspaceId, list.id, hitIds],
    queryFn: () => getListMembership({ data: { workspaceId, listId: list.id, contactIds: hitIds } }),
    enabled: hitIds.length > 0,
    staleTime: 10_000,
  })
  const searchResults = useMemo(() => {
    if (!search.trim()) return []
    const members = new Set(alreadyMembers)
    return searchHits.filter((c) => !members.has(c.id)).slice(0, 8)
  }, [search, searchHits, alreadyMembers])

  const approved = approvedQuery.data?.pages.flatMap((p) => p.items) ?? []
  const disabled = disabledQuery.data?.pages.flatMap((p) => p.items) ?? []
  // Whole-list counts come from getContactLists, not the loaded pages.
  const approvedCount = list.stats.owned
  const disabledCount = list.stats.disabled
  const usable = !list.usableAfter || new Date(list.usableAfter) <= new Date()

  const isGroupRule = list.rule?.field === "whatsappGroup"
  const { data: ruleGroup } = useQuery({
    queryKey: ["workspace-group", workspaceId, list.rule?.value],
    queryFn: () => getWorkspaceGroup({ data: { workspaceId, groupId: list.rule!.value } }),
    enabled: isGroupRule && !!list.rule?.value,
    staleTime: 60_000,
  })

  return (
    <>
      <SheetHeader className="border-b pe-14">
        <SheetTitle className="flex items-center gap-2">
          {list.name}
          <Badge variant="outline" className="capitalize">
            {list.kind}
          </Badge>
          {archived && <Badge variant="secondary">Archived</Badge>}
        </SheetTitle>
        <SheetDescription>
          {approvedCount} approved · {disabledCount} disabled by another list
        </SheetDescription>
        {!usable && list.usableAfter && !archived && (
          <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
            <ClockIcon className="size-3.5" />
            Aging -- usable for broadcasts after {new Date(list.usableAfter).toLocaleString()}
          </p>
        )}
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
        {canAdd && (
          <div className="relative">
            <PlusIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Add a contact by name or phone..."
              className="h-9 ps-8"
            />
            {searchResults.length > 0 && (
              <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
                {searchResults.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={addMutation.isPending}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/50"
                    onClick={() =>
                      addMutation.mutate({
                        data: { workspaceId, listId: list.id, contactIds: [c.id] },
                      })
                    }
                  >
                    <span>
                      {c.name ?? "Unknown"}
                      <span className="ms-2 text-xs text-muted-foreground">{c.phoneNumber}</span>
                    </span>
                    <span className="text-xs font-medium text-primary">Add</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {list.kind === "smart" && !archived && (
          <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-xs">
            <span className="text-muted-foreground">
              Rule: <span className="font-medium text-foreground">
                {isGroupRule
                  ? `member of "${ruleGroup?.name ?? ruleGroup?.jid.split("@")[0] ?? "WhatsApp group"}"`
                  : describeRule(list.rule)}
              </span>
              {list.lastMaterializedAt && (
                <> · last refreshed {new Date(list.lastMaterializedAt).toLocaleString()}</>
              )}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => materializeMutation.mutate({ data: { workspaceId, listId: list.id } })}
              disabled={materializeMutation.isPending}
            >
              <RefreshCwIcon className={materializeMutation.isPending ? "animate-spin" : ""} />
              Refresh
            </Button>
          </div>
        )}

        <Tabs defaultValue="approved" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <TabsList>
              <TabsTrigger value="approved">Approved ({approvedCount})</TabsTrigger>
              <TabsTrigger value="disabled">Disabled ({disabledCount})</TabsTrigger>
            </TabsList>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter..."
                className="h-8 w-36 ps-8"
              />
            </div>
          </div>

          <TabsContent value="approved">
            <MemberList
              loading={isLoading}
              empty="No approved contacts yet."
              rows={approved}
              render={(m) =>
                !archived && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label="Remove from list"
                    disabled={removeMutation.isPending}
                    onClick={() =>
                      removeMutation.mutate({
                        data: { workspaceId, listId: list.id, contactId: m.contactId },
                      })
                    }
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                )
              }
            />
            <LoadMoreButton
              hasMore={!!approvedQuery.hasNextPage}
              shown={shownOf(approvedQuery.data)}
              total={totalOf(approvedQuery.data)}
              loading={approvedQuery.isFetchingNextPage}
              onLoadMore={() => approvedQuery.fetchNextPage()}
            />
          </TabsContent>
          <TabsContent value="disabled">
            <p className="mb-2 text-xs text-muted-foreground">
              These contacts already belong to another list, so they won&rsquo;t receive broadcasts
              from this one.
            </p>
            <MemberList
              loading={isLoading}
              empty="No conflicts with other lists."
              rows={disabled}
              render={(m) =>
                !archived && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={reassignMutation.isPending}
                    onClick={() =>
                      reassignMutation.mutate({
                        data: { workspaceId, contactId: m.contactId, toListId: list.id },
                      })
                    }
                  >
                    <ArrowRightLeftIcon className="size-3.5" />
                    Use this list
                  </Button>
                )
              }
            />
            <LoadMoreButton
              hasMore={!!disabledQuery.hasNextPage}
              shown={shownOf(disabledQuery.data)}
              total={totalOf(disabledQuery.data)}
              loading={disabledQuery.isFetchingNextPage}
              onLoadMore={() => disabledQuery.fetchNextPage()}
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}

type Member = Awaited<ReturnType<typeof getContactListMembers>>["items"][number]

function MemberList({
  rows,
  loading,
  empty,
  render,
}: {
  rows: Member[]
  loading: boolean
  empty: string
  render: (m: Member) => React.ReactNode
}) {
  if (loading) return <p className="py-6 text-center text-sm text-muted-foreground">Loading members...</p>
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  return (
    <ul className="divide-y rounded-md border">
      {rows.map((m) => (
        <li key={m.memberId} className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 truncate text-sm font-medium">
              {m.name ?? "Unknown"}
              {m.doNotBroadcast && (
                <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                  Suppressed
                </Badge>
              )}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {m.phoneNumber ?? m.jid.split("@")[0]} · <span className="capitalize">{m.source}</span>
            </div>
          </div>
          {render(m)}
        </li>
      ))}
    </ul>
  )
}

function describeRule(rule: ContactList["rule"]) {
  if (!rule) return "none"
  const labels: Record<string, string> = {
    tag: "has tag",
    lifecycleStage: "stage is",
    organizationName: "organization contains",
    lastContactedAt: rule.op === "after" ? "last contacted after" : "last contacted before",
    customField: `${rule.key ?? "custom field"} ${rule.op === "equals" ? "equals" : "contains"}`,
  }
  return `${labels[rule.field] ?? rule.field} "${rule.value}"`
}
