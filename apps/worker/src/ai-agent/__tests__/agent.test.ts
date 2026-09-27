import { describe, it, expect } from "vitest";
import { parseToolArgs } from "../agent";

describe("parseToolArgs", () => {
  it("passes objects through", () => {
    expect(parseToolArgs({ orderId: "1" })).toEqual({ orderId: "1" });
  });

  it("parses JSON strings", () => {
    expect(parseToolArgs('{"reason":"urgent"}')).toEqual({ reason: "urgent" });
    expect(parseToolArgs('"just a string"')).toEqual({});
  });

  it("returns {} for garbage and undefined", () => {
    expect(parseToolArgs("not json")).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
    expect(parseToolArgs(null)).toEqual({});
    expect(parseToolArgs(42)).toEqual({});
  });
});