import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import {
  createDb,
  eq,
  and,
  desc,
  sql,
  agentEscalations,
  docChunks,
} from "@workspace/db"
import { withSafeErrors } from "@/lib/errors"
import { toEpochSeconds } from "@/lib/dates"
import { requireWorkspaceAccess, requirePermission, requireCurrentPermission } from "@/lib/auth"
import { fetchWaWorker } from "@/lib/wa-engine"

// Agent surface for /automation. Everything that touches the engine worker's
// bindings (Workers AI, Vectorize, REPLY_CACHE and its config cache) goes
// through the WA_WORKER service binding — one place owns writes, clamps and
// cache invalidation. Read-only secondary tables (escalations, knowledge
// base) are read straight from the shared D1, same as the rest of the CRM.
async function callWorker(
  path: string,
  workspaceId: string,
  init?: RequestInit
): Promise<any> {
  await requireWorkspaceAccess(workspaceId)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Required by the worker's resolveCaller auth guard (security.ts).
    // ENGINE_INTERNAL_SECRET must be set in apps/web/.dev.vars locally
    // and via `wrangler secret put ENGINE_INTERNAL_SECRET` for production.
    Authorization: `Bearer ${(env as any).ENGINE_INTERNAL_SECRET ?? ""}`,
    "X-Engine-Workspace": workspaceId,
  }
  const res = await fetchWaWorker(path, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
  const json: any = await res.json().catch(() => null)
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error ?? `Worker request failed (${res.status})`)
  }
  return json
}

// ── Agent config (via the engine worker: merged defaults, clamped fields,
// and KV config-cache invalidation all live there) ──
export interface AgentConfig {
  workspaceId: string
  enabled: boolean
  businessName: string
  scopeDescription: string
  systemPrompt: string
  replyInGroups: boolean
  models: {
    classifier: string
    generator: string
    embedding: string
  }
  maxContextChunks: number
  similarityThreshold: number
  cacheTtlSeconds: number
}

export type AgentConfigInput = {
  workspaceId: string
  enabled?: boolean
  businessName?: string
  scopeDescription?: string
  systemPrompt?: string
  classifierModel?: string
  generatorModel?: string
  embeddingModel?: string
  maxContextChunks?: number
  similarityThreshold?: number
  cacheTtlSeconds?: number
  replyInGroups?: boolean
}

export const getAgentConfig = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const res = await callWorker(
        `/agent/config?workspaceId=${encodeURIComponent(data.workspaceId)}`,
        data.workspaceId
      )
      return res.config as AgentConfig
    })
  )

export const updateAgentConfig = createServerFn({ method: "POST" })
  .validator((data: AgentConfigInput) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_settings")
      const res = await callWorker("/agent/config", data.workspaceId, {
        method: "PUT",
        body: JSON.stringify(data),
      })
      return res
    })
  )

// ── Webhook-backed tools (workspace custom integrations) ──
export interface AgentTool {
  id: string
  name: string
  description: string
  parametersJson: string
  url: string
  method: "GET" | "POST"
  hasAuth: boolean
  enabled: boolean
}

export type AgentToolInput = {
  workspaceId: string
  name: string
  description: string
  url: string
  method?: "GET" | "POST"
  parameters?: Record<string, unknown>
  authToken?: string
  enabled?: boolean
}

export const getAgentTools = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const res = await callWorker(
        `/agent/tools?workspaceId=${encodeURIComponent(data.workspaceId)}`,
        data.workspaceId
      )
      return (res.tools ?? []) as AgentTool[]
    })
  )

export const createAgentTool = createServerFn({ method: "POST" })
  .validator((data: AgentToolInput) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_settings")
      const res = await callWorker("/agent/tools", data.workspaceId, {
        method: "POST",
        body: JSON.stringify(data),
      })
      return res.tool
    })
  )

export const deleteAgentTool = createServerFn({ method: "POST" })
  .validator((data: { id: string; workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_settings")
      return await callWorker(
        `/agent/tools/${encodeURIComponent(data.id)}?workspaceId=${encodeURIComponent(
          data.workspaceId
        )}`,
        data.workspaceId,
        { method: "DELETE" }
      )
    })
  )

// ── Test-reply: run the exact pipeline WhatsApp runs, from the UI ──
export interface AgentReplyResult {
  text: string
  usedTools: string[]
  usedContext: { id: string; text: string; score: number; source: string }[]
  blocked: boolean
  blockReason?: string
  cached: boolean
}

export const testAgentReply = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; message: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_settings")
      const res = await callWorker("/agent/reply", data.workspaceId, {
        method: "POST",
        body: JSON.stringify(data),
      })
      return res as AgentReplyResult
    })
  )

// ── Knowledge base ingestion (embed + upsert lives in the engine worker) ──
export const ingestAgentDocument = createServerFn({ method: "POST" })
  .validator(
    (data: {
      workspaceId: string
      source: string
      text: string
      docId?: string
    }) => data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_settings")
      return await callWorker("/agent/ingest", data.workspaceId, {
        method: "POST",
        body: JSON.stringify(data),
      })
    })
  )

// ── Knowledge base listing / deletion (D1 is the source of truth; stale
// vectors are filtered at retrieval, so deleting rows here is sufficient) ──
export interface KnowledgeDoc {
  docId: string | null
  source: string
  chunks: number
  updatedAt: number | null
}

export const getKnowledgeBase = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = createDb(env.DB)
      // Aggregated in SQL (one row per doc) instead of pulling every chunk
      // row into JS to group them -- a large ingest is thousands of rows.
      // max(created_at) is the unixepoch integer drizzle stores for the
      // column, so it's already epoch seconds on the wire.
      const rows = await db
        .select({
          docId: docChunks.docId,
          source: docChunks.source,
          chunks: sql<number>`count(*)`,
          updatedAt: sql<number | null>`max(${docChunks.createdAt})`,
        })
        .from(docChunks)
        .where(eq(docChunks.workspaceId, data.workspaceId))
        .groupBy(docChunks.docId, docChunks.source)
        .orderBy(desc(sql`max(${docChunks.createdAt})`))
        .all()

      return rows.map((g) => ({
        docId: g.docId,
        source: g.source,
        chunks: g.chunks,
        updatedAt: g.updatedAt ?? null,
      }))
    })
  )

export const deleteKnowledgeDoc = createServerFn({ method: "POST" })
  .validator(
    (data: { workspaceId: string; docId?: string | null; source?: string }) =>
      data
  )
  .handler(
    withSafeErrors(async ({ data }) => {
      await requirePermission(data.workspaceId, "manage_settings")
      if (!data.docId && !data.source) throw new Error("Nothing to delete.")
      const db = createDb(env.DB)
      const conds = [eq(docChunks.workspaceId, data.workspaceId)]
      if (data.docId) conds.push(eq(docChunks.docId, data.docId))
      if (!data.docId && data.source)
        conds.push(eq(docChunks.source, data.source))
      await db.delete(docChunks).where(and(...(conds as [any, any])))
      return { ok: true }
    })
  )

// ── Human-handoff queue (created by the agent when it can't answer) ──
export interface AgentEscalation {
  id: string
  conversationId: string | null
  remoteJid: string | null
  reason: string
  status: "pending" | "resolved"
  createdAt: number | null
  resolvedAt: number | null
}

export const getAgentEscalations = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = createDb(env.DB)
      const rows = await db
        .select()
        .from(agentEscalations)
        .where(eq(agentEscalations.workspaceId, data.workspaceId))
        .orderBy(desc(agentEscalations.createdAt))
        .limit(50)
        .all()
      return rows.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        remoteJid: r.remoteJid,
        reason: r.reason,
        status: r.status,
        createdAt: toEpochSeconds(r.createdAt),
        resolvedAt: toEpochSeconds(r.resolvedAt),
      }))
    })
  )

export const resolveAgentEscalation = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      const db = createDb(env.DB)
      const workspaceId = await requireCurrentPermission("send_messages")
      await db
        .update(agentEscalations)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(and(eq(agentEscalations.id, data.id), eq(agentEscalations.workspaceId, workspaceId)))
      return { ok: true }
    })
  )
