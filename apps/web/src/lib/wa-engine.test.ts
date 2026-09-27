import { describe, it, expect } from "vitest"
import { buildEngineHeaders } from "./wa-engine.ts"

describe("buildEngineHeaders", () => {
  it("scopes authenticated engine calls to the active workspace", () => {
    const headers = buildEngineHeaders("engine-secret", "workspace-123")

    expect(headers.get("Authorization")).toBe("Bearer engine-secret")
    expect(headers.get("X-Engine-Workspace")).toBe("workspace-123")
  })
})
