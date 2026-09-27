import { describe, it, expect } from "vitest";
import { assertCallerWorkspace, unauthorized, forbidden } from "../security";
import type { Caller } from "../security";

describe("unauthorized", () => {
  it("returns 401 with ok:false", () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
  });
});

describe("forbidden", () => {
  it("returns 403 with ok:false", () => {
    const res = forbidden();
    expect(res.status).toBe(403);
  });
});

describe("assertCallerWorkspace", () => {
  it("returns null when caller workspace matches", () => {
    const caller: Caller = { kind: "internal", workspaceId: "ws1" };
    expect(assertCallerWorkspace(caller, "ws1")).toBeNull();
  });

  it("returns 403 Response when caller workspace mismatches", () => {
    const caller: Caller = { kind: "api", workspaceId: "ws1" };
    const res = assertCallerWorkspace(caller, "ws2");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("works for both internal and api caller kinds", () => {
    const internal: Caller = { kind: "internal", workspaceId: "ws1" };
    const api: Caller = { kind: "api", workspaceId: "ws1" };
    expect(assertCallerWorkspace(internal, "ws1")).toBeNull();
    expect(assertCallerWorkspace(api, "ws1")).toBeNull();
  });
});
