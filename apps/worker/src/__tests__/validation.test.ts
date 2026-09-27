import { describe, it, expect } from "vitest";
import {
  SearchBodySchema,
  ReindexBodySchema,
  AgentReplyBodySchema,
  AgentIngestBodySchema,
  AgentConfigBodySchema,
  AgentToolBodySchema,
} from "../validation";

describe("SearchBodySchema", () => {
  it("accepts valid search body", () => {
    const result = SearchBodySchema.safeParse({ workspaceId: "ws1", query: "hello" });
    expect(result.success).toBe(true);
  });

  it("applies default topK", () => {
    const result = SearchBodySchema.safeParse({ workspaceId: "ws1", query: "hello" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.topK).toBe(10);
  });

  it("rejects missing workspaceId", () => {
    expect(SearchBodySchema.safeParse({ query: "hello" }).success).toBe(false);
  });

  it("rejects missing query", () => {
    expect(SearchBodySchema.safeParse({ workspaceId: "ws1" }).success).toBe(false);
  });

  it("rejects topK out of range", () => {
    expect(SearchBodySchema.safeParse({ workspaceId: "ws1", query: "hi", topK: 0 }).success).toBe(false);
    expect(SearchBodySchema.safeParse({ workspaceId: "ws1", query: "hi", topK: 51 }).success).toBe(false);
  });
});

describe("ReindexBodySchema", () => {
  it("accepts valid reindex body", () => {
    const result = ReindexBodySchema.safeParse({ workspaceId: "ws1" });
    expect(result.success).toBe(true);
  });

  it("applies defaults", () => {
    const result = ReindexBodySchema.safeParse({ workspaceId: "ws1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(200);
      expect(result.data.offset).toBe(0);
    }
  });

  it("rejects limit > 500", () => {
    expect(ReindexBodySchema.safeParse({ workspaceId: "ws1", limit: 501 }).success).toBe(false);
  });
});

describe("AgentReplyBodySchema", () => {
  it("accepts valid reply body", () => {
    const result = AgentReplyBodySchema.safeParse({ workspaceId: "ws1", message: "hi" });
    expect(result.success).toBe(true);
  });

  it("rejects missing message", () => {
    expect(AgentReplyBodySchema.safeParse({ workspaceId: "ws1" }).success).toBe(false);
  });

  it("applies default isGroup=false", () => {
    const result = AgentReplyBodySchema.safeParse({ workspaceId: "ws1", message: "hi" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isGroup).toBe(false);
  });
});

describe("AgentIngestBodySchema", () => {
  it("accepts valid ingest body", () => {
    const result = AgentIngestBodySchema.safeParse({
      workspaceId: "ws1",
      source: "faq",
      text: "Hello world",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty text", () => {
    expect(AgentIngestBodySchema.safeParse({ workspaceId: "ws1", source: "faq", text: "" }).success).toBe(false);
  });

  it("rejects text > 100k chars", () => {
    expect(AgentIngestBodySchema.safeParse({ workspaceId: "ws1", source: "faq", text: "x".repeat(100_001) }).success).toBe(false);
  });

  it("rejects source > 200 chars", () => {
    expect(AgentIngestBodySchema.safeParse({ workspaceId: "ws1", source: "x".repeat(201), text: "hi" }).success).toBe(false);
  });
});

describe("AgentConfigBodySchema", () => {
  it("accepts valid config update", () => {
    const result = AgentConfigBodySchema.safeParse({ workspaceId: "ws1", enabled: true });
    expect(result.success).toBe(true);
  });

  it("rejects when only workspaceId is provided (no config fields)", () => {
    expect(AgentConfigBodySchema.safeParse({ workspaceId: "ws1" }).success).toBe(false);
  });

  it("validates similarityThreshold range", () => {
    expect(AgentConfigBodySchema.safeParse({ workspaceId: "ws1", similarityThreshold: -0.1 }).success).toBe(false);
    expect(AgentConfigBodySchema.safeParse({ workspaceId: "ws1", similarityThreshold: 1.1 }).success).toBe(false);
    expect(AgentConfigBodySchema.safeParse({ workspaceId: "ws1", similarityThreshold: 0.5 }).success).toBe(true);
  });
});

describe("AgentToolBodySchema", () => {
  it("accepts valid tool body", () => {
    const result = AgentToolBodySchema.safeParse({
      workspaceId: "ws1",
      name: "get_order",
      description: "Get order status",
      url: "https://api.example.com/order",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid URL", () => {
    expect(AgentToolBodySchema.safeParse({
      workspaceId: "ws1", name: "x", description: "y", url: "not-a-url",
    }).success).toBe(false);
  });

  it("applies default method=POST", () => {
    const result = AgentToolBodySchema.safeParse({
      workspaceId: "ws1", name: "x", description: "y", url: "https://example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.method).toBe("POST");
  });
});
