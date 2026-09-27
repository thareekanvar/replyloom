import { describe, it, expect } from "vitest"
import { getPagination, getTotalPages, shouldFetchNextPage } from "./pagination.ts"

describe("getPagination", () => {
  it("uses a small bounded default page size", () => {
    expect(getPagination()).toEqual({ page: 1, pageSize: 25, offset: 0 })
  })

  it("clamps invalid and oversized values", () => {
    expect(getPagination({ page: 0, pageSize: 400 })).toEqual({
      page: 1,
      pageSize: 100,
      offset: 0,
    })
  })

  it("fetches only when the local table is at its last page", () => {
    expect(shouldFetchNextPage(false, true)).toBe(true)
    expect(shouldFetchNextPage(true, true)).toBe(false)
    expect(shouldFetchNextPage(false, false)).toBe(false)
  })

  it("calculates total pages without loading all rows", () => {
    expect(getTotalPages(41, 20)).toBe(3)
    expect(getTotalPages(0, 20)).toBe(0)
  })
})
