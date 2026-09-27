import { describe, expect, it } from "vitest"
import { decodeCursor, encodeCursor, toCursorPage } from "./cursor"

describe("cursor", () => {
  it("round-trips keys, including unicode strings", () => {
    const c = encodeCursor([1790000000, "abc-123", "مرحبا"])
    expect(decodeCursor(c, ["n", "s", "s"] as const)).toEqual([1790000000, "abc-123", "مرحبا"])
  })
  it("returns null for the first page", () => {
    expect(decodeCursor(undefined, ["n"] as const)).toBeNull()
  })
  it("rejects tampered / wrong-shape cursors", () => {
    expect(() => decodeCursor("not-base64-json", ["n"] as const)).toThrow()
    expect(() => decodeCursor(encodeCursor(["x"]), ["n"] as const)).toThrow()
    expect(() => decodeCursor(encodeCursor([1, "a"]), ["n"] as const)).toThrow()
  })
  it("builds the next cursor from the last visible row", () => {
    const rows = [{ t: 3, id: "c" }, { t: 2, id: "b" }, { t: 1, id: "a" }]
    const page = toCursorPage(rows, 2, (r) => [r.t, r.id])
    expect(page.items).toHaveLength(2)
    expect(page.hasMore).toBe(true)
    expect(decodeCursor(page.nextCursor, ["n", "s"] as const)).toEqual([2, "b"])
    expect(toCursorPage(rows, 5, (r) => [r.t, r.id]).nextCursor).toBeNull()
  })
})
