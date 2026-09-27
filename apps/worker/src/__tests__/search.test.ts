import { describe, expect, it } from "vitest";
import { searchVectorId } from "../search";

describe("search vector ids", () => {
  it("stays under Vectorize's 64-byte id limit even for long inputs", async () => {
    const id = await searchVectorId(
      "workspace-with-a-long-nanoid-1234567890",
      "session-uuid-1234-5678-9012-345678901234",
      "3EB0C767D097E9ECC4C7A0",
    );
    expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64);
  });

  it("is deterministic", async () => {
    expect(await searchVectorId("workspace-a", "session-a", "message-1")).toBe(
      await searchVectorId("workspace-a", "session-a", "message-1"),
    );
  });

  it("keeps equal WhatsApp message ids isolated by workspace and session", async () => {
    expect(await searchVectorId("workspace-b", "session-a", "message-1")).not.toBe(
      await searchVectorId("workspace-a", "session-a", "message-1"),
    );
  });
});
