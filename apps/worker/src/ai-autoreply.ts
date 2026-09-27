// Bridges the generic AI agent to the WhatsApp inbound path. Kept out of
// whatsapp-session.ts so the session class stays focused on Baileys, and so
// the same agent can also be driven by the HTTP integration surface.
//
// Runs only when the workspace has opted in (agent_configs.enabled), honours
// the existing auto-reply access rules (blacklist/whitelist), and defaults to
// private chats unless the workspace sets replyInGroups. Keyword auto-reply
// rules run first (in whatsapp-session.ts) — this is the fallback when no
// canned rule matched.
import type { Env } from "./index";
import { createDb } from "@workspace/db";
import { isBlocked } from "./automation";
import { loadAgentConfig } from "./ai-agent/config";
import { handleAgentMessage } from "./ai-agent/agent";

export interface AiAutoReplyParams {
  waSessionId: string;
  workspaceId: string;
  conversationId: string;
  remoteJid: string;
  senderJid: string;
  isGroup: boolean;
  body: string;
}

// Anti-abuse: per-conversation cap on how many times the agent is invoked
// (an LLM pipeline costs real money per call, and a chatty customer could
// otherwise burn unbounded spend by paraphrasing the same question). The
// window is a rolling one — every handled message slides the expiry, so a
// quiet gap resets it. 0 = fully off to be safe.
const RATE_WINDOW_SECONDS = 300; // 5 minutes
const MAX_AGENT_INVOCATIONS_PER_WINDOW = 5;

/** Returns the reply text to send, or null if the agent is off / should stay quiet. */
export async function maybeAiAutoReply(env: Env, params: AiAutoReplyParams): Promise<string | null> {
  const config = await loadAgentConfig(env, params.workspaceId);
  if (!config.enabled) return null;
  if (params.isGroup && !config.replyInGroups) return null;

  const db = createDb(env.DB);
  if (await isBlocked(db, params.workspaceId, params.waSessionId, "auto_reply", params.senderJid)) return null;

  // Rate-limit BEFORE doing any expensive work (classifier/RAG/generation).
  // KV read-modify-write counter, sliding-window via a fresh TTL on every
  // write. On a KV failure we fail OPEN (count 0) so a cache hiccup never
  // silences a customer; the classifier gate is the real backstop.
  const bucket = params.conversationId;
  const rlKey = `agent:rl:${params.workspaceId}:${bucket}`;
  let count = 0;
  try {
    const parsed = Number((await env.REPLY_CACHE.get(rlKey)) ?? 0);
    count = Number.isFinite(parsed) ? parsed : 0;
  } catch {
    count = 0;
  }
  if (count >= MAX_AGENT_INVOCATIONS_PER_WINDOW) {
    // Stay completely quiet — don't even tell the customer we're throttled,
    // that would just invite more messages.
    return null;
  }
  // write-back the incremented counter (KV has no atomic increment in the
  // stable typing, so this is a soft, best-effort limiter — the classifier
  // gate + per-message spend caps are the real backstops).
  count += 1;
  await env.REPLY_CACHE
    .put(rlKey, String(count), { expirationTtl: RATE_WINDOW_SECONDS })
    .catch(() => {});

  const reply = await handleAgentMessage(env, config, {
    message: params.body,
    conversationId: params.conversationId,
    waSessionId: params.waSessionId,
    remoteJid: params.remoteJid,
    senderJid: params.senderJid,
    isGroup: params.isGroup,
  });
  return reply.text || null;
}