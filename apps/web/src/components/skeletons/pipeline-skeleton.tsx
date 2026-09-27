import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * Kanban-board loading state — a handful of columns, each with a header
 * bar and a few card placeholders of varying height, mirroring
 * PipelineColumn/DealCard's real shape.
 */
export function PipelineBoardSkeleton({
  columns = 4,
  cardsPerColumn = 3,
}: {
  columns?: number
  cardsPerColumn?: number
}) {
  return (
    <div className="flex flex-1 gap-3 overflow-hidden">
      {Array.from({ length: columns }).map((_col, c) => (
        <div
          key={c}
          className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-muted/40 p-2"
        >
          <div className="flex items-center gap-2 px-1 py-1.5">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
          {Array.from({ length: cardsPerColumn }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  )
}
