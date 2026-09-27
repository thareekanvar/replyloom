import { describe, expect, it } from "vitest";
import { messageStatusFromBaileys } from "../db/sync";

describe("messageStatusFromBaileys", () => {
  it("maps Baileys message update codes to inbox statuses", () => {
    // proto.WebMessageInfo.Status: ERROR, PENDING, SERVER_ACK, DELIVERY_ACK, READ, PLAYED
    expect(messageStatusFromBaileys(0)).toBe("failed");
    expect(messageStatusFromBaileys(1)).toBe("queued");
    expect(messageStatusFromBaileys(2)).toBe("sent");
    expect(messageStatusFromBaileys(3)).toBe("delivered");
    expect(messageStatusFromBaileys(4)).toBe("read");
    expect(messageStatusFromBaileys(5)).toBe("read");
  });

  it("ignores unknown status codes", () => {
    expect(messageStatusFromBaileys(99)).toBeNull();
  });
});
