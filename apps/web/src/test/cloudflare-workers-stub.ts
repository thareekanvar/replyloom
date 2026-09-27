import { vi } from "vitest"

// Alias target for `cloudflare:workers` in vitest.config.ts.
// Vite's import analysis fails on the cloudflare: protocol before
// vi.mock can run, so we resolve the specifier to this file instead.
export const env = {
  DB: {},
  WA_WORKER: {
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    ),
  },
  REPLY_CACHE: {},
  MEDIA: {},
  BETTER_AUTH_SECRET: "test-secret",
  ENGINE_INTERNAL_SECRET: "test-engine-secret",
  WS_TOKEN_SECRET: "test-ws-secret",
  BETTER_AUTH_URL: "http://localhost:3000",
} as any

export class DurableObject {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export const SELF = {}
