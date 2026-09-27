import { env } from "cloudflare:workers"

/**
 * Routes a request to apps/worker.
 *
 * In every deployed environment `env.WA_WORKER` is a real Cloudflare
 * service binding and this always takes that path.
 *
 * In local dev it can't: `@cloudflare/vite-plugin` only resolves a
 * `services` binding to another Worker when that worker is registered as
 * an `auxiliaryWorkers` entry in vite.config.ts, and apps/worker can't be
 * loaded that way here -- it pulls in Baileys (native crypto / heavy
 * Node-oriented deps), which the plugin's Vite module runner can't execute
 * to introspect the worker's exports ("ReferenceError: module is not
 * defined"), so the whole vite dev server fails to start if you try.
 * Instead, when ENGINE_LOCAL_URL is set (apps/web/.dev.vars only -- NEVER
 * set this in production) this fetches the standalone `wrangler dev`
 * process apps/worker already runs on (`pnpm dev` starts it on :8787)
 * directly over plain HTTP, same as any other local server.
 */
export function fetchWaWorker(path: string, init?: RequestInit): Promise<Response> {
  const localUrl = (env as typeof env & { ENGINE_LOCAL_URL?: string }).ENGINE_LOCAL_URL
  if (localUrl) return fetch(`${localUrl}${path}`, init)
  return env.WA_WORKER.fetch(`https://wa-worker${path}`, init)
}

export function buildEngineHeaders(
  secret: string,
  workspaceId: string
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${secret}`,
    "X-Engine-Workspace": workspaceId,
  })
  return headers
}

export async function callEngine(
  path: string,
  workspaceId: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = buildEngineHeaders(
    (env as typeof env & { ENGINE_INTERNAL_SECRET: string }).ENGINE_INTERNAL_SECRET,
    workspaceId,
  )
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value)

  return fetchWaWorker(path, {
    ...init,
    headers,
  })
}

export async function readEngineJson<T>(
  path: string,
  workspaceId: string,
  init?: RequestInit
): Promise<T> {
  const response = await callEngine(path, workspaceId, init)
  const body = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? body.error
        : undefined
    throw new Error(
      message || `WhatsApp worker request failed (${response.status})`
    )
  }
  return body as T
}

/**
 * Fetch a short-lived HMAC-signed WebSocket token for a session.
 * Called server-side through the service binding so the internal secret
 * never reaches the browser.
 */
export async function getWsToken(
  sessionId: string,
  workspaceId: string
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const response = await callEngine(
    `/session/${sessionId}/ws-token`,
    workspaceId,
    { method: "GET" }
  )
  const body = (await response.json().catch(() => null)) as any
  if (!response.ok || !body?.ok) {
    return { ok: false, error: body?.error || `HTTP ${response.status}` }
  }
  return { ok: true, token: body.token }
}
