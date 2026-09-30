import { describe, expect, it } from "vitest";
import { cliQuotaWindow, percent, remaining } from "../src/adapters/quota-math.js";

describe("percent rounding at the endpoints", () => {
  it("never shows 100% used / 0% left before the quota is exhausted", () => {
    expect(percent(99.97)).toBe(99.9);
    expect(remaining(percent(99.97) as number)).toBe(0.1);
    const w = cliQuotaWindow("session", "5h", "99.96", 300);
    expect(w.used_percent).toBeLessThan(100);
    expect(w.remaining_percent).toBeGreaterThan(0);
  });

  it("keeps a tiny remainder visible", () => {
    // Kimi reports remaining/limit; 1 of 10000 left must not read as 0%.
    expect(percent((1 / 10000) * 100)).toBe(0.1);
  });

  it("keeps exact and ordinary values", () => {
    expect(percent(0)).toBe(0);
    expect(percent(100)).toBe(100);
    expect(percent(150)).toBe(100);
    expect(percent("42.26")).toBe(42.3);
    expect(percent(-1)).toBeNull();
    expect(percent(Number.NaN)).toBeNull();
    expect(percent("1,5")).toBeNull();
  });
});

describe("Claude CLI reset times across a DST change", () => {
  it("uses the offset in force at the reset, not a day earlier", async () => {
    const { parseClaudeCliUsage } = await import("../src/adapters/subscription-quotas.js");
    // US DST starts 2026-03-08 02:00; 3am that day is PDT (UTC-7).
    const quota = parseClaudeCliUsage(
      "Current session: 25% used · resets Mar 8, 3am (America/Los_Angeles)",
      new Date("2026-03-08T06:00:00.000Z"),
    );
    expect(quota.windows[0]?.resets_at).toBe("2026-03-08T10:00:00.000Z");
  });

  it("handles the autumn change too", async () => {
    const { parseClaudeCliUsage } = await import("../src/adapters/subscription-quotas.js");
    // Europe/Berlin leaves CEST 2026-10-25 03:00; 11pm on the 24th is CEST.
    const quota = parseClaudeCliUsage(
      "Current session: 25% used · resets Oct 24, 11pm (Europe/Berlin)",
      new Date("2026-10-24T12:00:00.000Z"),
    );
    expect(quota.windows[0]?.resets_at).toBe("2026-10-24T21:00:00.000Z");
  });
});
