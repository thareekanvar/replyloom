import { createFileRoute, Link, Outlet } from "@tanstack/react-router"
import { MessageCircleIcon, ZapIcon, UsersIcon } from "lucide-react"

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
})

// Split-screen auth shell shared by /login and /signup — they render only
// their form content into <Outlet/>; the brand header, entrance animation
// and the right-hand marketing panel live here once instead of being
// duplicated in both routes. Recolored from the original neutral/black
// reference design to this app's own primary green (bg-primary/text-*
// tokens) instead of hardcoded neutral-900/950s, so it follows the app's
// theme (and any future light/dark tuning) automatically.
function AuthLayout() {
  return (
    <div className="relative flex min-h-dvh w-full bg-background">
      <div className="flex w-full flex-col lg:w-1/2">
        <Link
          to="/login"
          className="absolute top-4 left-4 flex items-center gap-2 p-2 md:top-6 md:left-6"
        >
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessageCircleIcon className="size-4" />
          </span>
          <span className="text-lg font-bold tracking-tight text-foreground">
            Replyloom
          </span>
        </Link>

        <div className="flex flex-1 items-center justify-center p-6 md:p-10">
          <div className="w-full max-w-[420px] animate-in duration-500 ease-out fade-in slide-in-from-bottom-3">
            <Outlet />
          </div>
        </div>
      </div>

      {/* Right marketing panel — a brand-green gradient with a decorative
          grid instead of a stock photo, so it doesn't depend on hotlinking
          an external image asset that isn't ours. */}
      <div className="hidden p-4 lg:block lg:w-1/2">
        <div className="relative flex h-full w-full flex-col justify-end overflow-hidden rounded-[2rem] bg-gradient-to-br from-primary via-primary to-primary/70 p-10 text-primary-foreground">
          <div
            className="absolute inset-0 opacity-[0.07]"
            style={{
              backgroundImage:
                "linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)",
              backgroundSize: "40px 40px",
            }}
          />
          <div className="relative flex flex-col gap-6">
            <h2 className="text-3xl leading-tight font-semibold text-balance">
              One inbox for every WhatsApp conversation your business has.
            </h2>
            <p className="max-w-sm text-sm text-primary-foreground/80">
              Multi-session messaging, contacts, pipeline and broadcasts —
              unified, searchable and automated.
            </p>
            <div className="flex flex-col gap-3 pt-2">
              <div className="flex items-center gap-3 text-sm text-primary-foreground/90">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-foreground/15">
                  <MessageCircleIcon className="size-4" />
                </span>
                Unified inbox across every connected number
              </div>
              <div className="flex items-center gap-3 text-sm text-primary-foreground/90">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-foreground/15">
                  <UsersIcon className="size-4" />
                </span>
                Contacts, pipeline and lifecycle stages built in
              </div>
              <div className="flex items-center gap-3 text-sm text-primary-foreground/90">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-foreground/15">
                  <ZapIcon className="size-4" />
                </span>
                Auto-replies, broadcasts and webhooks on autopilot
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
