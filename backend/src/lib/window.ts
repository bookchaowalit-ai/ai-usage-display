import type { UsageWindow } from "../types/usage.js";

export interface TimeWindow {
  window: UsageWindow;
  /** Inclusive start (UTC). */
  start: Date;
  /** Exclusive end (UTC). */
  end: Date;
  /** Unix seconds (OpenAI). */
  startUnix: number;
  endUnix: number;
  /** RFC3339 for Anthropic. */
  startingAt: string;
  endingAt: string;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function parseWindow(raw: string | null | undefined): UsageWindow {
  const v = (raw ?? "today").toLowerCase().trim();
  if (v === "today" || v === "7d" || v === "30d") return v;
  throw new Error(`Invalid window "${raw}". Use today, 7d, or 30d.`);
}

export function resolveWindow(window: UsageWindow, now: Date = new Date()): TimeWindow {
  const end = now;
  let start: Date;
  if (window === "today") {
    start = startOfUtcDay(now);
  } else if (window === "7d") {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else {
    start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return {
    window,
    start,
    end,
    startUnix: Math.floor(start.getTime() / 1000),
    endUnix: Math.floor(end.getTime() / 1000),
    startingAt: start.toISOString(),
    endingAt: end.toISOString(),
  };
}

/** SQLite datetime fragment: created_at >= datetime('now', ?) style offset for "today" is special-cased by callers. */
export function sqliteSinceClause(window: UsageWindow): {
  sql: string;
  params: string[];
} {
  if (window === "today") {
    // UTC start of day as ISO date prefix match is fragile; use day offset + date filter in adapter.
    return { sql: "date(created_at) = date('now')", params: [] };
  }
  if (window === "7d") {
    return { sql: "created_at >= datetime('now', ?)", params: ["-7 days"] };
  }
  return { sql: "created_at >= datetime('now', ?)", params: ["-30 days"] };
}
