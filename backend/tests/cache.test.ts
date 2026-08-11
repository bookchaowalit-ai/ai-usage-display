import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/lib/cache.js";

describe("TtlCache", () => {
  it("returns miss when empty", () => {
    const cache = new TtlCache<string>(1000);
    expect(cache.get("k")).toEqual({ hit: false });
  });

  it("hits within TTL and misses after expiry", () => {
    const cache = new TtlCache<number>(1000);
    const t0 = 1_000_000;
    cache.set("n", 42, 1000, t0);
    expect(cache.get("n", t0 + 500)).toEqual({ hit: true, value: 42, ageMs: 500 });
    expect(cache.get("n", t0 + 1000)).toEqual({ hit: false });
  });

  it("rejects non-positive TTL", () => {
    expect(() => new TtlCache(0)).toThrow();
  });
});
