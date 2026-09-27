import { useRouteContext } from "@tanstack/react-router"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar"

/**
 * Rendered as the `pendingComponent` for the _app layout. It replicates the
 * exact shell (sidebar + header) so the user sees no visual jump — only the
 * content area below the header is replaced with skeleton placeholders.
 */
export function PageSkeleton() {
  const { user } = useRouteContext({ from: "/_app" })

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 64)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar user={user} variant="inset" />
      <SidebarInset>
        <SiteHeader title="Replyloom" />
        <div className="flex min-h-0 flex-1 flex-col bg-primary/10">
          <div className="@container/main flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-3 sm:p-4 md:gap-6 md:p-6">
            <div className="flex flex-1 flex-col gap-4 animate-pulse">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-3 w-72" />
              </div>
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-4">
                  <Skeleton className="h-9 w-32 rounded-md" />
                  <Skeleton className="h-9 w-32 rounded-md" />
                  <Skeleton className="ml-auto h-9 w-28 rounded-md" />
                </div>
                <div className="flex flex-col border border-border rounded-lg overflow-hidden">
                  <div className="flex items-center gap-4 border-b border-border px-4 py-3">
                    <Skeleton className="h-3 flex-1 max-w-32" />
                    <Skeleton className="h-3 flex-1 max-w-24" />
                    <Skeleton className="h-3 flex-1 max-w-28" />
                    <Skeleton className="h-3 flex-1 max-w-20" />
                  </div>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-4 border-b border-border/60 px-4 py-4 last:border-0"
                    >
                      <Skeleton
                        className="h-3 flex-1"
                        style={{ maxWidth: "9rem" }}
                      />
                      <Skeleton
                        className="h-3 flex-1"
                        style={{ maxWidth: "6rem" }}
                      />
                      <Skeleton
                        className="h-3 flex-1"
                        style={{ maxWidth: "6rem" }}
                      />
                      <Skeleton className="ml-auto size-7 shrink-0 rounded-md" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
