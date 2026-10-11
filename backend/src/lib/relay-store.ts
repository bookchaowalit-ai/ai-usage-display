/**
 * Last usage payload pushed by the host-side relay pusher. Held in memory:
 * the pusher refreshes it every minute, so a restart only empties it briefly.
 */
export interface RelaySnapshot {
  payload: Record<string, unknown>;
  receivedAt: number;
}

export class RelayStore {
  private snapshot: RelaySnapshot | null = null;

  set(payload: Record<string, unknown>, now: number = Date.now()): void {
    this.snapshot = { payload, receivedAt: now };
  }

  get(): RelaySnapshot | null {
    return this.snapshot;
  }

  /** Seconds since the last push, or null when nothing was pushed yet. */
  ageSeconds(now: number = Date.now()): number | null {
    return this.snapshot ? Math.max(0, Math.floor((now - this.snapshot.receivedAt) / 1000)) : null;
  }
}
