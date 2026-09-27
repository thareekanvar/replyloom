import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildClassifierPrompt } from "../system-prompt";
import type { AgentConfig } from "../types";

const baseConfig: AgentConfig = {
  workspaceId: "ws-1",
  enabled: true,
  businessName: "Acme Co",
  scopeDescription: "product support and orders",
  replyInGroups: false,
  models: { classifier: "c", generator: "g", embedding: "e" },
  maxContextChunks: 4,
  similarityThreshold: 0.72,
  cacheTtlSeconds: 3600,
};

describe("buildSystemPrompt", () => {
  it("includes greeting instructions when no context is provided", () => {
    const prompt = buildSystemPrompt(baseConfig, [], false);
    expect(prompt).toContain("greeting");
    expect(prompt).toContain("warmly");
    expect(prompt).toContain("Acme Co");
  });

  it("includes grounding rules when context is provided", () => {
    const context = [{ id: "1", text: "We ship worldwide", score: 0.9, source: "faq" }];
    const prompt = buildSystemPrompt(baseConfig, context, true);
    expect(prompt).toContain("CONTEXT");
    expect(prompt).toContain("We ship worldwide");
    expect(prompt).toContain("never guess");
  });

  it("includes custom system prompt when provided", () => {
    const config = { ...baseConfig, systemPrompt: "Always respond in Spanish." };
    const prompt = buildSystemPrompt(config, [], false);
    expect(prompt).toContain("Always respond in Spanish.");
  });
});

describe("buildClassifierPrompt", () => {
  it("classifies greetings as SUPPORT", () => {
    const prompt = buildClassifierPrompt(baseConfig, "hi");
    expect(prompt).toContain("SUPPORT");
    expect(prompt).toContain("hi");
  });

  it("includes all four labels", () => {
    const prompt = buildClassifierPrompt(baseConfig, "hello");
    expect(prompt).toContain("SUPPORT");
    expect(prompt).toContain("CODING");
    expect(prompt).toContain("SENSITIVE");
    expect(prompt).toContain("OFF_TOPIC");
  });
});
