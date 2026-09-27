import { Link } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { Panel } from "@workspace/ui/components/panel"
import { AvatarListSkeleton } from "@/components/skeletons"
import { SearchIcon, TriangleAlertIcon } from "lucide-react"
import type { SearchMatch } from "../hooks/use-search"

export function SearchResults({
  matches,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  matches: SearchMatch[]
  isLoading: boolean
  isError?: boolean
  error?: unknown
  onRetry?: () => void
}) {
  if (isLoading) {
    return (
      <Panel>
        <AvatarListSkeleton rows={5} withAvatar={false} />
      </Panel>
    )
  }

  if (isError) {
    return (
      <Panel className="border-dashed py-16">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon />
            </EmptyMedia>
            <EmptyTitle>Search failed</EmptyTitle>
            <EmptyDescription>
              {error instanceof Error
                ? error.message
                : "Something went wrong while searching."}
            </EmptyDescription>
          </EmptyHeader>
          {onRetry && (
            <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
              Try again
            </Button>
          )}
        </Empty>
      </Panel>
    )
  }

  if (matches.length === 0) {
    return (
      <Panel className="border-dashed py-16">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>Search your message history</EmptyTitle>
            <EmptyDescription>
              Search by meaning, not just exact words — try "customer asking
              about a refund".
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Panel>
    )
  }

  return (
    <Panel className="flex flex-col gap-2 p-2">
      {matches.map((m) => (
        <Link
          key={m.messageId}
          to="/inbox"
          search={{ conversationId: m.conversationId }}
          className="flex flex-col gap-1.5 rounded-xl border border-transparent p-3 transition-colors hover:border-border hover:bg-muted/50"
        >
          <div className="flex items-center justify-between">
            <Badge variant="outline">{Math.round(m.score * 100)}% match</Badge>
          </div>
          <p className="text-sm">{m.text}</p>
        </Link>
      ))}
    </Panel>
  )
}
