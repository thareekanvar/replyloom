import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * Generic "avatar + two lines" list row, repeated N times — the shape
 * shared by the conversation list, search results, and pending
 * invitations. A row is: circular avatar, a title-width bar, a
 * shorter subtitle-width bar, and an optional trailing bit (time/badge).
 */
export function AvatarListSkeleton({
  rows = 6,
  withAvatar = true,
}: {
  rows?: number
  withAvatar?: boolean
}) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-border/50 px-3 py-3 last:border-0"
        >
          {withAvatar && <Skeleton className="size-10 shrink-0 rounded-full" />}
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-4/5" />
          </div>
          <Skeleton className="h-2.5 w-8 shrink-0" />
        </div>
      ))}
    </div>
  )
}
