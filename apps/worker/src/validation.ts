// Zod schemas for worker HTTP endpoint input validation.
import { z } from "zod";

const workspaceId = z.string().min(1, "Missing 'workspaceId'");
const nonEmptyString = z.string().min(1);

export const SearchBodySchema = z.object({
  workspaceId,
  query: nonEmptyString.min(1, "Missing 'query'"),
  topK: z.number().int().min(1).max(50).optional().default(10),
});

export const ReindexBodySchema = z.object({
  workspaceId,
  limit: z.number().int().min(1).max(500).optional().default(200),
  offset: z.number().int().min(0).optional().default(0),
  // Keyset cursor (the last wa_message_id seen). Preferred over offset:
  // OFFSET re-reads every skipped row, so each later batch got slower.
  cursor: z.string().max(200).optional(),
});

export const AgentReplyBodySchema = z.object({
  workspaceId,
  message: nonEmptyString.min(1, "Missing 'message'"),
  conversationId: z.string().optional(),
  waSessionId: z.string().optional(),
  remoteJid: z.string().optional(),
  phone: z.string().optional(),
  isGroup: z.boolean().optional().default(false),
});

export const AgentIngestBodySchema = z.object({
  workspaceId,
  source: nonEmptyString.max(200),
  text: z.string().min(1, "Missing 'text'").max(100_000, "Text too large"),
  docId: z.string().max(120).optional(),
  chunkSize: z.number().int().min(300).max(2000).optional(),
});

export const AgentConfigBodySchema = z
  .object({
    workspaceId,
    enabled: z.boolean().optional(),
    businessName: z.string().nullable().optional(),
    scopeDescription: z.string().nullable().optional(),
    systemPrompt: z.string().nullable().optional(),
    classifierModel: z.string().nullable().optional(),
    generatorModel: z.string().nullable().optional(),
    embeddingModel: z.string().nullable().optional(),
    maxContextChunks: z.number().int().min(1).max(10).optional(),
    similarityThreshold: z.number().min(0).max(1).optional(),
    cacheTtlSeconds: z.number().int().min(0).optional(),
    replyInGroups: z.boolean().optional(),
  })
  .refine(
    (data) => {
      const { workspaceId: _, ...rest } = data;
      return Object.keys(rest).length > 0;
    },
    { message: "No config fields provided" },
  );

export const AgentToolBodySchema = z.object({
  workspaceId,
  name: nonEmptyString,
  description: nonEmptyString,
  url: z.string().url("Invalid URL"),
  parameters: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  method: z.enum(["GET", "POST"]).optional().default("POST"),
  authToken: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export type SearchBody = z.infer<typeof SearchBodySchema>;
export type ReindexBody = z.infer<typeof ReindexBodySchema>;
export type AgentReplyBody = z.infer<typeof AgentReplyBodySchema>;
export type AgentIngestBody = z.infer<typeof AgentIngestBodySchema>;
export type AgentConfigBody = z.infer<typeof AgentConfigBodySchema>;
export type AgentToolBody = z.infer<typeof AgentToolBodySchema>;
