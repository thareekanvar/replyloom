import {
  createFileRoute,
  Outlet,
  redirect,
  useMatches,
  useRouteContext,
} from "@tanstack/react-router"
import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar"
import { getCurrentUser } from "@/lib/auth"
import { useDesktopNotifications } from "@/hooks/use-desktop-notifications"
import { RealtimeProvider } from "@/features/realtime/components/realtime-provider"
import { PageSkeleton } from "@/components/skeletons"
import { SetupChecklist } from "@/features/onboarding/components/setup-checklist"

// Pathless layout: every route under routes/_app/* shares this sidebar
// shell. Per-page title comes from that route's `staticData.title` so the
// header updates without a full remount of the sidebar/providers.
export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    // getCurrentUser runs inside a createServerFn handler, so it always has
    // access to the real incoming request's cookies (via getRequestHeaders
    // in lib/auth.ts) — no manual cookie forwarding needed here.
    const result = await getCurrentUser()
    if (!result) throw redirect({ to: "/login" })
    const { workspaceId } = result
    if (!workspaceId) throw redirect({ to: "/create-workspace" })
    return { user: result.user, workspaceId }
  },
  pendingComponent: PageSkeleton,
  pendingMs: 150,
  component: AppLayout,
})

function AppLayout() {
  const { user, workspaceId } = useRouteContext({
    from: Route.id,
  })
  const matches = useMatches()
  // staticData's real shape isn't guaranteed despite the cast just below.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  const title =
    [...matches]
      .reverse()
      .find((m) => (m.staticData as { title?: string } | undefined)?.title)
      ?.staticData?.title ?? "Replyloom"
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */

  return (
    <RealtimeProvider workspaceId={workspaceId}>
      <DesktopNotifications workspaceId={workspaceId} />
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
          <SiteHeader title={title} />
          <div className="flex min-h-0 flex-1 flex-col bg-primary/10">
            <div className="@container/main flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-3 sm:p-4 md:gap-6 md:p-6">
              <Outlet />
            </div>
          </div>
        </SidebarInset>
        <SetupChecklist />
      </SidebarProvider>
    </RealtimeProvider>
  )
}

/** Hooks that need the realtime context, so they live under the provider. */
function DesktopNotifications({ workspaceId }: { workspaceId: string }) {
  useDesktopNotifications(workspaceId)
  return null
}
