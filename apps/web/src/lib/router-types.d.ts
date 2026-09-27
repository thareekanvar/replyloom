// Augments TanStack Router's per-route static data so `staticData: { title }`
// is typed everywhere (see routes/_app.tsx and every routes/_app/*.tsx page).
import "@tanstack/react-router"

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    title?: string
  }
}
