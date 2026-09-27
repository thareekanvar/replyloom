import { createFileRoute, useRouteContext } from "@tanstack/react-router"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation } from "@tanstack/react-query"
import { Input } from "@workspace/ui/components/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
} from "@workspace/ui/components/form"
import { SearchIcon } from "lucide-react"
import {
  semanticSearch
  
} from "@/features/search/hooks/use-search"
import type {SearchMatch} from "@/features/search/hooks/use-search";
import { SearchResults } from "@/features/search/components/search-results"
import { searchSchema  } from "@/lib/schemas"
import type {SearchInput} from "@/lib/schemas";
import { useState } from "react"

export const Route = createFileRoute("/_app/search")({
  staticData: { title: "Search" },
  component: SearchPage,
})

function SearchPage() {
  const { workspaceId } = useRouteContext({ from: "/_app" })
  const [matches, setMatches] = useState<SearchMatch[]>([])

  const form = useForm<SearchInput>({
    resolver: zodResolver(searchSchema),
    defaultValues: { query: "" },
  })

  const searchMutation = useMutation({
    mutationFn: (q: string) =>
      semanticSearch({ data: { workspaceId, query: q } }),
    onSuccess: (results) => setMatches(results),
  })

  function onSubmit(data: SearchInput) {
    searchMutation.mutate(data.query.trim())
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Search</h2>
        <p className="text-sm text-muted-foreground">
          Semantic search across your message history — find what was said, even
          without the exact words.
        </p>
      </div>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <FormField
            control={form.control}
            name="query"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    className="pl-9"
                    placeholder="e.g. customer asking about refund"
                    {...field}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </form>
      </Form>
      <SearchResults
        matches={matches}
        isLoading={searchMutation.isPending}
        isError={searchMutation.isError}
        error={searchMutation.error}
        onRetry={() => {
          const q = form.getValues("query").trim()
          if (q) searchMutation.mutate(q)
        }}
      />
    </div>
  )
}
