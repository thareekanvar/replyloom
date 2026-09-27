import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"

/**
 * Message-thread loading state — alternating left/right bubble
 * placeholders of varying width, the way a chat actually reads, instead
 * of a generic block. Used while a conversation's messages are loading.
 */
export function ChatThreadSkeleton({ rows = 7 }: { rows?: number }) {
  const widths = ["w-40", "w-56", "w-32", "w-64", "w-44", "w-28", "w-52"]
  return (
    <div className="flex flex-1 flex-col justify-end gap-3 p-4">
      {Array.from({ length: rows }).map((_, i) => {
        const fromMe = i % 3 === 1
        return (
          <div
            key={i}
            className={cn("flex", fromMe ? "justify-end" : "justify-start")}
          >
            <Skeleton
              className={cn("h-9 rounded-2xl", widths[i % widths.length])}
            />
          </div>
        )
      })}
    </div>
  )
}
