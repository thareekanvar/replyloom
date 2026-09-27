import { createFileRoute } from "@tanstack/react-router"
import { auth } from "@/lib/auth-server"

// Better Auth's email-verification landing page: the link in the
// verification email points at `${BETTER_AUTH_URL}/api/auth/verify-email`.
// There is no generic /api/auth/* catch-all in this app (sign-in/sign-up go
// through server functions), so this endpoint is mounted explicitly.
export const Route = createFileRoute("/api/auth/verify-email")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: ({ request }) => auth.handler(request),
    },
  },
})
