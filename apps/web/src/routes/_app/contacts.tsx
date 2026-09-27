import { useEffect, useState } from "react"
import { createFileRoute, useNavigate, useRouteContext } from "@tanstack/react-router"
import { useInfiniteQuery } from "@tanstack/react-query"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { ContactsTable } from "@/features/contacts/components/contacts-table"
import { getContactsPage } from "@/features/contacts/hooks/use-contacts"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { totalOf } from "@/lib/format-count"
import { ContactListsTab } from "@/features/contact-lists/components/contact-lists-tab"
import { SuppressionTab } from "@/features/contact-lists/components/suppression-tab"
import { BroadcastSettingsPanel } from "@/features/contact-lists/components/broadcast-settings-panel"
import { SendingLimitsPanel } from "@/features/contact-lists/components/sending-limits-panel"

const TABS = ["contacts", "lists", "suppression", "settings"] as const
type ContactsTab = (typeof TABS)[number]

export const Route = createFileRoute("/_app/contacts")({
  staticData: { title: "Contacts" },
  validateSearch: (search: Record<string, unknown>): { tab?: ContactsTab } => {
    const tab = search.tab
    return typeof tab === "string" && (TABS as readonly string[]).includes(tab) && tab !== "contacts"
      ? { tab: tab as ContactsTab }
      : {}
  },
  component: ContactsPage,
})

function ContactsPage() {
  const { workspaceId } = useRouteContext({ from: "/_app" })
  const { tab: requestedTab } = Route.useSearch()
  const navigate = useNavigate({ from: "/contacts" })
  const [tab, setTab] = useState<ContactsTab>(requestedTab ?? "contacts")
  useEffect(() => {
    setTab(requestedTab ?? "contacts")
  }, [requestedTab])

  function changeTab(next: ContactsTab) {
    setTab(next)
    navigate({ search: next === "contacts" ? {} : { tab: next }, replace: true })
  }

  // Search runs on the server (it used to filter only the loaded pages).
  const [contactSearch, setContactSearch] = useState("")
  const contactQ = useDebouncedValue(contactSearch.trim(), 300)
  const contactsQuery = useInfiniteQuery({
    queryKey: ["contacts", workspaceId, "paged", contactQ],
    queryFn: ({ pageParam }) =>
      getContactsPage({
        data: { workspaceId, q: contactQ, cursor: pageParam, limit: 20 },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  })
  const contacts = contactsQuery.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => changeTab(value as ContactsTab)}
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      <TabsList className="max-w-full shrink-0 overflow-x-auto">
        <TabsTrigger value="contacts">All contacts</TabsTrigger>
        <TabsTrigger value="lists">Lists</TabsTrigger>
        <TabsTrigger value="suppression">Do not contact</TabsTrigger>
        <TabsTrigger value="settings">Anti-ban settings</TabsTrigger>
      </TabsList>

      <TabsContent value="contacts" className="flex min-h-0 flex-1 flex-col">
        <ContactsTable
          data={contacts}
          workspaceId={workspaceId}
          isLoading={contactsQuery.isLoading}
          hasMore={!!contactsQuery.hasNextPage}
          isLoadingMore={contactsQuery.isFetchingNextPage}
          onLoadMore={() => contactsQuery.fetchNextPage()}
          searchQuery={contactSearch}
          onSearchQueryChange={setContactSearch}
          total={totalOf(contactsQuery.data)}
        />
      </TabsContent>
      <TabsContent value="lists" className="flex min-h-0 flex-1 flex-col">
        <ContactListsTab workspaceId={workspaceId} />
      </TabsContent>
      <TabsContent value="suppression" className="flex min-h-0 flex-1 flex-col">
        <SuppressionTab workspaceId={workspaceId} />
      </TabsContent>
      <TabsContent value="settings" className="flex flex-col gap-4 overflow-y-auto">
        <BroadcastSettingsPanel workspaceId={workspaceId} />
        <SendingLimitsPanel workspaceId={workspaceId} />
      </TabsContent>
    </Tabs>
  )
}
