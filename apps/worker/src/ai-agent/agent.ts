import type { AgentConfig, AgentContext, AgentEnv, AgentInput, AgentReply, RetrievedChunk, ToolSchema } from "./types";
import { classifyIntent, redactSensitive, shouldEscalateToHuman } from "./guardrails";
import { createDb, eq, desc, messages } from "@workspace/db";
import { retrieveContext } from "./rag";
import { buildSystemPrompt } from "./system-prompt";
import { cachePrefixes } from "./config";
import { gatewayRunOptions, FALLBACK_GENERATOR } from "./gateway";
import { executeTool, buildDefaultRegistry, listWorkspaceWebhookTools, workspaceToolToSchema } from "./tools";
import { customerPhoneFromJid } from "./util";

const registry = buildDefaultRegistry();
const MAX_TURNS = 2; // generation loop depth, not conversation turns
const MAX_REPLY_TOKENS = 400;
const MAX_INPUT_CHARS = 4000;
const MAX_THREAD_CHARS = 1500;
const THREAD_MESSAGE_LIMIT = 4;

const NO_INFO_REPLY =
  "I don't have that information on hand. I'll flag this for a team member to follow up with you.";
const CLARIFY_REPLY =
  "Hey! How can I help you today?";

/**
 * The full agent pipeline for one inbound customer message:
 *
 *   1. Exact-match KV cache  — repeat FAQs answered for ~0 tokens.
 *   2. Intent gate           — cheap classifier blocks CODING / SENSITIVE /
 *                              OFF_TOPIC before any retrieval/generation spend.
 *   3. RAG retrieval         — only chunks above the similarity threshold are
 *                              trusted as grounding (anti-hallucination lever #1).
 *   4. Generation            — tools allowed; a strict system prompt says facts
 *                              must come from context or tool results.
 *   5. Tool-gate             — with zero grounding, a reply is only kept if a
 *                              tool actually answered it; otherwise hand off to a
 *                              human instead of letting the model free-wheel.
 *   6. Redaction + cache     — sensitive patterns scrubbed; tool-free grounded
 *                              answers cached (cheap repeats), tool answers never.
 *
 * Returns a blocked/grounded/cached result — callers (WhatsApp auto-reply,
 * HTTP integrations) just send `reply.text` if present.
 */
export async function handleAgentMessage(
  env: AgentEnv,
  config: AgentConfig,
  input: AgentInput,
): Promise<AgentReply> {
  if (!config.enabled) return { text: "", usedTools: [], usedContext: [], blocked: true, blockReason: "OFF_TOPIC", cached: false };

  const message = input.message.trim().slice(0, MAX_INPUT_CHARS);
  if (!message) return { text: "", usedTools: [], usedContext: [], blocked: false, cached: false };

  const customerPhone = input.customerPhone ?? customerPhoneFromJid(input.remoteJid) ?? undefined;
  const ctx: AgentContext = {
    env,
    config,
    workspaceId: config.workspaceId,
    conversationId: input.conversationId,
    waSessionId: input.waSessionId,
    remoteJid: input.remoteJid,
    senderJid: input.senderJid,
    customerPhone,
    isGroup: input.isGroup ?? false,
  };

  // ── 1) Cheap exact-match cache — zero model spend on repeat FAQs ──
  const cacheKey = `${cachePrefixes.replies}${config.workspaceId}:${normalize(message)}`;
  if (config.cacheTtlSeconds > 0) {
    const cached = await env.REPLY_CACHE.get(cacheKey);
    if (cached) {
      return { text: cached, usedTools: [], usedContext: [], blocked: false, cached: true };
    }
  }

  // ── 1b) Conversation thread — gives the model continuity for follow-ups
  // like "and shipping?" without a full message-history tool call, and
  // grounds the RAG query in what the customer was actually asking about. ──
  const thread = input.conversationId ? await loadConversationThread(env, input, THREAD_MESSAGE_LIMIT) : "";
  const query = thread ? `${thread}\n\n${message}` : message;

  // ── 2) Parallel Guardrail Gate, Tool Lookup, and RAG Context Retrieval for minimum latency ──
  const [gate, workspaceTools, context] = await Promise.all([
    classifyIntent(env, config, message),
    listWorkspaceWebhookTools(env, config.workspaceId),
    retrieveContext(env, config, query),
  ]);

  if (!gate.allowed) {
    const text = gate.cannedReply!;
    if (config.cacheTtlSeconds > 0) await cache(env, config, cacheKey, text);
    return { text, usedTools: [], usedContext: [], blocked: true, blockReason: gate.label, cached: false };
  }

  // ── Tool list (built-ins + workspace webhooks) built once per message ──
  const toolSchemas: ToolSchema[] = [
    ...registry.toToolSchemas(),
    ...workspaceTools.map(workspaceToolToSchema),
  ];

  // ── No grounding: the tool-only branch. A reply survives only if the
  //    model actually used a tool (order lookup, profile, ...) — otherwise
  //    the model's own knowledge is not allowed to answer, and we hand off.
  if (context.length === 0) {
    const { text, usedTools } = await generateReply(ctx, message, [], toolSchemas, thread);
    if (usedTools.length === 0 || !text) {
      if (shouldEscalateToHuman(message)) {
        await registry.run("escalate_to_human", { reason: `Customer requested help from a human or expressed frustration: ${message}` }, ctx);
        return { text: NO_INFO_REPLY, usedTools: ["escalate_to_human"], usedContext: [], blocked: false, cached: false };
      }
      return { text: text || CLARIFY_REPLY, usedTools, usedContext: [], blocked: false, cached: false };
    }
    return { text: redactSensitive(text), usedTools, usedContext: [], blocked: false, cached: false };
  }

  // ── 4+5) Grounded generation (context + tools, at most 2 tool turns) ──
  const { text, usedTools } = await generateReply(ctx, message, context, toolSchemas, thread);
  const safeText = redactSensitive(text || "Let me get a team member to help with that.");

  // ── 6) Cache tool-free grounded answers only — per-customer tool results
  //    (order status, balance, ...) are never cached. ──
  if (usedTools.length === 0 && config.cacheTtlSeconds > 0) {
    await cache(env, config, cacheKey, safeText);
  }

  return { text: safeText, usedTools, usedContext: context, blocked: false, cached: false };
}

async function generateReply(
  ctx: AgentContext,
  message: string,
  context: RetrievedChunk[],
  toolSchemas: ToolSchema[],
  thread = "",
): Promise<{ text: string; usedTools: string[] }> {
  const systemPrompt = buildSystemPrompt(ctx.config, context, context.length > 0);
  const userContent = thread ? `${thread}\n\n${message}` : message;
  const chatMessages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  const usedTools: string[] = [];
  let finalText = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body = {
      messages: chatMessages,
      tools: toolSchemas,
      max_tokens: MAX_REPLY_TOKENS,
    };
    const runOptions = gatewayRunOptions(ctx.env, ctx.workspaceId, "generator");

    let result: any;
    try {
      result = await ctx.env.AI.run(ctx.config.models.generator, body, runOptions);
    } catch {
      // Primary model failed (after the gateway's own retries) — fail down to
      // a lighter model rather than letting the reply die for the customer.
      result = await ctx.env.AI.run(FALLBACK_GENERATOR, body, runOptions);
    }

    const toolCalls: any[] = result?.tool_calls ?? [];
    if (toolCalls.length === 0) {
      finalText = String(result?.response ?? "").trim();
      break;
    }

    for (const call of toolCalls) {
      const name = String(call?.name ?? "");
      if (!name) continue;
      const args = parseToolArgs(call?.arguments);
      const output = await executeTool(ctx.env, ctx.workspaceId, name, args, ctx, registry);
      usedTools.push(name);
      chatMessages.push({ role: "assistant", content: null, tool_calls: [call] });
      chatMessages.push({ role: "tool", name, content: output });
    }
  }

  return { text: finalText, usedTools };
}

/** Workers AI can hand tool arguments back as a string or an object. */
export function parseToolArgs(argumentsRaw: any): Record<string, any> {
  if (argumentsRaw && typeof argumentsRaw === "object") return argumentsRaw;
  if (typeof argumentsRaw === "string") {
    try {
      const parsed = JSON.parse(argumentsRaw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Loads the tail of a conversation (most recent `limit` messages, oldest
 * first) so the model has conversational continuity and the RAG query can
 * see what the customer was asking about. Missing conversation / no rows is
 * not an error — the caller just gets no thread.
 */
async function loadConversationThread(
  env: AgentEnv,
  input: AgentInput,
  limit: number,
  maxChars = MAX_THREAD_CHARS,
): Promise<string> {
  if (!input.conversationId) return "";
  try {
    const db = createDb(env.DB);
    const rows = await db
      .select({ direction: messages.direction, body: messages.body })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all();

    const parts = rows
      .filter((r) => r.body)
      .reverse()
      .map((r) => `${r.direction === "in" ? "Customer" : "Agent"}: ${r.body}`);
    if (parts.length === 0) return "";

    let text = `[Previous messages]\n${parts.join("\n")}`;
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
    return text;
  } catch {
    // Conversation read problems must never fail the whole agent pipeline.
    return "";
  }
}

function normalize(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, " ");
}

function cache(env: AgentEnv, config: AgentConfig, key: string, value: string): Promise<void> {
  return env.REPLY_CACHE.put(key, value, { expirationTtl: config.cacheTtlSeconds }).catch(() => {});
}
