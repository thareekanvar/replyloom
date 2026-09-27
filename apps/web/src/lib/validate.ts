import { UserFacingError } from "./errors"

/**
 * Runtime input validation helpers for server functions.
 *
 * The TypeScript types on a `.validator((data: T) => data)` cast say nothing
 * about what actually arrives over the wire -- that callback is an identity
 * function, so anything JSON-shaped reaches the handler. Use these where a
 * bad value would otherwise end up in SQL, a URL or an outbound API call.
 */

/** Throws unless `value` is one of `allowed` (first issue, user-facing). */
export function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new UserFacingError(`Invalid ${field}.`)
  }
}

/**
 * A safe integer within `[min, max]` -- rejects strings, NaN, Infinity and
 * floats, which SQLite would happily coerce (or store as text) instead of
 * erroring on.
 */
export function assertIntInRange(
  value: unknown,
  field: string,
  min: number,
  max: number
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new UserFacingError(`Invalid ${field}.`)
  }
}

/** Bounded free text: trims nothing, just refuses pathological input. */
export function assertShortText(
  value: unknown,
  field: string,
  maxLength: number
): asserts value is string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new UserFacingError(`Invalid ${field}.`)
  }
}
