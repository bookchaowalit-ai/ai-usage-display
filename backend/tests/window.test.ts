import { describe, expect, it } from "vitest";
import { parseWindow, resolveWindow, sqliteSinceClause } from "../src/lib/window.js";

describe("window", () => {
  it("parses valid windows", () => {
    expect(parseWindow("today")).toBe("today");
    expect(parseWindow("7d")).toBe("7d");
    expect(parseWindow("30d")).toBe("30d");
    expect(parseWindow(null)).toBe("today");
  });

  it("rejects invalid windows", () => {
    expect(() => parseWindow("yesterday")).toThrow(/Invalid window/);
  });

  it("resolves today as UTC midnight start", () => {
    const now = new Date("2026-08-08T15:30:00.000Z");
    const tw = resolveWindow("today", now);
    expect(tw.start.toISOString()).toBe("2026-08-08T00:00:00.000Z");
    expect(tw.end.toISOString()).toBe(now.toISOString());
  });

  it("builds sqlite clauses", () => {
    expect(sqliteSinceClause("today").sql).toContain("date(created_at)");
    expect(sqliteSinceClause("7d").params).toEqual(["-7 days"]);
    expect(sqliteSinceClause("30d").params).toEqual(["-30 days"]);
  });
});
