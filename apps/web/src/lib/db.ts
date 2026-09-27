import { env } from "cloudflare:workers"
import { createDb } from "@workspace/db"

// Server-only: resolves the shared D1 binding for this Worker. Import only
// from server functions / route loaders (same pattern as lib/wa-worker.ts),
// never from client components — "cloudflare:workers" doesn't exist in the browser.
export function getDb() {
  return createDb(env.DB)
}
