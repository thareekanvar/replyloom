import { Skeleton } from "@workspace/ui/components/skeleton"
import { Panel } from "@workspace/ui/components/panel"

/**
 * A grid of card placeholders — icon tile + title/subtitle + a couple of
 * body lines + a footer row. Matches the Integrations grid and the Roles
 * grid shape (Panel-wrapped cards in a responsive grid).
 */
export function CardGridSkeleton({
  count = 6,
  columns = "md:grid-cols-2 lg:grid-cols-3",
}: {
  count?: number
  columns?: string
}) {
  return (
    <div className={`grid gap-4 ${columns}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Panel key={i} className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
            <Skeleton className="size-11 shrink-0 rounded-xl" />
          </div>
          <Skeleton className="h-2.5 w-full" />
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-3">
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        </Panel>
      ))}
    </div>
  )
}
