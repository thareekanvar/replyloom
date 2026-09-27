import { createFileRoute, redirect } from "@tanstack/react-router"

// Contact lists now live as a tab on the Contacts page. Kept as a redirect so
// old bookmarks / links still land in the right place.
export const Route = createFileRoute("/_app/contact-lists")({
  beforeLoad: () => {
    throw redirect({ to: "/contacts", search: { tab: "lists" } })
  },
})
