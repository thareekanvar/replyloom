import { createServerOnlyFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

// Per-request memoization for server-only lookups (session, membership).
// A single server-function call used to resolve the Better Auth session 2-4
// times (withSafeErrors -> requireWorkspaceAccess -> requirePermission each
// called getSession + a member query), i.e. 4-8 D1 round trips of pure auth
// overhead per request. Keyed on the Request object, so entries are dropped
// with the request -- nothing leaks across users or requests.
const cache = new WeakMap<object, Map<string, Promise<unknown>>>()

// Server-only (see session-cache.ts): keeps getRequest out of the client bundle.
const currentRequest = createServerOnlyFn((): object | undefined => {
  try {
    return getRequest()
  } catch {
    return undefined
  }
})

export function memoPerRequest<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const request = currentRequest()
  if (!request) return fn()
  let entries = cache.get(request)
  if (!entries) {
    entries = new Map()
    cache.set(request, entries)
  }
  const hit = entries.get(key)
  if (hit) return hit as Promise<T>
  const p = fn()
  entries.set(key, p)
  // Don't cache failures (a transient D1 error shouldn't poison the request).
  p.catch(() => entries.delete(key))
  return p
}
