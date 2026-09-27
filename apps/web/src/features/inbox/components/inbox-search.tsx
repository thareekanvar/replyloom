import { useCallback, useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Badge } from "@workspace/ui/components/badge"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
} from "@workspace/ui/components/form"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { AvatarListSkeleton } from "@/components/skeletons"
import {
  semanticSearch
  
} from "@/features/search/hooks/use-search"
import type {SearchMatch} from "@/features/search/hooks/use-search";
import { SearchIcon, TriangleAlertIcon } from "lucide-react"
import { searchSchema  } from "@/lib/schemas"
import type {SearchInput} from "@/lib/schemas";

export function InboxSearch({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false)
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const panelRef = useRef<HTMLDivElement>(null)

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

  function handleClose() {
    setOpen(false)
    form.reset()
    setMatches([])
  }

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      handleClose()
    }
  }, [])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [open, handleClickOutside])

  useEffect(() => {
    if (open) {
      const input = panelRef.current?.querySelector("input")
      input?.focus()
    }
  }, [open])

  return (
    <div className="relative" ref={panelRef}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Search messages"
        onClick={() => (open ? handleClose() : setOpen(true))}
      >
        <SearchIcon className="size-4" />
      </Button>

      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-[380px] rounded-xl border border-border bg-popover shadow-lg">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex items-center gap-2 border-b border-border p-3"
            >
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <FormField
                control={form.control}
                name="query"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormControl>
                      <Input
                        placeholder="Search messages..."
                        className="h-8 border-0 bg-transparent shadow-none focus-visible:ring-0"
                        {...field}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </form>
          </Form>

          <div className="max-h-80 overflow-y-auto p-2">
            {searchMutation.isPending ? (
              <AvatarListSkeleton rows={3} withAvatar={false} />
            ) : searchMutation.isError ? (
              <Empty className="py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <TriangleAlertIcon />
                  </EmptyMedia>
                  <EmptyTitle>Search failed</EmptyTitle>
                  <EmptyDescription>
                    {searchMutation.error instanceof Error
                      ? searchMutation.error.message
                      : "Something went wrong while searching."}
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => searchMutation.mutate(form.getValues("query").trim())}
                >
                  Try again
                </Button>
              </Empty>
            ) : matches.length === 0 ? (
              <Empty className="py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    {form.getValues("query").trim() ? "No results" : "Search by meaning"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {form.getValues("query").trim()
                      ? "Try a different search term."
                      : "Find conversations even without exact words."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-1">
                {matches.map((m) => (
                  <Link
                    key={m.messageId}
                    to="/inbox"
                    search={{ conversationId: m.conversationId }}
                    onClick={handleClose}
                    className="flex flex-col gap-1 rounded-lg border border-transparent p-2.5 text-sm transition-colors hover:border-border hover:bg-muted/50"
                  >
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className="text-[10px]">
                        {Math.round(m.score * 100)}% match
                      </Badge>
                    </div>
                    <p className="line-clamp-2 text-muted-foreground">
                      {m.text}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
