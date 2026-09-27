import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * Generic table-shaped loading state — a header bar plus N rows of
 * mixed-width bars, with an optional trailing pill (status badge) and/or
 * a trailing icon-button placeholder. Used anywhere data lands in a
 * <Table> (Contacts, Broadcasts campaigns/scheduled, auto-reply rules,
 * webhooks) so the layout doesn't jump once real rows arrive.
 */
export function TableSkeleton({
  rows = 6,
  columns = 4,
  showPill = true,
  showTrailingAction = true,
}: {
  rows?: number
  columns?: number
  showPill?: boolean
  showTrailingAction?: boolean
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-4 border-b border-border px-4 py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 max-w-32 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_row, r) => (
        <div
          key={r}
          className="flex items-center gap-4 border-b border-border/60 px-4 py-4 last:border-0"
        >
          {Array.from({ length: columns }).map((_, c) => {
            if (showPill && c === columns - 1 && !showTrailingAction) {
              return (
                <Skeleton key={c} className="h-5 w-16 shrink-0 rounded-full" />
              )
            }
            if (showTrailingAction && c === columns - 1) {
              return (
                <Skeleton
                  key={c}
                  className="ml-auto size-7 shrink-0 rounded-md"
                />
              )
            }
            return (
              <Skeleton
                key={c}
                className="h-3 flex-1"
                style={{ maxWidth: c === 0 ? "9rem" : "6rem" }}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}
