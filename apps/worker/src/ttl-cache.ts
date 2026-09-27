// Tiny per-isolate TTL cache for hot, rarely-changing lookups on the
// message path (blocked check, webhooks, auto-reply/access rules, agent
// config, group names). Every WhatsApp message used to re-read these from
// D1 even though they change a few times a day. Entries expire on their
// own; writers that know about a change call `invalidate` for their key.
// Promises are cached (not values) so concurrent callers share one query.

export class TtlCache<T> {
  private entries = new Map<string, { value: Promise<T>; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5000
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value;
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    const value = load();
    this.entries.set(key, { value, expires: now + this.ttlMs });
    // Never cache a failure.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  invalidate(key: string) {
    this.entries.delete(key);
  }

  invalidatePrefix(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}
