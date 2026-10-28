import { describe, it, expect } from "vitest";
import { gatewayRunOptions, FALLBACK_GENERATOR } from "../gateway";
import type { AgentEnv } from "../types";

function env(gatewayId?: string, collectLog?: string): AgentEnv {
  return { AIG_GATEWAY_ID: gatewayId, AIG_COLLECT_LOG: collectLog } as unknown as AgentEnv;
}

describe("gatewayRunOptions", () => {
  it("defaults to the auto-provisioned gateway", () => {
    const opts = gatewayRunOptions(env(undefined), "ws_1", "generator");
    expect(opts.gateway.id).toBe("default");
  });

  it("honors an explicit gateway id from the env var", () => {
    const opts = gatewayRunOptions(env("wa-models"), "ws_1", "generator");
    expect(opts.gateway.id).toBe("wa-models");
  });

  it("tags the request with the workspace and metadata, with collectLog false by default", () => {
    const opts = gatewayRunOptions(env("default"), "abc-123", "classifier");
    expect(opts.tags).toEqual(["ws:abc-123"]);
    expect(opts.gateway.metadata).toEqual({
      workspaceId: "abc-123",
      feature: "classifier",
    });
    expect(opts.gateway.collectLog).toBe(false);
  });

  it("enables collectLog when AIG_COLLECT_LOG is 'true'", () => {
    const opts = gatewayRunOptions(env("default", "true"), "abc-123", "classifier");
    expect(opts.gateway.collectLog).toBe(true);
  });

  it("goes back up to the gateway retries", () => {
    const opts = gatewayRunOptions(env("default"), "abc", "embedding");
    expect(opts.gateway.retries.maxAttempts).toBe(2);
  });
});

describe("FALLBACK_GENERATOR", () => {
  it("is a workers-ai model id", () => {
    expect(FALLBACK_GENERATOR.startsWith("@cf/")).toBe(true);
  });
});