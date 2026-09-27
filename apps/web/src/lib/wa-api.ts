// Browser-facing helper for the `worker` app (apps/worker).
//
// Only the relative media URL builder is exported. Everything else that
// talks to the engine goes through server functions (lib/wa-server.ts),
// which attach the internal secret server-side -- a client module must
// never hold `WA_INTERNAL_SECRET`, or it would ship in the public bundle.

export const waApi = {
  mediaUrl: (mediaKey: string) =>
    `/api/media?key=${encodeURIComponent(mediaKey)}`,
}
