import { Button } from "@workspace/ui/components/button"
import { Loader2Icon } from "lucide-react"
import { formatTotal } from "@/lib/format-count"

/** Footer for cursor-paginated lists (useInfiniteQuery): "Showing 25 of
 * 1,240" plus a Load more button while there are more pages. */
export function LoadMoreButton({
  hasMore,
  loading,
  onLoadMore,
  label = "Load more",
  shown,
  total,
}: {
  hasMore: boolean
  loading?: boolean
  onLoadMore: () => void
  label?: string
  /** Rows currently rendered. */
  shown?: number
  /** Exact total from the server (null/undefined = unknown). */
  total?: { total: number; capped: boolean } | null
}) {
  const summary =
    total && shown !== undefined && total.total > 0
      ? `Showing ${Math.min(shown, total.total).toLocaleString()} of ${formatTotal(total.total, total.capped)}`
      : null
  if (!hasMore && !summary) return null
  return (
    <div className="flex items-center justify-center gap-3 py-2">
      {summary && <span className="text-xs text-muted-foreground">{summary}</span>}
      {hasMore && (
        <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loading}>
          {loading && <Loader2Icon className="size-3.5 animate-spin" />}
          {label}
        </Button>
      )}
    </div>
  )
}
