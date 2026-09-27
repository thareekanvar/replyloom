import { describe, it, expect } from "vitest"
import { chunk } from "./chunk.ts"

describe("chunk", () => {
  it("splits a large list into bounded batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})
