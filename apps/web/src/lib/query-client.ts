import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query"
import { toast } from "sonner"

function errorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Something went wrong. Please try again."
}

// One client per request on the server, one singleton in the browser.
// Route loaders call `queryClient.ensureQueryData(...)` so data is already
// in the cache before the first paint (no client-side waterfall); realtime
// events later just call `queryClient.setQueryData(...)` on the same keys.
//
// Every query/mutation failure surfaces as a sonner toast from here, so
// individual components don't need their own error UI — server functions
// should still sanitize what they throw (see lib/errors.ts) so the message
// shown here is never a raw SQL/driver error.
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error, query) => {
        // Only toast a query's first failure (no cached data yet). A
        // background refetch failing shouldn't interrupt someone looking at
        // data that's still perfectly fine to read.
        if (query.state.data === undefined) {
          toast.error(errorMessage(error))
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        toast.error(errorMessage(error))
      },
    }),
  })
}
