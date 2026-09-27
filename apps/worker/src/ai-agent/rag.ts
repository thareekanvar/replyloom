import { createDb, inArray, eq, and, docChunks } from "@workspace/db";
import type { AgentConfig, AgentEnv, RetrievedChunk } from "./types";
import { gatewayRunOptions } from "./gateway";

async function embed(env: AgentEnv, model: string, texts: string[], workspaceId: string): Promise<number[][]> {
  const result: any = await env.AI.run(
    model,
    { text: texts },
    gatewayRunOptions(env, workspaceId, "embedding"),
  );
  const data = result?.data;
  if (!Array.isArray(data)) throw new Error("Embedding model returned no data");
  return data as number[][];
}

/**
 * Retrieves the top matching chunks for a workspace, filtered by the
 * similarity threshold so low-confidence matches never reach the model as
 * "context" — the main anti-hallucination lever alongside the system prompt.
 * Returns [] when nothing clears the bar; callers must treat that as "I
 * don't have this information", never as a cue to free-wheeling.
 */
export async function retrieveContext(
  env: AgentEnv,
  config: AgentConfig,
  query: string,
): Promise<RetrievedChunk[]> {
  const [embedding] = await embed(env, config.models.embedding, [query], config.workspaceId);

  const matches = await env.AGENT_VECTORIZE.query(embedding, {
    topK: config.maxContextChunks,
    filter: { workspaceId: config.workspaceId },
    returnMetadata: true,
  });

  const above = matches.matches.filter((m) => m.score >= config.similarityThreshold);
  if (above.length === 0) return [];

  const ids = above.map((m) => m.id);
  const db = createDb(env.DB);
  const rows = await db
    .select({ id: docChunks.id, text: docChunks.text, source: docChunks.source })
    .from(docChunks)
    .where(and(eq(docChunks.workspaceId, config.workspaceId), inArray(docChunks.id, ids)))
    .all();

  const byId = new Map(rows.map((r) => [r.id, r]));
  return above
    .map((m) => {
      const row = byId.get(m.id);
      if (!row) return null; // vector in index but row gone (deleted) — skip
      return { id: row.id, text: row.text, source: row.source, score: m.score };
    })
    .filter((c): c is RetrievedChunk => c !== null);
}

/**
 * Ingests a document into the agent's grounding store: chunk -> embed ->
 * upsert into Vectorize + D1. Called from an admin/ingestion endpoint when
 * docs change, not per message. Passing `docId` replaces any previous
 * chunks with the same docId first, so re-ingesting a source never leaves
 * stale grounding around.
 */
export async function ingestDocument(
  env: AgentEnv,
  config: AgentConfig,
  params: { source: string; text: string; docId?: string; chunkSize?: number },
): Promise<{ chunks: number; deleted?: number }> {
  const chunkSize = params.chunkSize ?? 800;
  const chunks = chunkText(params.text, chunkSize);
  if (chunks.length === 0) return { chunks: 0 };

  const db = createDb(env.DB);
  let deleted = 0;
  if (params.docId) {
    const olds = await db
      .select({ id: docChunks.id })
      .from(docChunks)
      .where(and(eq(docChunks.workspaceId, config.workspaceId), eq(docChunks.docId, params.docId)))
      .all();
    if (olds.length > 0) {
      const oldIds = olds.map((o) => o.id);
      // Best-effort vector cleanup first (index may lag a delete, D1 is source of truth).
      await env.AGENT_VECTORIZE.deleteByIds(oldIds).catch(() => {});
      await db.delete(docChunks).where(inArray(docChunks.id, oldIds));
      deleted = oldIds.length;
    }
  }

  const vectors = await embed(env, config.models.embedding, chunks, config.workspaceId);
  const inserts = chunks.map((text, i) => {
    const id = crypto.randomUUID();
    return { id, text, vector: vectors[i] };
  });

  // D1 batch needs a non-empty tuple; chunks is guaranteed non-empty here.
  const statements = inserts.map((c) =>
    db.insert(docChunks).values({
      id: c.id,
      workspaceId: config.workspaceId,
      docId: params.docId ?? null,
      source: params.source,
      text: c.text,
    }),
  );
  await db.batch(statements as unknown as [(typeof statements)[number], ...(typeof statements)[number][]]);

  await env.AGENT_VECTORIZE.upsert(
    inserts.map((c) => ({
      id: c.id,
      values: c.vector,
      metadata: { workspaceId: config.workspaceId, docId: params.docId ?? "" },
    })),
  );

  return { chunks: inserts.length, deleted };
}

/**
 * Paragraph-aware chunking: packs paragraphs into chunks up to `size`
 * characters instead of blindly slicing at an exact offset, so a chunk
 * rarely cuts a thought in half (better match quality, and the vectorizer
 * gets coherent units to embed). Falls back to hard-slicing a single
 * over-long paragraph.
 */
export function chunkText(text: string, size = 800): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n\s*\n/).filter((p) => p.trim());
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const c = current.trim();
    if (c) chunks.push(c);
    current = "";
  };

  for (const p of paragraphs) {
    if (p.length > size) {
      // Flush the accumulator before hard-slicing a monster paragraph.
      if (current) flush();
      for (let i = 0; i < p.length; i += size) {
        chunks.push(p.slice(i, i + size).trim());
      }
      continue;
    }
    if (current.length > 0 && current.length + p.length + 1 > size) flush();
    current = current ? `${current}\n${p}` : p;
  }
  flush();
  return chunks;
}