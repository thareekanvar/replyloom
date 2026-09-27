import { Skeleton } from "@workspace/ui/components/skeleton"
import { Panel } from "@workspace/ui/components/panel"

/** A single centered card of placeholder lines — invite screens, empty page shells, one-off detail views. */
export function DetailCardSkeleton() {
  return (
    <Panel className="flex flex-col items-center gap-3 p-8 text-center">
      <Skeleton className="size-12 rounded-full" />
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-56" />
      <Skeleton className="mt-2 h-9 w-32 rounded-md" />
    </Panel>
  )
}
