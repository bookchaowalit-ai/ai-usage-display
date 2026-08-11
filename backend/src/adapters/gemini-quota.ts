import fs from "node:fs";
import {
  emptyQuota,
  type ProviderQuota,
  type QuotaWindow,
} from "../types/usage.js";

interface GeminiQuotaFileWindow {
  id?: unknown;
  label?: unknown;
  used_percent?: unknown;
  remaining_percent?: unknown;
  resets_at?: unknown;
  duration_minutes?: unknown;
}

interface GeminiQuotaFile {
  status?: unknown;
  plan?: unknown;
  updated_at?: unknown;
  message?: unknown;
  windows?: unknown;
}

function boundedPercent(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/** Read only a non-secret quota snapshot written by a host exporter. */
export function readQuotaSnapshotFile(
  filePath: string,
  subject: string,
  defaultPlan: string,
  now = new Date(),
  maxAgeSeconds = 0,
): ProviderQuota {
  if (!filePath) {
    return emptyQuota("unavailable", `${subject} quota snapshot path not configured`, now);
  }
  if (!fs.existsSync(filePath)) {
    return emptyQuota("unavailable", `${subject} quota snapshot not found: ${filePath}`, now);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as GeminiQuotaFile;
    const rawWindows = Array.isArray(parsed.windows) ? parsed.windows : [];
    const windows: QuotaWindow[] = [];

    for (const raw of rawWindows as GeminiQuotaFileWindow[]) {
      const remaining = boundedPercent(raw.remaining_percent);
      if (remaining === null) continue;
      const used = boundedPercent(raw.used_percent) ?? 100 - remaining;
      const label = typeof raw.label === "string" ? raw.label : "window";
      windows.push({
        id: typeof raw.id === "string" ? raw.id : label,
        label,
        used_percent: used,
        remaining_percent: remaining,
        resets_at: typeof raw.resets_at === "string" ? raw.resets_at : null,
        ...(typeof raw.duration_minutes === "number"
          ? { duration_minutes: raw.duration_minutes }
          : {}),
      });
    }

    if (windows.length === 0) {
      return emptyQuota("no_data", `${subject} quota snapshot returned no windows`, now);
    }

    const primary = [...windows].sort((a, b) => {
      const byRemaining = a.remaining_percent - b.remaining_percent;
      if (byRemaining !== 0) return byRemaining;
      return (a.duration_minutes ?? Infinity) - (b.duration_minutes ?? Infinity);
    })[0];

    const updatedAt =
      typeof parsed.updated_at === "string" ? parsed.updated_at : now.toISOString();
    const updatedAtMs = Date.parse(updatedAt);
    const ageSeconds = (now.getTime() - updatedAtMs) / 1000;
    const staleByAge =
      maxAgeSeconds > 0 && Number.isFinite(updatedAtMs) && ageSeconds > maxAgeSeconds;
    const stale = parsed.status === "stale" || staleByAge;

    return {
      status: stale ? "stale" : "ok",
      plan: typeof parsed.plan === "string" ? parsed.plan : defaultPlan,
      primary,
      windows,
      updated_at: updatedAt,
      message: stale
        ? `${subject} quota snapshot is stale (${Math.max(0, Math.floor(ageSeconds))}s old)`
        : typeof parsed.message === "string"
          ? parsed.message
          : `source:${subject.toLowerCase()}-quota-snapshot`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid quota snapshot";
    return emptyQuota("error", `${subject} quota snapshot unreadable: ${message}`, now);
  }
}

export function readGeminiQuotaFile(
  filePath: string,
  now = new Date(),
  maxAgeSeconds = 0,
): ProviderQuota {
  return readQuotaSnapshotFile(filePath, "Gemini", "antigravity", now, maxAgeSeconds);
}
