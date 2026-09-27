import { useDroppable } from "@dnd-kit/core"
import { cn } from "@workspace/ui/lib/utils"
import { LoadMoreButton } from "@/components/load-more-button"
import { DealCard  } from "./deal-card"
import type {Deal} from "./deal-card";

export interface Stage {
  id: string
  name: string
  color: string
  position: number
  /** Server-side totals for the whole column (not just loaded cards). */
  dealCount?: number
  valueCents?: number
  nextCursor?: string | null
}

function formatTotal(stage: Stage, deals: Deal[]) {
  const total = stage.valueCents ?? deals.reduce((sum, d) => sum + d.valueCents, 0)
  if (total === 0) return null
  const currency = deals[0]?.currency ?? "INR"
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(total / 100)
}

export function PipelineColumn({
  stage,
  deals,
  stages,
  onEdit,
  onDelete,
  onMoveToStage,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  stage: Stage
  deals: Deal[]
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  stages: Stage[]
  onEdit: (deal: Deal) => void
  onDelete: (deal: Deal) => void
  onMoveToStage: (deal: Deal, stageId: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: stage.id,
    data: { stageId: stage.id },
  })
  const total = formatTotal(stage, deals)

  return (
    <div className="flex w-72 shrink-0 flex-col rounded-lg bg-muted/40">
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: stage.color }}
          />
          <span className="text-sm font-medium">{stage.name}</span>
          <span className="text-xs text-muted-foreground">{stage.dealCount ?? deals.length}</span>
        </div>
        {total && (
          <span className="text-xs text-muted-foreground">{total}</span>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-2 transition-colors",
          isOver && "bg-primary/5 ring-2 ring-primary/30 ring-inset"
        )}
      >
        {deals.map((deal) => (
          <DealCard
            key={deal.id}
            deal={deal}
            stages={stages}
            onEdit={onEdit}
            onDelete={onDelete}
            onMoveToStage={onMoveToStage}
          />
        ))}
        {onLoadMore && (
          <LoadMoreButton
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={onLoadMore}
            shown={deals.length}
            total={stage.dealCount === undefined ? null : { total: stage.dealCount, capped: false }}
          />
        )}
        {deals.length === 0 && (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            Drop a deal here
          </div>
        )}
      </div>
    </div>
  )
}
