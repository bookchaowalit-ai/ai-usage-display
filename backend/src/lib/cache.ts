export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  storedAt: number;
}

/**
 * Simple in-memory TTL cache. Suitable for a single Node process
 * serving a handful of ESP32 devices.
 */
export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  constructor(private readonly defaultTtlMs: number) {
    if (defaultTtlMs <= 0) {
      throw new Error("defaultTtlMs must be positive");
    }
  }

  get(key: string, now = Date.now()): { hit: true; value: T; ageMs: number } | { hit: false } {
    const entry = this.store.get(key);
    if (!entry) return { hit: false };
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return { hit: false };
    }
    return { hit: true, value: entry.value, ageMs: now - entry.storedAt };
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs, now = Date.now()): void {
    this.store.set(key, {
      value,
      storedAt: now,
      expiresAt: now + ttlMs,
    });
  }

  /** Return a non-expired or expired entry without deleting (for stale serve). */
  peek(key: string): CacheEntry<T> | undefined {
    return this.store.get(key);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
