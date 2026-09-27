/** An error whose message is safe to show to an API caller.
 *
 * Everything thrown inside a request handler that is NOT a PublicError is
 * treated as internal: the caller only ever sees a generic message (the
 * detail is logged via `captureError`), so D1 SQL text, provider payloads
 * and internal paths never reach the browser.
 */
export class PublicError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

/** User-facing message for a caught error, or `fallback` when internal. */
export function publicMessage(err: unknown, fallback: string): string {
  return err instanceof PublicError ? err.message : fallback;
}

/** HTTP status for a caught error (500 unless it is a PublicError). */
export function publicStatus(err: unknown, fallback = 500): number {
  return err instanceof PublicError ? err.status : fallback;
}
