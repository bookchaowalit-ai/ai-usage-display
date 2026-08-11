#!/usr/bin/env node

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const home = homedir();
const credentialsPath =
  process.env.KIMI_CREDENTIALS_PATH ||
  path.join(process.env.KIMI_CODE_HOME || path.join(home, ".kimi-code"), "credentials", "kimi-code.json");
const outputPath =
  process.env.KIMI_QUOTA_OUTPUT_PATH ||
  path.join(home, ".local", "share", "ai-usage-display", "kimi-quota.json");
const baseUrl = (process.env.KIMI_USAGE_BASE_URL || "https://api.kimi.com/coding/v1").replace(/\/+$/, "");
const oauthHost = (process.env.KIMI_OAUTH_HOST || "https://auth.kimi.com").replace(/\/+$/, "");
const timeoutMs = Number.parseInt(process.env.KIMI_QUOTA_TIMEOUT_MS || "30000", 10);
const clientId = "17e5f671-d194-4dfb-9706-5516cb48c098";

function readCredentials() {
  try {
    const value = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    if (!value?.access_token || !value?.refresh_token) return null;
    return { ...value, expires_at: Number(value.expires_at || 0) };
  } catch {
    return null;
  }
}

function needsRefresh(credentials) {
  return credentials.expires_at > 0 && credentials.expires_at - Math.floor(Date.now() / 1000) < 300;
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshCredentials(force = false) {
  const current = readCredentials();
  if (!current) throw new Error("Kimi Code OAuth login not found");
  if (!force && !needsRefresh(current)) return current;

  const response = await request(`${oauthHost}/api/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "user-agent": "ai-usage-display/1.0",
    },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
    }),
  });
  if (!response.ok) throw new Error(`Kimi OAuth refresh HTTP ${response.status}; sign in again`);
  const payload = await response.json();
  if (!payload?.access_token || !payload?.refresh_token || !Number(payload.expires_in)) {
    throw new Error("Kimi OAuth refresh returned invalid credentials");
  }
  const refreshed = {
    ...current,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Number(payload.expires_in),
    expires_in: Number(payload.expires_in),
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
    ...(typeof payload.token_type === "string" ? { token_type: payload.token_type } : {}),
  };
  const tempPath = `${credentialsPath}.ai-usage-display-${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(refreshed, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, credentialsPath);
  return refreshed;
}

async function fetchUsage(accessToken) {
  return request(`${baseUrl}/usages`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "user-agent": "ai-usage-display/1.0",
    },
  });
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function dateValue(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function durationMinutes(value) {
  if (!value || typeof value !== "object") return null;
  const duration = numberValue(value.duration);
  if (duration === null) return null;
  return {
    TIME_UNIT_MINUTE: duration,
    TIME_UNIT_HOUR: duration * 60,
    TIME_UNIT_DAY: duration * 1440,
    TIME_UNIT_WEEK: duration * 10080,
  }[value.timeUnit] || null;
}

function windowValue(id, label, raw, duration) {
  if (!raw || typeof raw !== "object") return null;
  const limit = numberValue(raw.limit);
  const remaining = numberValue(raw.remaining);
  const used = numberValue(raw.used);
  if (!limit || (remaining === null && used === null)) return null;
  const remainingPercent = remaining === null
    ? Math.max(0, Math.min(100, 100 - ((used || 0) / limit) * 100))
    : Math.max(0, Math.min(100, (Math.min(remaining, limit) / limit) * 100));
  return {
    id,
    label,
    used_percent: Math.max(0, Math.min(100, 100 - remainingPercent)),
    remaining_percent: remainingPercent,
    resets_at: dateValue(raw.resetTime),
    ...(duration !== null ? { duration_minutes: duration } : {}),
  };
}

function parseQuota(body) {
  const windows = [];
  const weekly = windowValue("weekly", "week", body?.usage, 10080);
  if (weekly) windows.push(weekly);
  for (const [index, raw] of (Array.isArray(body?.limits) ? body.limits : []).entries()) {
    const duration = durationMinutes(raw?.window);
    const name = typeof raw?.name === "string" ? raw.name : `limit-${index + 1}`;
    const value = windowValue(name, duration === 300 ? "5h" : name, raw?.detail, duration);
    if (value) windows.push(value);
  }
  if (!windows.length) throw new Error("Kimi returned no quota windows");
  const membership = body?.user?.membership;
  const plan = typeof membership?.level === "string"
    ? membership.level.replace(/^LEVEL_/, "").replace(/_/g, " ")
    : "Kimi Code";
  return {
    status: "ok",
    plan,
    updated_at: new Date().toISOString(),
    message: "source:kimi-host-managed-usage",
    primary: [...windows].sort((a, b) => a.remaining_percent - b.remaining_percent)[0],
    windows,
  };
}

async function main() {
  let credentials = await refreshCredentials();
  let response = await fetchUsage(credentials.access_token);
  if (response.status === 401) {
    credentials = await refreshCredentials(true);
    response = await fetchUsage(credentials.access_token);
  }
  if (!response.ok) throw new Error(`Kimi usage HTTP ${response.status}`);
  const snapshot = parseQuota(await response.json());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, outputPath);
  console.log(`Kimi quota exported: ${snapshot.windows.length} windows -> ${outputPath}`);
}

main().catch((error) => {
  console.error(`Kimi quota export failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
