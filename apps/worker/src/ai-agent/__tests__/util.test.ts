import { describe, it, expect } from "vitest";
import { customerPhoneFromJid } from "../util";

describe("customerPhoneFromJid", () => {
  it("extracts bare digits from a whatsapp jid", () => {
    expect(customerPhoneFromJid("19993334444@s.whatsapp.net")).toBe("19993334444");
  });

  it("returns null for group, lid, newsletter jids and empty input", () => {
    expect(customerPhoneFromJid("12345678901@g.us")).toBeNull();
    expect(customerPhoneFromJid("12345@lid")).toBeNull();
    expect(customerPhoneFromJid("x@newsletter")).toBeNull();
    expect(customerPhoneFromJid("")).toBeNull();
    expect(customerPhoneFromJid(undefined)).toBeNull();
  });
});