import { emptyQuota, type ProviderQuota, type QuotaWindow } from "../types/usage.js";

// Shared number/date/window helpers for the local subscription quota parsers.

/**
 * A 0-100 percentage rounded to one decimal. Rounding never reaches an
 * endpoint the raw value has not: 99.97% used stays 99.9 (not "100% used,
 * 0% left" while requests still go through) and 0.01% left stays 0.1.
 */
export function percent(value: unknown): number | null {
  const n = nonNegativeNumber(value);
  if (n === null) return null;
  if (n >= 100) return 100;
  if (n === 0) return 0;
  return Math.min(99.9, Math.max(0.1, Math.round(n * 10) / 10));
}

export function remaining(used: number): number {
  return Math.round(Math.max(0, 100 - used) * 10) / 10;
}

export function nonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

export function unixSecondsIso(value: unknown): string | null {
  const seconds = nonNegativeNumber(value);
  if (seconds === null) return null;
  return isoDate(seconds * 1000);
}

export function isoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function quotaDurationLabel(duration: number | null, fallback: string): string {
  if (duration === 300) return "5h";
  if (duration === 1440) return "day";
  if (duration === 10080) return "week";
  if (duration !== null && duration % 1440 === 0) return `${duration / 1440}d`;
  if (duration !== null && duration % 60 === 0) return `${duration / 60}h`;
  return fallback;
}

export function quotaFromWindows(
  windows: QuotaWindow[],
  now: Date,
  plan?: string,
  message?: string,
): ProviderQuota {
  if (windows.length === 0) {
    return emptyQuota("no_data", message ?? "quota windows not returned", now);
  }
  const primary = [...windows].sort((a, b) => {
    const byRemaining = a.remaining_percent - b.remaining_percent;
    if (byRemaining !== 0) return byRemaining;
    return (a.duration_minutes ?? Infinity) - (b.duration_minutes ?? Infinity);
  })[0];
  return {
    status: "ok",
    ...(plan ? { plan } : {}),
    primary,
    windows,
    updated_at: now.toISOString(),
    ...(message ? { message } : {}),
  };
}

export function cliQuotaWindow(
  id: string,
  label: string,
  rawUsed: string,
  durationMinutes: number,
  resetsAt: string | null = null,
): QuotaWindow {
  const used = percent(rawUsed) ?? 0;
  return {
    id,
    label,
    used_percent: used,
    remaining_percent: remaining(used),
    resets_at: resetsAt,
    duration_minutes: durationMinutes,
  };
}
