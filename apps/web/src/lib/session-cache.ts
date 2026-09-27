import { createServerOnlyFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { env } from "cloudflare:workers"
import { and, createDb, eq, member } from "@workspace/db"
import { auth } from "./auth-server"
import { memoPerRequest } from "./request-cache"

// createServerOnlyFn: these are reachable from client-imported modules
// (lib/auth.ts, lib/errors.ts), so their bodies -- and the server-only
// imports above -- must be stripped from the client bundle, or TanStack
// Start's import protection rejects the build ("Import denied in client
// environment: @tanstack/react-start/server").

/** Better Auth session for this request, resolved at most once per request. */
export const getSessionCached = createServerOnlyFn(() =>
  memoPerRequest("auth:session", () =>
    auth.api.getSession({ headers: getRequestHeaders() })
  )
)

/** The member row (id + role) for user x workspace, once per request. */
export const getMembershipCached = createServerOnlyFn(
  (userId: string, workspaceId: string) =>
    memoPerRequest(`auth:member:${userId}:${workspaceId}`, () =>
      createDb(env.DB)
        .select({ id: member.id, role: member.role })
        .from(member)
        .where(and(eq(member.userId, userId), eq(member.organizationId, workspaceId)))
        .get()
    )
)
