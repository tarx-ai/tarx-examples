/** Dedupes provider retries. In-memory is fine for `eve dev`/single instance; use a shared KV in production (SPEC §5). */
export interface IdempotencyStore {
  /** Returns true the first time `key` is seen within the TTL, false for duplicates. */
  claim(key: string, ttlMs?: number): Promise<boolean>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private seen = new Map<string, number>();
  constructor(private defaultTtlMs = 24 * 60 * 60 * 1000, private now: () => number = Date.now, private maxEntries = 10_000) {}
  async claim(key: string, ttlMs = this.defaultTtlMs): Promise<boolean> {
    const t = this.now();
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > t) return false;
    if (this.seen.size >= this.maxEntries) {
      for (const [k, e] of this.seen) if (e <= t) this.seen.delete(k); // drop expired first
      // Still full: evict the oldest insertions (Map preserves insertion order) just enough to fit.
      for (const k of this.seen.keys()) {
        if (this.seen.size < this.maxEntries) break;
        this.seen.delete(k);
      }
    }
    this.seen.set(key, t + ttlMs);
    return true;
  }
}
