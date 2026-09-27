import { describe, it, expect } from "vitest";
import { matchesStopKeyword, effectiveDailyBroadcastLimit } from "@workspace/db";

describe("matchesStopKeyword", () => {
  it.each([
    "STOP",
    "stop!!",
    " Stop. ",
    "Unsubscribe",
    "opt-out",
    "Remove me 🙏",
    "إلغاء الاشتراك",
    "الغاء الاشتراك",
    "توقف",
    "بند کرو",
    "बंद करो",
    "band karo",
    "നിർത്തുക",
    "நிறுத்து",
    "Arrêter",
    "désabonner",
    "darme de baja",
    "abmelden",
    "berhenti",
  ])("opts out on %s", (body) => {
    expect(matchesStopKeyword(body)).toBe(true);
  });

  it.each([
    "don't stop the order",
    "cancel",
    "cancel my order",
    "para mañana",
    "Can you stop by the shop tomorrow at 5 and pick up the parcel?",
    "",
    null,
  ])("does not opt out on %s", (body) => {
    expect(matchesStopKeyword(body)).toBe(false);
  });
});

describe("effectiveDailyBroadcastLimit", () => {
  const now = new Date("2026-09-26T00:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it("scales with number age and never drops below the floor", () => {
    expect(effectiveDailyBroadcastLimit(daysAgo(1), now)).toBe(25);
    expect(effectiveDailyBroadcastLimit(daysAgo(10), now)).toBe(125);
    expect(effectiveDailyBroadcastLimit(daysAgo(60), now)).toBe(250);
    expect(effectiveDailyBroadcastLimit(null, now)).toBe(25);
  });
});
