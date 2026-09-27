import type { QueryClient } from "@tanstack/react-query"

// The inbox list is cached per (filter, search) under
// ["conversations", workspaceId, "paged", filter, q] -- one infinite query per
// tab/search. Anything that updates a conversation optimistically (realtime,
// pin/read/archive) must reach all of them, so everything goes through here.

export function pagedConversationsKey(workspaceId: string) {
  return ["conversations", workspaceId, "paged"] as const
}

export function conversationCountsKey(workspaceId: string) {
  return ["conversations", workspaceId, "counts"] as const
}

type Paged = { pages: { items: any[] }[]; pageParams: unknown[] }

/** Applies `update` to every item in every cached inbox page. */
export function patchConversationCaches(
  queryClient: QueryClient,
  workspaceId: string,
  update: (conv: any) => any
): boolean {
  let found = false
  queryClient.setQueriesData<Paged>(
    { queryKey: pagedConversationsKey(workspaceId) },
    (old) => {
      if (!old?.pages) return old
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.map((conv) => {
            const next = update(conv)
            if (next !== conv) found = true
            return next
          }),
        })),
      }
    }
  )
  return found
}

export function patchConversationById(
  queryClient: QueryClient,
  workspaceId: string,
  id: string,
  fields: Record<string, unknown>
) {
  return patchConversationCaches(queryClient, workspaceId, (c) =>
    c.id === id ? { ...c, ...fields } : c
  )
}

export function findCachedConversation(
  queryClient: QueryClient,
  workspaceId: string,
  id: string
): any {
  for (const [, data] of queryClient.getQueriesData<Paged>({
    queryKey: pagedConversationsKey(workspaceId),
  })) {
    for (const page of data?.pages ?? []) {
      const hit = page.items.find((c) => c.id === id)
      if (hit) return hit
    }
  }
  return undefined
}
