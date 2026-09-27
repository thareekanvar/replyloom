import { useState } from "react"
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { LoadMoreButton } from "@/components/load-more-button"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { toast } from "sonner"
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { SearchIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react"
import { getSuppressedContacts, setContactSuppression } from "../hooks/use-contact-lists"
import { shownOf, totalOf } from "@/lib/format-count"

export function SuppressionTab({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")

  // Cursor-paged + searched on the server (contacts_suppressed_idx).
  const q = useDebouncedValue(search.trim())
  const suppressedQuery = useInfiniteQuery({
    queryKey: ["suppressed-contacts", workspaceId, q],
    queryFn: ({ pageParam }) =>
      getSuppressedContacts({ data: { workspaceId, q, cursor: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const isLoading = suppressedQuery.isLoading

  const unsuppressMutation = useMutation({
    mutationFn: setContactSuppression,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["suppressed-contacts", workspaceId] })
      toast.success("Contact can be broadcast to again")
    },
    onError: (err: any) => toast.error(err?.message ?? "Couldn't update this contact."),
  })

  const rows = suppressedQuery.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search suppressed contacts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-72 ps-8"
          />
        </div>
        <p className="hidden text-xs text-muted-foreground md:block">
          Contacts here never receive broadcasts — replying to STOP adds them automatically.
        </p>
      </div>

      <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Table containerClassName="min-h-0 flex-1 overflow-auto">
          <TableHeader className="sticky top-0 z-10 bg-muted">
            <TableRow>
              <TableHead>Contact</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center text-sm text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-48 text-center">
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ShieldCheckIcon />
                      </EmptyMedia>
                      <EmptyTitle>{search ? "No matches" : "Nobody is suppressed"}</EmptyTitle>
                      <EmptyDescription>
                        {search
                          ? `Nothing matches "${search}".`
                          : "Contacts who opt out or are suppressed by an admin show up here."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="font-medium">{c.name ?? "Unknown"}</div>
                    <div className="text-xs text-muted-foreground">{c.phoneNumber}</div>
                  </TableCell>
                  <TableCell className="capitalize text-muted-foreground">
                    {c.doNotBroadcastReason?.replace(/_/g, " ") ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      title={
                        c.doNotBroadcastReason === "opted_out"
                          ? "This contact opted out themselves -- only they can opt back in"
                          : undefined
                      }
                      disabled={unsuppressMutation.isPending || c.doNotBroadcastReason === "opted_out"}
                      onClick={() =>
                        unsuppressMutation.mutate({
                          data: { workspaceId, contactId: c.id, suppressed: false },
                        })
                      }
                    >
                      <ShieldOffIcon className="size-3.5" />
                      Clear
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <LoadMoreButton
          hasMore={!!suppressedQuery.hasNextPage}
          shown={shownOf(suppressedQuery.data)}
          total={totalOf(suppressedQuery.data)}
          loading={suppressedQuery.isFetchingNextPage}
          onLoadMore={() => suppressedQuery.fetchNextPage()}
        />
      </Panel>
    </div>
  )
}
