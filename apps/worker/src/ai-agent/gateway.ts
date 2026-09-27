import type { AgentEnv } from "./types";
import { ACTIVE_GENERATOR_MODEL } from "./config";

// Fallback used when the primary generator model errors out (dynamic-routing
// lever #2, after AI Gateway's own retries). Same function-calling family, so
// the tool loop behaves identically; just smaller/cheaper.
// Keep this widened to string because the Workers Types package can lag behind
// newly released model ids even though Workers AI accepts them at runtime.
export const FALLBACK_GENERATOR: string = ACTIVE_GENERATOR_MODEL;

/**
 * Builds the AI Gateway options passed as the 3rd arg to `env.AI.run()`.
 *
 * Every model call in the agent pipelines is routed through the gateway so it
 * shows up in AI Gateway analytics (requests, tokens, cost, latency, cache
 * hits) and is governed by whatever the gateway has configured — caching,
 * rate/spend limits, DLP, guardrail moderation, dynamic routing/fallbacks.
 *
 * Two observability hooks ride along on every call:
 *   - `metadata.workspaceId` (+ feature) → per-workspace cost/latency in logs
 *     once a matching custom-metadata profile exists on the gateway.
 *   - a `ws:{id}` tag → groups everything for one workspace in the dashboard.
 *
 * The gateway id comes from the AIG_GATEWAY_ID var and defaults to the
 * account's auto-provisioned "default" gateway, so this lights up with zero
 * account setup (and degrades to a plain Workers-AI call if the var is empty).
 */
export function gatewayRunOptions(env: AgentEnv, workspaceId: string, feature: string) {
  return {
    gateway: {
      id: env.AIG_GATEWAY_ID?.trim() || "default",
      metadata: {
        workspaceId,
        feature,
      },
      collectLog: true,
      requestTimeoutMs: 30_000,
      retries: { maxAttempts: 2, retryDelayMs: 500, backoff: "linear" } as const,
    },
    tags: [`ws:${workspaceId}`],
  };
}
