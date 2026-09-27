import { createFileRoute, useRouteContext } from "@tanstack/react-router"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { InboxLayout } from "@/features/inbox/components/inbox-layout"
import {
  getConversationCounts,
  getConversationsPage,
  getMessagesPage,
} from "@/features/inbox/hooks/use-conversations"
import type { InboxFilter } from "@/features/inbox/hooks/use-conversations"
import {
  conversationCountsKey,
  pagedConversationsKey,
} from "@/features/inbox/lib/conversation-cache"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { getSessions } from "@/features/integrations/hooks/use-sessions"

export const Route = createFileRoute("/_app/inbox")({
  staticData: { title: "Inbox" },
  // Lets Search deep-link straight into a conversation (?conversationId=...)
  // instead of just landing on the inbox and making the person hunt for it.
  validateSearch: (
    search: Record<string, unknown>
  ): { conversationId?: string } => {
    const conversationId =
      typeof search.conversationId === "string"
        ? search.conversationId
        : undefined
    return conversationId ? { conversationId } : {}
  },
  component: InboxPage,
})

function InboxPage() {
  const { workspaceId } = useRouteContext({ from: "/_app" })
  const { conversationId } = Route.useSearch()
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(conversationId ?? null)

  // Search's "View conversation" link (and anything else that deep-links
  // in with ?conversationId=...) navigates to this already-mounted route
  // rather than remounting it, so the useState initializer above only
  // fires once. Sync it explicitly whenever the search param changes.
  useEffect(() => {
    if (conversationId) setSelectedConversationId(conversationId)
  }, [conversationId])

  // Tabs + search are applied on the server and paged by cursor -- the
  // list used to filter only whatever pages happened to be loaded.
  const [filter, setFilter] = useState<InboxFilter>("all")
  const [search, setSearch] = useState("")
  const q = useDebouncedValue(search.trim(), 300)
  const conversationsQuery = useInfiniteQuery({
    queryKey: [...pagedConversationsKey(workspaceId), filter, q],
    queryFn: ({ pageParam }) =>
      getConversationsPage({
        data: { workspaceId, filter, q, cursor: pageParam },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  })
  const countsQuery = useQuery({
    queryKey: conversationCountsKey(workspaceId),
    queryFn: () => getConversationCounts({ data: { workspaceId } }),
    staleTime: 60_000,
  })
  const conversations =
    conversationsQuery.data?.pages.flatMap((page) => page.items) ?? []

  // Same cache key as Integrations / the onboarding checklist so this is
  // usually already warm. Drives the empty state: "Connect your first
  // number" must not show when a number is already linked but no chats
  // have landed yet (history still syncing, brand-new number, etc.).
  const sessionsQuery = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    staleTime: 30_000,
  })
  const hasConnectedNumber = (sessionsQuery.data?.length ?? 0) > 0

  const messagesQuery = useInfiniteQuery({
    queryKey: ["messages", selectedConversationId],
    queryFn: ({ pageParam }) =>
      selectedConversationId
        ? getMessagesPage({
            data: {
              conversationId: selectedConversationId,
              workspaceId,
              cursor: pageParam,
            },
          })
        : Promise.resolve({ items: [], hasMore: false, nextCursor: null }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!selectedConversationId,
    staleTime: 30_000,
  })
  const messages =
    messagesQuery.data?.pages
      .slice()
      .reverse()
      .flatMap((page) => page.items) ?? []

  return (
    <InboxLayout
      conversations={conversations}
      messages={messages}
      selectedConversationId={selectedConversationId}
      onSelectConversation={setSelectedConversationId}
      workspaceId={workspaceId}
      conversationsLoading={conversationsQuery.isLoading}
      hasConnectedNumber={hasConnectedNumber}
      sessionsLoaded={!sessionsQuery.isLoading}
      conversationsHasMore={!!conversationsQuery.hasNextPage}
      conversationsLoadingMore={conversationsQuery.isFetchingNextPage}
      onLoadMoreConversations={() => conversationsQuery.fetchNextPage()}
      filter={filter}
      onFilterChange={setFilter}
      search={search}
      onSearchChange={setSearch}
      counts={countsQuery.data}
      messagesLoading={!!selectedConversationId && messagesQuery.isLoading}
      messagesError={!!selectedConversationId && messagesQuery.isError}
      messagesHasOlder={!!messagesQuery.hasNextPage}
      messagesLoadingOlder={messagesQuery.isFetchingNextPage}
      onLoadOlderMessages={() => messagesQuery.fetchNextPage()}
    />
  )
}
