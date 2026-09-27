import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router"
import { QueryClientProvider  } from "@tanstack/react-query"
import type {QueryClient} from "@tanstack/react-query";
import { Toaster } from "@workspace/ui/components/sonner"
import { ThemeProvider } from "@workspace/ui/components/theme-provider"
import { Button } from "@workspace/ui/components/button"

import appCss from "@workspace/ui/globals.css?url"

interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Replyloom" },
      { name: "description", content: "Replyloom: open-source, self-hosted WhatsApp CRM and shared team inbox on Cloudflare." },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto flex min-h-[60vh] flex-col items-center justify-center gap-2 p-4 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">
        The page you're looking for doesn't exist or was moved.
      </p>
      <Button render={<a href="/" />} nativeButton={false} className="mt-2">
        Back to inbox
      </Button>
    </main>
  ),
  // Previously unset: an uncaught render error anywhere in the tree fell
  // through to the router's bare default, with no branded fallback and no
  // way back into the app short of a manual URL edit. This catches it at
  // the root so one broken route can't blank the whole page.
  errorComponent: ({ error, reset }) => (
    <main className="container mx-auto flex min-h-[60vh] flex-col items-center justify-center gap-2 p-4 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-muted-foreground">
        {error instanceof Error ? error.message : "An unexpected error occurred."}
      </p>
      <div className="mt-2 flex gap-2">
        <Button variant="outline" onClick={() => reset()}>
          Try again
        </Button>
        <Button render={<a href="/" />} nativeButton={false}>Back to inbox</Button>
      </div>
    </main>
  ),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { queryClient } = Route.useRouteContext()

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
          <Toaster />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}
