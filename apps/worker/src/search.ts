// Semantic search over message history: bge-m3 embeddings (Workers AI),
// stored in a per-account Vectorize index and filtered by workspaceId at
// query time so one workspace never sees another's messages.
import type { Env } from "./index";
import { gatewayRunOptions } from "./ai-agent/gateway";
import { scopedLogger } from "./logger";

const log = scopedLogger("search");

const EMBEDDING_MODEL = "@cf/baai/bge-m3";

// Every message costs an embedding call + a Vectorize write. "ok", "hi",
// "👍", "thanks" carry nothing to semantically search for and are a large
// share of chat traffic -- skip them.
const MIN_INDEXABLE_CHARS = 12;
export function isWorthIndexing(text: string) {
  return text.length >= MIN_INDEXABLE_CHARS && /[\p{L}\p{N}]/u.test(text);
}

/**
 * Vectorize ids must be globally unique, not merely unique within D1, and
 * are capped at 64 bytes. workspaceId (nanoid) + waSessionId (uuid) +
 * messageId (WhatsApp message ids run well past 20 chars, longer for LID
 * jids) blows past that -- e.g. a 32-char workspaceId + 36-char uuid +
 * 21-char message id was already 90+ bytes before the two `:` separators.
 * Hash the composite key instead: 48 hex chars (24 bytes of SHA-256) is
 * far under the limit and collision odds are negligible at this scale.
 * The real workspaceId/waSessionId/messageId all still live in metadata
 * (see indexMessageForSearch), so nothing needs to parse this id back.
 */
export async function searchVectorId(workspaceId: string, waSessionId: string, messageId: string): Promise<string> {
  const input = `${workspaceId}:${waSessionId}:${messageId}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48);
}

async function embed(env: Env, text: string, workspaceId: string): Promise<number[]> {
  const result: any = await env.AI.run(
    EMBEDDING_MODEL,
    { text: [text] },
    gatewayRunOptions(env, workspaceId, "search-embedding"),
  );
  const vector = result?.data?.[0];
  if (!Array.isArray(vector)) throw new Error("Embedding model returned no vector");
  return vector;
}

/**
 * Embeds a message and upserts it into Vectorize. Skips silently on
 * failure (Workers AI hiccup, empty text) -- search is a nice-to-have,
 * it should never take down message sync.
 */
export async function indexMessageForSearch(
  env: Env,
  params: {
    messageId: string;
    workspaceId: string;
    waSessionId: string;
    conversationId: string;
    text: string;
    isGroup?: boolean;
    groupName?: string | null;
    senderName?: string | null;
    senderJid?: string | null;
  },
) {
  const text = params.text.trim();
  if (!isWorthIndexing(text)) return { indexed: false };
  try {
    const vector = await embed(env, text, params.workspaceId);
    const vectorId = await searchVectorId(params.workspaceId, params.waSessionId, params.messageId);
    await env.VECTORIZE.upsert([
      {
        id: vectorId,
        values: vector,
        metadata: {
          workspaceId: params.workspaceId,
          waSessionId: params.waSessionId,
          conversationId: params.conversationId,
          // The vector id is now a hash (see searchVectorId) so the real
          // WhatsApp message id has to travel in metadata for
          // semanticSearch to return it.
          messageId: params.messageId,
          text: text.slice(0, 500),
          isGroup: params.isGroup ?? false,
          ...(params.groupName ? { groupName: params.groupName } : {}),
          ...(params.senderName ? { senderName: params.senderName } : {}),
          ...(params.senderJid ? { senderJid: params.senderJid } : {}),
        },
      },
    ]);
    return { indexed: true };
  } catch (error) {
    log.error({ workspaceId: params.workspaceId, messageId: params.messageId, error }, "search indexing failed");
    return { indexed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Batch variant for reindexing: one embedding call + one Vectorize upsert
 * per batch instead of one of each per message. */
export async function indexMessagesForSearch(
  env: Env,
  workspaceId: string,
  items: { messageId: string; waSessionId: string; conversationId: string; text: string }[],
) {
  const valid = items.map((i) => ({ ...i, text: i.text.trim() })).filter((i) => isWorthIndexing(i.text));
  if (valid.length === 0) return { indexed: 0 };
  try {
    const result: any = await env.AI.run(
      EMBEDDING_MODEL,
      { text: valid.map((i) => i.text) },
      gatewayRunOptions(env, workspaceId, "search-embedding"),
    );
    const vectors: number[][] = result?.data ?? [];
    const upserts = await Promise.all(
      valid.map(async (item, idx) => ({
        id: await searchVectorId(workspaceId, item.waSessionId, item.messageId),
        values: vectors[idx],
        metadata: {
          workspaceId,
          waSessionId: item.waSessionId,
          conversationId: item.conversationId,
          messageId: item.messageId,
          text: item.text.slice(0, 500),
        },
      })),
    );
    const ready = upserts.filter((u) => Array.isArray(u.values));
    if (ready.length) await env.VECTORIZE.upsert(ready);
    return { indexed: ready.length };
  } catch (error) {
    log.error({ workspaceId, error }, "batch search indexing failed");
    return { indexed: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface SearchMatch {
  messageId: string;
  score: number;
  conversationId: string;
  waSessionId: string;
  text: string;
  isGroup?: boolean;
  groupName?: string | null;
  senderName?: string | null;
  senderJid?: string | null;
}

/** Semantic search over a workspace's messages, most relevant first. */
export async function semanticSearch(env: Env, workspaceId: string, query: string, topK = 10): Promise<SearchMatch[]> {
  const vector = await embed(env, query, workspaceId);
  const result = await env.VECTORIZE.query(vector, {
    topK,
    filter: { workspaceId },
    returnMetadata: "all",
  });

  return result.matches.map((m) => ({
    // Prior to the hashed-id change above, m.id *was* the WhatsApp message
    // id; fall back to it for any vectors upserted before this change that
    // haven't been reindexed yet.
    messageId: (m.metadata?.messageId as string | undefined) ?? m.id,
    score: m.score,
    conversationId: (m.metadata?.conversationId as string | undefined) ?? "",
    waSessionId: (m.metadata?.waSessionId as string | undefined) ?? "",
    text: (m.metadata?.text as string | undefined) ?? "",
    isGroup: (m.metadata?.isGroup as boolean | undefined) ?? false,
    groupName: (m.metadata?.groupName as string | null | undefined) ?? null,
    senderName: (m.metadata?.senderName as string | null | undefined) ?? null,
    senderJid: (m.metadata?.senderJid as string | null | undefined) ?? null,
  }));
}
