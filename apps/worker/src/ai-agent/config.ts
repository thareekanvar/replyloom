import { createDb, eq, agentConfigs, workspaces } from "@workspace/db";
import type { AgentConfig, AgentEnv } from "./types";
import { TtlCache } from "../ttl-cache";

// Defaults, aligned with the repo's existing embedding choice (bge-m3,
// 1024-dim — the same model the message-search index wa-messages uses), so
// a single embedding model serves both indexes and multilingual support is
// retained. The generator is only invoked for grounded, in-scope messages.
export const ACTIVE_GENERATOR_MODEL = "@cf/google/gemma-4-26b-a4b-it";

/** Map model ids saved by older deployments to currently active Workers AI ids. */
export function normalizeModelId(model: string): string {
  if (
    model === "@cf/meta/infire-llama-3.1-8b-instruct" ||
    model === "@cf/meta/llama-3.1-8b-instruct"
  ) {
    return ACTIVE_GENERATOR_MODEL;
  }
  return model;
}
export const defaultConfig = {
  models: {
    // Small, fast, current model for the per-message intent gate. Cheap
    // enough to run on every message; overridable per workspace.
    classifier: "@cf/meta/llama-3.2-3b-instruct",
    // Main reply model — active fast 8B model with function-calling support.
    generator: ACTIVE_GENERATOR_MODEL,
    embedding: "@cf/baai/bge-m3",
  },
  maxContextChunks: 4,
  similarityThreshold: 0.72,
  cacheTtlSeconds: 3600,
  replyInGroups: false,
} as const;

const CONFIG_CACHE_PREFIX = "agent:cfg:";
// Config is tiny and changes rarely — a short KV cache dodges a D1 read on
// every single inbound message (the hot per-message cost).
const CONFIG_CACHE_TTL = 60;

export const cachePrefixes = {
  replies: "agent:reply:",
} as const;

export function isAgentEnabled(config: AgentConfig): boolean {
  return config.enabled;
}

/**
 * Loads + merges a workspace's agent config with defaults. Cached in KV for
 * `CONFIG_CACHE_TTL` seconds; PUT /agent/config invalidates the entry.
 * Never throws for a bad row — worst case you get defaults with enabled=false,
 * which is the safe (do-nothing) posture.
 */
// In-isolate layer in front of KV. Disabled configs are cached too: the
// agent is off for most workspaces, and every inbound message without a
// keyword match used to cost 2 D1 reads (agent_configs + workspace name)
// because only *enabled* configs were ever cached.
const memoryConfigCache = new TtlCache<AgentConfig>(60_000);

export async function loadAgentConfig(env: AgentEnv, workspaceId: string): Promise<AgentConfig> {
  return memoryConfigCache.get(workspaceId, () => loadAgentConfigUncached(env, workspaceId));
}

async function loadAgentConfigUncached(env: AgentEnv, workspaceId: string): Promise<AgentConfig> {
  const key = `${CONFIG_CACHE_PREFIX}${workspaceId}`;
  try {
    const cached = await env.REPLY_CACHE.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as AgentConfig;
      return {
        ...parsed,
        models: {
          classifier: normalizeModelId(parsed.models.classifier),
          generator: normalizeModelId(parsed.models.generator),
          embedding: normalizeModelId(parsed.models.embedding),
        },
      };
    }
  } catch {
    // stale/garbled cache entry — fall through and rebuild
  }
  const config = await buildAgentConfig(env, workspaceId);
  if (config.enabled) {
    await env.REPLY_CACHE
      .put(key, JSON.stringify(config), { expirationTtl: CONFIG_CACHE_TTL })
      .catch(() => {});
  }
  return config;
}

export function invalidateConfigCache(env: AgentEnv, workspaceId: string): Promise<unknown> {
  memoryConfigCache.invalidate(workspaceId);
  return env.REPLY_CACHE.delete(`${CONFIG_CACHE_PREFIX}${workspaceId}`).catch(() => {});
}

async function buildAgentConfig(env: AgentEnv, workspaceId: string): Promise<AgentConfig> {
  const db = createDb(env.DB);
  try {
    const row = await db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.workspaceId, workspaceId))
      .get();

    let businessName = row?.businessName ?? null;
    if (!businessName) {
      const ws = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .get();
      businessName = ws?.name ?? null;
    }

    return {
      workspaceId,
      enabled: row?.enabled ?? false,
      businessName: businessName ?? "this business",
      scopeDescription: row?.scopeDescription ?? "",
      systemPrompt: row?.systemPrompt ?? "",
      replyInGroups: row?.replyInGroups ?? defaultConfig.replyInGroups,
      models: {
        classifier: normalizeModelId(row?.classifierModel ?? defaultConfig.models.classifier),
        generator: normalizeModelId(row?.generatorModel ?? defaultConfig.models.generator),
        embedding: normalizeModelId(row?.embeddingModel ?? defaultConfig.models.embedding),
      },
      maxContextChunks: row?.maxContextChunks ?? defaultConfig.maxContextChunks,
      similarityThreshold: row?.similarityThreshold ?? defaultConfig.similarityThreshold,
      cacheTtlSeconds: row?.cacheTtlSeconds ?? defaultConfig.cacheTtlSeconds,
    };
  } catch {
    return { ...defaults(workspaceId), enabled: false };
  }
}

function defaults(workspaceId: string): AgentConfig {
  return {
    workspaceId,
    enabled: false,
    businessName: "this business",
    scopeDescription: "",
    systemPrompt: "",
    replyInGroups: defaultConfig.replyInGroups,
    models: { ...defaultConfig.models },
    maxContextChunks: defaultConfig.maxContextChunks,
    similarityThreshold: defaultConfig.similarityThreshold,
    cacheTtlSeconds: defaultConfig.cacheTtlSeconds,
  };
}
