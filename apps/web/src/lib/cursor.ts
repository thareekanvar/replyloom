// Opaque keyset-pagination cursors. A cursor is the sort key of the last row
// on a page (e.g. [created_at, id]) as base64url(JSON). The server decodes it
// into a `(k1, k2) < (?, ?)` style predicate that SQLite serves as an index
// range seek -- constant cost at any depth, and no skipped/duplicated rows
// when new rows arrive between page fetches (both OFFSET failure modes).
import { UserFacingError } from "./errors"

export type CursorValue = string | number
export type CursorKey = CursorValue[]

export const DEFAULT_CURSOR_LIMIT = 25
export const MAX_CURSOR_LIMIT = 100

export function cursorLimit(limit?: number, fallback = DEFAULT_CURSOR_LIMIT) {
  if (!Number.isFinite(limit)) return fallback
  return Math.min(MAX_CURSOR_LIMIT, Math.max(1, Math.floor(limit!)))
}

function toBase64Url(text: string) {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(text: string) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export function encodeCursor(key: CursorKey): string {
  return toBase64Url(JSON.stringify(key))
}

/**
 * Decodes and validates a cursor against its expected shape ("n" = number,
 * "s" = string). Returns null for "no cursor" (first page); throws a
 * user-facing error for anything malformed so a tampered cursor can never
 * reach SQL as the wrong type.
 */
export function decodeCursor<const TShape extends readonly ("n" | "s")[]>(
  cursor: string | null | undefined,
  shape: TShape
): { [I in keyof TShape]: TShape[I] extends "n" ? number : string } | null {
  if (!cursor) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(cursor))
  } catch {
    throw new UserFacingError("Invalid page cursor. Please refresh.")
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== shape.length ||
    parsed.some((v, i) =>
      shape[i] === "n"
        ? typeof v !== "number" || !Number.isFinite(v)
        : typeof v !== "string" || v.length > 512
    )
  ) {
    throw new UserFacingError("Invalid page cursor. Please refresh.")
  }
  return parsed as never
}

/** Rows were fetched with LIMIT limit+1: trims the probe row and builds the
 * next cursor from the last visible row. */
export function toCursorPage<T>(rows: T[], limit: number, keyOf: (row: T) => CursorKey) {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items.at(-1)
  return {
    items,
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
  }
}

/** Raw epoch-seconds value of a `integer(mode: "timestamp")` column read via
 * sql`` (Drizzle doesn't map it to a Date there). */
export function epochOf(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
