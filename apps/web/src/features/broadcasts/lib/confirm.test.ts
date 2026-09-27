import { describe, expect, it } from "vitest"
import { isPersonalized } from "./confirm"

describe("isPersonalized", () => {
  it("accepts per-recipient variables", () => {
    expect(isPersonalized("Hi {{firstName}}, sale today")).toBe(true)
    expect(isPersonalized("Hello {{ name }}")).toBe(true)
    expect(isPersonalized("Your number {{phone}}")).toBe(true)
  })

  it("rejects identical text for everyone", () => {
    expect(isPersonalized("Big sale today!")).toBe(false)
    expect(isPersonalized("")).toBe(false)
    expect(isPersonalized(undefined)).toBe(false)
  })

  it("doesn't count variables that are the same for many recipients", () => {
    expect(isPersonalized("Hey {{lifecycleStage}} customers")).toBe(false)
    expect(isPersonalized("Hi {{unknown}}")).toBe(false)
  })
})
