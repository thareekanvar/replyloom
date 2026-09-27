import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./tenancy";

// Per-workspace AI agent settings. The agent is OFF by default — a
// workspace is opted in by enabling this row (via PUT /agent/config from
// the worker, or whatever integration-facing admin surface we build). All
// model/behaviour knobs are optional and fall back to the agent's defaults
// in apps/worker/src/ai-agent/config.ts, so a workspace can onboard with
// zero configuration.
export const agentConfigs = sqliteTable("agent_configs", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  // null -> falls back to the workspace (organization) name
  businessName: text("business_name"),
  // null -> the agent refuses anything it has no grounding for
  scopeDescription: text("scope_description"),
  // Optional workspace-specific behavior instructions appended to the base
  // support prompt. Never use this field for secrets or credentials.
  systemPrompt: text("system_prompt"),
  // null -> default model per role (classifier/generator/embedding)
  classifierModel: text("classifier_model"),
  generatorModel: text("generator_model"),
  embeddingModel: text("embedding_model"),
  maxContextChunks: integer("max_context_chunks").notNull().default(4),
  // Cosine score floor before a chunk is trusted as grounding. Below this
  // the agent must refuse rather than guess — the main anti-hallucination
  // lever alongside the system prompt.
  similarityThreshold: real("similarity_threshold").notNull().default(0.72),
  // How long an exact-match FAQ answer stays cached in KV. Tool-backed
  // answers are never cached; only small, tool-free, grounded replies.
  cacheTtlSeconds: integer("cache_ttl_seconds").notNull().default(3600),
  // Auto-replying in groups is off by default: the agent only answers
  // private chats unless a workspace explicitly opts in.
  replyInGroups: integer("reply_in_groups", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// RAG grounding store. Full text lives in D1; the Vectorize index (wa-docs)
// holds only vectors + workspaceId so retrieval is filtered per workspace
// and chunks are re-fetched from here by id (keeps the index lean, and the
// text is never shipped to anyone but the requesting workspace's model call).
export const docChunks = sqliteTable(
  "doc_chunks",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    // Optional grouping id so a re-ingest of a source can delete its old
    // chunks before upserting (no stale/duplicate grounding).
    docId: text("doc_id"),
    source: text("source").notNull(),
    text: text("text").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("doc_chunks_workspace_idx").on(t.workspaceId),
    index("doc_chunks_doc_idx").on(t.workspaceId, t.docId),
  ],
);

// Per-workspace custom tools. A workspace exposes internal capabilities
// (its own order lookup, inventory, booking API, ...) as a webhook-backed
// tool: the agent calls it the same way as any built-in tool, and the
// worker POSTs the args to the workspace's endpoint. This is the "add more
// tools later / connect to their integrations" extension point — no code
// changes needed, just a row here + a reachable endpoint.
export const agentWebhookTools = sqliteTable(
  "agent_webhook_tools",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    // OpenAPI-ish JSON Schema for parameters, as one JSON blob.
    parametersJson: text("parameters_json").notNull().default("{}"),
    url: text("url").notNull(),
    method: text("method", { enum: ["GET", "POST"] }).notNull().default("POST"),
    // One optional static bearer header/value pair (e.g. a workspace API
    // key) stored per workspace — never surfaced to the model, only applied
    // server-side on the outbound call.
    authToken: text("auth_token"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("agent_webhook_tools_workspace_idx").on(t.workspaceId, t.enabled),
    index("agent_webhook_tools_name_idx").on(t.workspaceId, t.name),
  ],
);

// Human-handoff log: the agent escalates when it has no grounded answer, is
// asked something out of scope in a way it can't refuse, or the customer
// asks for a human.
export const agentEscalations = sqliteTable(
  "agent_escalations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id"),
    remoteJid: text("remote_jid"),
    reason: text("reason").notNull(),
    status: text("status", { enum: ["pending", "resolved"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (t) => [
    index("agent_escalations_workspace_idx").on(t.workspaceId, t.status),
  ],
);
