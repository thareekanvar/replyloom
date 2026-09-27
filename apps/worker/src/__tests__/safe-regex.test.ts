import { describe, expect, it } from "vitest";
import { matchRulePattern, validateRulePattern } from "@workspace/db";

describe("auto-reply regex safety", () => {
  it("accepts ordinary patterns", () => {
    for (const p of ["^price\\b", "hello|hi|hey", "order\\s*#?\\d{3,8}", "(yes|no)", "colou?r"]) {
      expect(validateRulePattern(p)).toBeNull();
    }
  });
  it("rejects catastrophic-backtracking shapes, backrefs, invalid and oversized patterns", () => {
    for (const p of ["(a+)+$", "(a*)*b", "(a|ab)*c", "(\\w+\\s?){2,}$", "(.*a){12}", "(x)\\1", "(?<=a)b", "(", "a".repeat(201)]) {
      expect(validateRulePattern(p)).not.toBeNull();
    }
  });
  it("an unsafe pattern never runs, and matching stays fast on hostile input", () => {
    const hostile = "a".repeat(50_000) + "!";
    const t = performance.now();
    expect(matchRulePattern("(a+)+$", hostile)).toBe(false);
    expect(matchRulePattern("hello", "well HELLO there")).toBe(true);
    expect(matchRulePattern("^a+$", hostile)).toBe(true); // runs on the first 1,000 chars only
    expect(performance.now() - t).toBeLessThan(200);
  });
});
