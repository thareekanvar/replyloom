import { isAPIError } from "better-auth/api"
import { getMembershipCached, getSessionCached } from "./session-cache"

const DEFAULT_FALLBACK = "Something went wrong. Please try again."

/** Authorizes workspace-scoped server functions before their handler runs. */
async function authorizeWorkspaceInput(workspaceId: unknown) {
  if (typeof workspaceId !== "string" || !workspaceId) return

  const session = await getSessionCached()
  if (!session) throw new Error("Unauthorized")

  const active = session.session.activeOrganizationId
  const membership = await getMembershipCached(session.user.id, workspaceId)
  if (!membership || (active && active !== workspaceId)) {
    throw new Error("Unauthorized")
  }
}

/**
 * Turns any thrown value into a clean, user-safe Error.
 *
 * Better Auth's own APIErrors (wrong password, duplicate email, weak
 * password, etc.) are already written for end users, so those pass through
 * untouched. Anything else — a raw D1/SQL failure, an unexpected bug, a
 * network blip — gets logged in full server-side (visible in `wrangler dev`
 * / your Worker logs) and swapped for a generic message, so the browser
 * never sees something like `Failed query: select ... from "user" ...`.
 */
/**
 * An error whose message was written for end users (e.g. "This list is
 * still aging") -- passes through withSafeErrors untouched instead of being
 * swapped for the generic fallback.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserFacingError"
  }
}

export function toSafeError(
  err: unknown,
  fallback: string = DEFAULT_FALLBACK
): Error {
  if (err instanceof UserFacingError || isAPIError(err)) {
    return new Error(err.message)
  }
  console.error(err)
  return new Error(fallback)
}

/**
 * Wraps a createServerFn handler so any thrown error is sanitized before it
 * reaches the client. Put this around the handler body of any server
 * function that touches the database (or anything else that can throw
 * internals you don't want shown to the user):
 *
 * ```ts
 * export const getContacts = createServerFn()
 *   .validator((data: { workspaceId: string }) => data)
 *   .handler(withSafeErrors(async ({ data }) => { ... }))
 * ```
 */
export function withSafeErrors<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => Promise<TResult>,
  fallback?: string
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    try {
      const input = args[0] as { data?: { workspaceId?: unknown } } | undefined
      await authorizeWorkspaceInput(input?.data?.workspaceId)
      return await handler(...args)
    } catch (err) {
      throw toSafeError(err, fallback)
    }
  }
}
