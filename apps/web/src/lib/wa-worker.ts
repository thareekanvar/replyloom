// Server-only access to the WhatsApp worker (apps/worker) via a Cloudflare
// service binding (see apps/web/wrangler.jsonc -> services -> WA_WORKER).
// This runs Worker-to-Worker over Cloudflare's network in every deployed
// environment: no public URL, no CORS. In local dev it goes through
// fetchWaWorker() (see wa-engine.ts) instead, which falls back to a plain
// HTTP call to apps/worker's standalone `wrangler dev` process, since
// `vite dev` (what runs apps/web locally) can't resolve this service
// binding to another worker on its own.
import { createServerFn } from "@tanstack/react-start"
import { fetchWaWorker } from "@/lib/wa-engine"

export const getWaWorkerHealth = createServerFn().handler(async () => {
  try {
    const res = await fetchWaWorker("/health")
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    // Type-only assertion (no runtime effect) — needed so this server
    // function has a concrete, serializable return type for TanStack
    // Start's RPC layer. `res.json()` alone resolves to `unknown`,
    // which TanStack Start's serialization check rejects; ESLint's
    // type-aware "unnecessary assertion" rule doesn't know that, so it
    // keeps flagging (and --fix keeps stripping) this one.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return (await res.json()) as { cloudflare: boolean; baileys: boolean }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})
