/**
 * Narrow an untyped JSON body to a shape we trust.
 *
 * The `as` lives here instead of at each call site on purpose:
 * `Request.json()` is typed `any` in one type program and `unknown` in the
 * other, so call-site assertions are flagged as "unnecessary" by the linter
 * while `tsc` (correctly) rejects the un-narrowed value. One assertion in one
 * place satisfies both.
 */
export function readJson<T>(value: unknown): T {
  return value as T;
}
