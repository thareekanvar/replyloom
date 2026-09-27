import { useDraggable } from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@workspace/ui/components/dropdown-menu"
import {
  PencilIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  TrashIcon,
  ArrowRightIcon,
} from "lucide-react"
import { cn } from "@workspace/ui/lib/utils"
import type { Stage } from "./pipeline-column"

export interface Deal {
  id: string
  title: string
  valueCents: number
  currency: string
  stageId: string
  contactId: string
  contactName: string | null
  contactPhone: string | null
  contactAvatar: string | null
  lastContactedAt: Date | number | null
}

function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

function formatLastContacted(value: Date | number | null) {
  if (!value) return "No contact yet"
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "No contact yet"

  return `Last contact ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date)}`
}

export function DealCard({
  deal,
  stages,
  dragging,
  onEdit,
  onDelete,
  onMoveToStage,
}: {
  deal: Deal
  stages: Stage[]
  dragging?: boolean
  onEdit: (deal: Deal) => void
  onDelete: (deal: Deal) => void
  onMoveToStage: (deal: Deal, stageId: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: deal.id,
      data: { deal },
    })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "group rounded-lg border bg-card p-3 shadow-xs transition-colors hover:border-foreground/15",
        (isDragging || dragging) && "opacity-50"
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Drag to move deal"
          className="mt-0.5 flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <p className="min-w-0 flex-1 text-sm font-medium">{deal.title}</p>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${deal.title}`}
                className="-mr-1 -mt-1 size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              />
            }
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(deal)}>
              <PencilIcon />
              Edit deal
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ArrowRightIcon />
                Move to stage
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {stages
                  .filter((s) => s.id !== deal.stageId)
                  .map((s) => (
                    <DropdownMenuItem
                      key={s.id}
                      onClick={() => onMoveToStage(deal, s.id)}
                    >
                      {s.name}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDelete(deal)}
            >
              <TrashIcon />
              Delete deal
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-1.5 flex items-center justify-between pl-6">
        <button
          type="button"
          onClick={() => onEdit(deal)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
            {(deal.contactName ?? "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 text-start">
            <span className="block truncate">{deal.contactName ?? "Unassigned"}</span>
            <span className="block truncate text-[11px]">
              {deal.contactPhone ?? "WhatsApp contact"}
            </span>
          </span>
        </button>
        {deal.valueCents > 0 && (
          <span className="text-xs font-medium text-foreground">
            {formatMoney(deal.valueCents, deal.currency)}
          </span>
        )}
      </div>
      <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
        {formatLastContacted(deal.lastContactedAt)}
      </p>
    </div>
  )
}
