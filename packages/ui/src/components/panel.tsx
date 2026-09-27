import * as React from "react"
import { cn } from "cn"

// Shared "white surface" wrapper for anything list/table/board-shaped —
// Contacts, Pipeline, Broadcasts, Search, Settings all sit their content
// on this instead of each hand-rolling `rounded-2xl border bg-background`
// (which is how they'd drifted: some had it, some didn't, so the page
// background wash showed through and looked faded/inconsistent).
function Panel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel"
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-background",
        className
      )}
      {...props}
    />
  )
}

export { Panel }
