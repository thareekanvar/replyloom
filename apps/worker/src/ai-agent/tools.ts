import {
  assertSafeOutboundUrl,
  createDb,
  eq,
  and,
  desc,
  inArray,
  contacts,
  messages,
  conversations,
  deals,
  pipelineStages,
  notes,
  agentEscalations,
  agentWebhookTools,
} from "@workspace/db";
import type { AgentContext, AgentEnv, ToolDefinition, ToolSchema } from "./types";

/**
 * Central place to register shipped tools. Each tool is self-contained
 * (schema + handler together), so adding capability later is "write a file,
 * register it here" — nothing else in the agent needs to change.
 *
 * In addition to these in-code tools, a workspace can register its own
 * webhook-backed tools in D1 (agent_webhook_tools): those are merged into
 * the model's tool list at call time and executed server-side via
 * `executeTool`, so wiring up a new integration needs zero code changes.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Shape Workers AI function-calling expects. */
  toToolSchemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async run(name: string, args: Record<string, any>, ctx: AgentContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Tool "${name}" is not available.`;
    try {
      return await tool.handler(args, ctx);
    } catch (err) {
      return `Tool "${name}" failed: ${(err as Error).message}`;
    }
  }
}

export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(lookupCustomerTool);
  registry.register(recentConversationTool);
  registry.register(lookupDealsTool);
  registry.register(escalateToHumanTool);
  return registry;
}

// ── Webhook-backed (per-workspace) tools ─────────────────────────────────

export interface WorkspaceWebhookTool {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  parametersJson: string;
  url: string;
  method: "GET" | "POST";
  authToken: string | null;
  enabled: boolean;
}

/** Fetches the workspace's enabled webhook tools (small table — one query). */
export async function listWorkspaceWebhookTools(
  env: AgentEnv,
  workspaceId: string,
): Promise<WorkspaceWebhookTool[]> {
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(agentWebhookTools)
    .where(and(eq(agentWebhookTools.workspaceId, workspaceId), eq(agentWebhookTools.enabled, true)))
    .all();
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    description: r.description,
    parametersJson: r.parametersJson,
    url: r.url,
    method: r.method,
    authToken: r.authToken ?? null,
    enabled: !!r.enabled,
  }));
}

export function workspaceToolToSchema(tool: WorkspaceWebhookTool): ToolSchema {
  let parameters: ToolSchema["parameters"] = { type: "object", properties: {} };
  try {
    const parsed = JSON.parse(tool.parametersJson);
    if (parsed && typeof parsed === "object") {
      parameters = {
        type: "object",
        properties: parsed.properties ?? {},
        required: Array.isArray(parsed.required) ? parsed.required : undefined,
      };
    }
  } catch {
    // malformed parameters_json — expose an empty object schema instead
  }
  return { name: tool.name, description: tool.description, parameters };
}

const MAX_TOOL_RESPONSE_CHARS = 2000;
const TOOL_TIMEOUT_MS = 5000;

/**
 * Executes a tool by name: built-in registry first, then the workspace's
 * webhook tools. The auth token is applied server-side and never returned in
 * the handler output. Whatever the endpoint replies comes back as the tool
 * result (a fact the model is then allowed to cite), truncated so a runaway
 * endpoint can't blow the context budget.
 */
export async function executeTool(
  env: AgentEnv,
  workspaceId: string,
  name: string,
  args: Record<string, any>,
  ctx: AgentContext,
  registry: ToolRegistry = buildDefaultRegistry(),
): Promise<string> {
  if (registry.list().some((t) => t.name === name)) return registry.run(name, args, ctx);

  const tools = await listWorkspaceWebhookTools(env, workspaceId);
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `Tool "${name}" is not available for this workspace.`;

  // SSRF: validated at save time too, re-checked here; never follow redirects.
  if (!assertSafeOutboundUrl(tool.url).ok) return `Tool "${name}" has an unsafe URL and was skipped.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (tool.method === "GET") {
      const qs = argsToQuery(args);
      const res = await fetch(tool.url + (qs ? `?${qs}` : ""), {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      return await readToolResponse(res);
    }
    headers["Content-Type"] = "application/json";
    if (tool.authToken) headers["Authorization"] = `Bearer ${tool.authToken}`;
    const res = await fetch(tool.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ args }),
      redirect: "manual",
      signal: controller.signal,
    });
    return await readToolResponse(res);
  } catch (err: any) {
    const why = err?.name === "AbortError" ? `timed out after ${TOOL_TIMEOUT_MS / 1000}s` : (err?.message ?? String(err));
    return `Tool "${name}" failed: ${why}`;
  } finally {
    clearTimeout(timer);
  }
}

async function readToolResponse(res: Response): Promise<string> {
  if (!res.ok) return `Tool endpoint returned HTTP ${res.status}.`;
  const text = (await res.text()).trim();
  if (!text) return "(empty response)";
  return text.slice(0, MAX_TOOL_RESPONSE_CHARS);
}

function argsToQuery(args: Record<string, any>): string {
  try {
    return Object.entries(args)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
  } catch {
    return "";
  }
}

// ── Shipped tools (work against the existing CRM schema) ────────────────

/** The CRM contact for the current customer, scoped to their own data. */
async function findCustomerContact(ctx: AgentContext) {
  // For group messages, use the sender's JID (participant) to look up the contact.
  // For direct messages, use the remoteJid as before.
  const lookupJid = ctx.isGroup ? ctx.senderJid : ctx.remoteJid;
  const hasIdentifier = !!ctx.customerPhone || (!!lookupJid && !lookupJid.endsWith("@g.us"));
  if (!hasIdentifier) return undefined;

  const db = createDb(ctx.env.DB);
  const conds = [];
  if (ctx.customerPhone) conds.push(eq(contacts.phoneNumber, ctx.customerPhone));
  if (lookupJid && !lookupJid.endsWith("@g.us")) conds.push(eq(contacts.jid, lookupJid));
  const where = and(eq(contacts.workspaceId, ctx.workspaceId), ...conds);
  return db.select().from(contacts).where(where).limit(1).get();
}

const lookupCustomerTool: ToolDefinition = {
  name: "lookup_customer",
  description:
    "Look up the current customer's profile in the CRM (name, lifecycle stage, notes). Call this when the customer asks anything account-related.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: async (_args, ctx) => {
    const contact = await findCustomerContact(ctx);
    if (!contact) return "No customer profile found for this number in the CRM.";

    const db = createDb(ctx.env.DB);
    const noteRows = await db
      .select({ body: notes.body })
      .from(notes)
      .where(eq(notes.contactId, contact.id))
      .orderBy(desc(notes.createdAt))
      .limit(1)
      .all();

    const note = noteRows[0]?.body ?? "-";
    return [
      `Customer: ${contact.name ?? "Unknown name"}`,
      `Phone: ${contact.phoneNumber ?? ctx.customerPhone ?? ""}`,
      `Lifecycle stage: ${contact.lifecycleStage}`,
      `About: ${contact.about ?? "-"}`,
      `Latest note: ${note}`,
    ].join("\n");
  },
};

const recentConversationTool: ToolDefinition = {
  name: "recent_conversation",
  description:
    "Fetch the last few messages exchanged with this customer so you have conversation context before answering. Call this when the customer references a previous message or thread.",
  parameters: {
    type: "object",
    properties: { limit: { type: "integer", description: "How many recent messages (max 12)" } },
    required: [],
  },
  handler: async (args, ctx) => {
    const limit = Math.min(12, Math.max(1, Number(args.limit) || 5));
    const db = createDb(ctx.env.DB);

    let conversationId = ctx.conversationId;
    if (!conversationId) {
      // For groups, look up by group JID; for direct, look up by contact
      if (ctx.isGroup && ctx.remoteJid) {
        const { groups } = await import("@workspace/db");
        const group = await db
          .select({ id: groups.id })
          .from(groups)
          .where(and(eq(groups.workspaceId, ctx.workspaceId), eq(groups.jid, ctx.remoteJid)))
          .get();
        if (group) {
          const conv = await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.workspaceId, ctx.workspaceId),
                eq(conversations.groupId, group.id),
                ...(ctx.waSessionId ? [eq(conversations.waSessionId, ctx.waSessionId)] : []),
              ),
            )
            .orderBy(desc(conversations.lastMessageAt))
            .limit(1)
            .get();
          conversationId = conv?.id;
        }
      } else {
        const contact = await findCustomerContact(ctx);
        if (contact) {
          const conv = await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.workspaceId, ctx.workspaceId),
                eq(conversations.contactId, contact.id),
                ...(ctx.waSessionId ? [eq(conversations.waSessionId, ctx.waSessionId)] : []),
              ),
            )
            .orderBy(desc(conversations.lastMessageAt))
            .limit(1)
            .get();
          conversationId = conv?.id;
        }
      }
    }
    if (!conversationId) return "No previous conversation found.";

    const rows = await db
      .select({ direction: messages.direction, body: messages.body, senderJid: messages.senderJid })
      .from(messages)
      .where(and(eq(messages.workspaceId, ctx.workspaceId), eq(messages.conversationId, conversationId)))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all();

    const text = rows
      .filter((r) => r.body)
      .reverse()
      .map((r) => {
        const label = ctx.isGroup
          ? (r.direction === "out" ? "Agent" : (r.senderJid?.split("@")[0] ?? "Unknown"))
          : (r.direction === "in" ? "Customer" : "Agent");
        return `${label}: ${r.body}`;
      })
      .join("\n");
    return text ? text.slice(0, 2000) : "No previous messages found.";
  },
};

const lookupDealsTool: ToolDefinition = {
  name: "lookup_deals",
  description:
    "Look up this customer's deals/opportunities in the pipeline (title, stage, value). Call this when the customer asks about a purchase, deal, or order status.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: async (_args, ctx) => {
    const db = createDb(ctx.env.DB);
    const contact = await findCustomerContact(ctx);
    if (!contact) return "No customer profile found for this number in the CRM.";

    const dealRows = await db
      .select({ id: deals.id, title: deals.title, stageId: deals.stageId, valueCents: deals.valueCents, currency: deals.currency })
      .from(deals)
      .where(and(eq(deals.workspaceId, ctx.workspaceId), eq(deals.contactId, contact.id)))
      .all();
    if (dealRows.length === 0) return "No deals found for this customer.";

    const stageIds = dealRows.map((d) => d.stageId);
    const stageRows = await db
      .select({ id: pipelineStages.id, name: pipelineStages.name })
      .from(pipelineStages)
      .where(inArray(pipelineStages.id, stageIds))
      .all();
    const stageName = new Map(stageRows.map((s) => [s.id, s.name]));

    return dealRows
      .map((d) => `${d.title} — stage: ${stageName.get(d.stageId) ?? "unknown"}, value: ${d.currency} ${(d.valueCents / 100).toFixed(2)}`)
      .join("\n");
  },
};

const escalateToHumanTool: ToolDefinition = {
  name: "escalate_to_human",
  description:
    "Flag this conversation for a human agent when you cannot resolve the request (missing data, policy too complex, customer is upset, or asked for a human).",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Why this needs a human" } },
    required: ["reason"],
  },
  handler: async (args, ctx) => {
    const db = createDb(ctx.env.DB);
    await db.insert(agentEscalations).values({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId ?? null,
      remoteJid: ctx.remoteJid ?? null,
      reason: String(args.reason ?? "No reason given").slice(0, 500),
    });
    return "Escalated to a human agent — they'll follow up shortly.";
  },
};