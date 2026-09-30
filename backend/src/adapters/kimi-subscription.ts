import fs from "node:fs";
import path from "node:path";
import { emptyQuota, type ProviderQuota, type QuotaWindow } from "../types/usage.js";
import {
  isoDate,
  nonNegativeNumber,
  percent,
  quotaDurationLabel,
  quotaFromWindows,
  remaining,
} from "./quota-math.js";

// Kimi Code subscription quota: reads Kimi's own OAuth credential file,
// refreshes it under a cross-process lock (Kimi rotates refresh tokens) and
// queries the usage endpoint. Credentials are never returned or logged.

const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_REFRESH_MARGIN_SECONDS = 300;

interface KimiCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  [key: string]: unknown;
}

export async function probeKimiQuota(
  credentialsPath: string,
  baseUrl: string,
  oauthHost: string,
  timeoutMs: number,
  now: Date = new Date(),
): Promise<ProviderQuota> {
  if (!credentialsPath || !fs.existsSync(credentialsPath)) {
    return emptyQuota("unavailable", "Kimi Code credentials not found", now);
  }

  let credentials = readKimiCredentials(credentialsPath);
  if (!credentials) {
    return emptyQuota("unavailable", "Kimi Code OAuth login not found", now);
  }

  if (needsKimiRefresh(credentials, now)) {
    credentials = await refreshKimiCredentials(
      credentialsPath,
      oauthHost,
      timeoutMs,
      now,
      false,
    );
  }

  let response = await fetchKimiUsage(baseUrl, credentials.access_token, timeoutMs);
  if (response.status === 401) {
    credentials = await refreshKimiCredentials(
      credentialsPath,
      oauthHost,
      timeoutMs,
      now,
      true,
    );
    response = await fetchKimiUsage(baseUrl, credentials.access_token, timeoutMs);
  }
  if (!response.ok) {
    throw new Error(`Kimi usage HTTP ${response.status}`);
  }
  return parseKimiQuotaBody(await response.json(), now);
}

export function parseKimiQuotaBody(
  body: unknown,
  now: Date = new Date(),
): ProviderQuota {
  if (!body || typeof body !== "object") {
    return emptyQuota("error", "Kimi returned invalid quota data", now);
  }

  const root = body as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  const weekly = kimiUsageWindow(
    "weekly",
    "week",
    root.usage,
    10080,
  );
  if (weekly) windows.push(weekly);

  if (Array.isArray(root.limits)) {
    root.limits.forEach((raw, index) => {
      if (!raw || typeof raw !== "object") return;
      const item = raw as Record<string, unknown>;
      const duration = kimiDurationMinutes(item.window);
      const name = typeof item.name === "string" ? item.name : `limit-${index + 1}`;
      const quotaWindow = kimiUsageWindow(
        name,
        quotaDurationLabel(duration, name),
        item.detail,
        duration,
      );
      if (quotaWindow) windows.push(quotaWindow);
    });
  }

  const user =
    root.user && typeof root.user === "object"
      ? (root.user as Record<string, unknown>)
      : undefined;
  const membership =
    user?.membership && typeof user.membership === "object"
      ? (user.membership as Record<string, unknown>)
      : undefined;
  const plan = kimiPlanName(membership?.level);

  return quotaFromWindows(
    windows,
    now,
    plan ?? "Kimi Code",
    "source:kimi-code-managed-usage",
  );
}

function kimiUsageWindow(
  id: string,
  label: string,
  raw: unknown,
  durationMinutes: number | null,
): QuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const limit = nonNegativeNumber(row.limit);
  if (limit === null || limit <= 0) return null;
  const remainingValue = nonNegativeNumber(row.remaining);
  const usedValue = nonNegativeNumber(row.used);
  if (remainingValue === null && usedValue === null) return null;
  const remainingPercent =
    remainingValue !== null
      ? percent((Math.min(remainingValue, limit) / limit) * 100)
      : remaining(percent(((usedValue ?? 0) / limit) * 100) ?? 0);
  if (remainingPercent === null) return null;
  const usedPercent = remaining(remainingPercent);
  return {
    id,
    label,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    resets_at: isoDate(row.resetTime),
    ...(durationMinutes !== null ? { duration_minutes: durationMinutes } : {}),
  };
}

function kimiPlanName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value
    .replace(/^LEVEL_/, "")
    .toLowerCase()
    .replace(/(^|_)([a-z])/g, (_match, prefix: string, letter: string) =>
      `${prefix ? " " : ""}${letter.toUpperCase()}`,
    );
}

function kimiDurationMinutes(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const window = raw as Record<string, unknown>;
  const duration = nonNegativeNumber(window.duration);
  if (duration === null) return null;
  switch (window.timeUnit) {
    case "TIME_UNIT_MINUTE":
      return duration;
    case "TIME_UNIT_HOUR":
      return duration * 60;
    case "TIME_UNIT_DAY":
      return duration * 1440;
    case "TIME_UNIT_WEEK":
      return duration * 10080;
    default:
      return null;
  }
}

function readKimiCredentials(credentialsPath: string): KimiCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    typeof value.refresh_token !== "string" ||
    value.refresh_token.length === 0
  ) {
    return null;
  }
  return {
    ...value,
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: nonNegativeNumber(value.expires_at) ?? 0,
  };
}

function needsKimiRefresh(credentials: KimiCredentials, now: Date): boolean {
  return (
    credentials.expires_at > 0 &&
    credentials.expires_at - Math.floor(now.getTime() / 1000) <
      KIMI_REFRESH_MARGIN_SECONDS
  );
}

async function fetchKimiUsage(
  baseUrl: string,
  accessToken: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl.replace(/\/+$/, "")}/usages`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "user-agent": "ai-usage-display/1.0",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshKimiCredentials(
  credentialsPath: string,
  oauthHost: string,
  timeoutMs: number,
  now: Date,
  force: boolean,
): Promise<KimiCredentials> {
  const kimiHome = path.dirname(path.dirname(credentialsPath));
  const lockParent = path.join(kimiHome, "oauth");
  const lockDirectory = path.join(lockParent, "kimi-code.lock");
  await fs.promises.mkdir(lockParent, { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await fs.promises.mkdir(lockDirectory);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for Kimi OAuth refresh lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    const current = readKimiCredentials(credentialsPath);
    if (!current) throw new Error("Kimi Code OAuth login not found");
    if (!force && !needsKimiRefresh(current, now)) return current;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(
        `${oauthHost.replace(/\/+$/, "")}/api/oauth/token`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "user-agent": "ai-usage-display/1.0",
          },
          body: new URLSearchParams({
            client_id: KIMI_OAUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: current.refresh_token,
          }),
        },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`Kimi OAuth refresh HTTP ${response.status}; sign in again`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = payload.access_token;
    const refreshToken = payload.refresh_token;
    const expiresIn = nonNegativeNumber(payload.expires_in);
    if (
      typeof accessToken !== "string" ||
      accessToken.length === 0 ||
      typeof refreshToken !== "string" ||
      refreshToken.length === 0 ||
      expiresIn === null ||
      expiresIn <= 0
    ) {
      throw new Error("Kimi OAuth refresh returned invalid credentials");
    }

    const refreshed: KimiCredentials = {
      ...current,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      expires_in: expiresIn,
      scope: typeof payload.scope === "string" ? payload.scope : current.scope,
      token_type:
        typeof payload.token_type === "string" ? payload.token_type : current.token_type,
    };
    const tempPath = `${credentialsPath}.ai-usage-display-${process.pid}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(refreshed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.promises.rename(tempPath, credentialsPath);
    return refreshed;
  } finally {
    await fs.promises.rm(lockDirectory, { recursive: true, force: true });
  }
}
