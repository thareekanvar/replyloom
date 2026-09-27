// Drizzle's sqlite `{ mode: "timestamp" }` columns come back as real Date
// objects on the server. Server functions convert them to plain epoch
// seconds explicitly (rather than letting a Date cross the client/server
// RPC boundary as-is) so the wire format is unambiguous and every UI
// component can treat these fields as `number | null` for real, no `as any`.
export function toEpochSeconds(d: Date | null | undefined): number | null {
  if (!d) return null
  return Math.floor(d.getTime() / 1000)
}
