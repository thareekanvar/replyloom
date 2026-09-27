import * as Sentry from "@sentry/tanstackstart-react"
import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import { createQueryClient } from "@/lib/query-client"
import { scrubSentryEvent } from "@workspace/db/sentry-scrub"

export function getRouter() {
  const queryClient = createQueryClient()

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },

    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  })

  // Error reporting is opt-in: set VITE_SENTRY_DSN in apps/web/.env.production.
  if (!router.isServer && import.meta.env.VITE_SENTRY_DSN) {
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      // 100% tracing adds a span + upload to every request/queue message;
      // 10% keeps performance visibility at a fraction of the overhead.
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      beforeSend: scrubSentryEvent,
    });
  }

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
