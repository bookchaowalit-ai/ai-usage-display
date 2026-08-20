import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { AppConfig } from "../config.js";
import {
  emptyQuota,
  type DisplayProvider,
  type ProviderQuota,
  type QuotaWindow,
} from "../types/usage.js";
import { readGeminiQuotaFile, readQuotaSnapshotFile } from "./gemini-quota.js";
import { readClaudeQuotaFile } from "./claude-quota.js";

type SubscriptionConfig = AppConfig["subscriptionUsage"];

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

const MAX_COMMAND_OUTPUT = 1024 * 1024;
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

/**
 * Reads subscription quotas through provider CLIs already authenticated on this
 * host. It never returns OAuth/API credentials. Kimi OAuth refreshes are saved
 * back to Kimi's own credential file under a cross-process lock because Kimi
 * rotates refresh tokens.
 */
export class LocalSubscriptionQuotaAdapter {
  readonly name = "local-subscription-quotas";

  constructor(private readonly config: SubscriptionConfig) {}

  async fetchAll(
    now: Date = new Date(),
  ): Promise<Record<DisplayProvider, ProviderQuota>> {
    if (!this.config.enabled) {
      const disabled = emptyQuota(
        "unavailable",
        "local subscription usage disabled",
        now,
      );
      return {
        claude: disabled,
        codex: disabled,
        grok: disabled,
        kimi: disabled,
        gemini: disabled,
      };
    }

    const claudeCli = resolveProviderCli("claude", this.config.claudeCliPath);
    const codexCli = resolveProviderCli("codex", this.config.codexCliPath);
    const grokCli = resolveProviderCli("grok", this.config.grokCliPath);

    const [claude, codex, grok, kimi, gemini] = await Promise.all([
      safeQuotaProbe(
        "Claude",
        () =>
          probeClaudeQuota(
            claudeCli,
            this.config.claudeCredentialsPath,
            this.config.timeoutMs,
            now,
            this.config.claudeQuotaPath,
            this.config.quotaSnapshotMaxAgeSeconds,
          ),
        now,
      ),
      codexCli
        ? safeQuotaProbe(
            "Codex",
            () =>
              probeSnapshotThen(
                this.config.codexQuotaPath,
                "Codex",
                "codex",
                now,
                this.config.quotaSnapshotMaxAgeSeconds,
                () => probeCodexQuota(codexCli, this.config.timeoutMs, now),
              ),
            now,
          )
        : this.config.codexQuotaPath
          ? safeQuotaProbe(
              "Codex",
              () =>
                probeSnapshotThen(
                  this.config.codexQuotaPath,
                  "Codex",
                  "codex",
                  now,
                  this.config.quotaSnapshotMaxAgeSeconds,
                  async () => emptyQuota("unavailable", "Codex CLI not found", now),
                ),
              now,
            )
          : Promise.resolve(emptyQuota("unavailable", "Codex CLI not found", now)),
      grokCli
        ? safeQuotaProbe(
            "Grok",
            () =>
              probeSnapshotThen(
                this.config.grokQuotaPath,
                "Grok",
                "X Premium+",
                now,
                this.config.quotaSnapshotMaxAgeSeconds,
                () => probeGrokQuota(grokCli, this.config.timeoutMs, now),
              ),
            now,
          )
        : this.config.grokQuotaPath
          ? safeQuotaProbe(
              "Grok",
              () =>
                probeSnapshotThen(
                  this.config.grokQuotaPath,
                  "Grok",
                  "X Premium+",
                  now,
                  this.config.quotaSnapshotMaxAgeSeconds,
                  async () => emptyQuota("unavailable", "Grok CLI not found", now),
                ),
              now,
            )
          : Promise.resolve(emptyQuota("unavailable", "Grok CLI not found", now)),
      safeQuotaProbe(
        "Kimi",
        () =>
          probeSnapshotThen(
            this.config.kimiQuotaPath,
            "Kimi",
            "Kimi Code",
            now,
            this.config.quotaSnapshotMaxAgeSeconds,
            () =>
              probeKimiQuota(
                this.config.kimiCredentialsPath,
                this.config.kimiBaseUrl,
                this.config.kimiOAuthHost,
                this.config.timeoutMs,
                now,
              ),
          ),
        now,
      ),
      safeQuotaProbe(
        "Gemini",
        async () =>
          readGeminiQuotaFile(
            this.config.geminiQuotaPath,
            now,
            this.config.quotaSnapshotMaxAgeSeconds,
          ),
        now,
      ),
    ]);

    return { claude, codex, grok, kimi, gemini };
  }
}

async function probeSnapshotThen(
  filePath: string,
  subject: string,
  defaultPlan: string,
  now: Date,
  maxAgeSeconds: number,
  fallback: () => Promise<ProviderQuota>,
): Promise<ProviderQuota> {
  if (filePath) {
    const snapshot = readQuotaSnapshotFile(
      filePath,
      subject,
      defaultPlan,
      now,
      maxAgeSeconds,
    );
    if (snapshot.status === "ok" || snapshot.status === "stale") return snapshot;
  }
  return fallback();
}

async function safeQuotaProbe(
  providerName: string,
  probe: () => Promise<ProviderQuota>,
  now: Date,
): Promise<ProviderQuota> {
  try {
    return await probe();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "probe failed";
    return emptyQuota(
      "error",
      `${providerName} local quota probe failed: ${sanitizeMessage(reason)}`,
      now,
    );
  }
}

export async function probeClaudeQuota(
  cliPath: string | null,
  credentialsPath: string,
  timeoutMs: number,
  now: Date = new Date(),
  quotaPath = "",
  quotaMaxAgeSeconds = 0,
): Promise<ProviderQuota> {
  if (quotaPath) {
    const snapshot = readClaudeQuotaFile(quotaPath, now, quotaMaxAgeSeconds);
    if (snapshot.status === "ok" || snapshot.status === "stale") {
      return snapshot;
    }
  }

  let cliFallback: ProviderQuota | null = null;

  if (cliPath) {
    try {
      const result = await runCommand(
        cliPath,
        ["-p", "--output-format", "json", "--no-session-persistence", "/usage"],
        timeoutMs,
      );
      cliFallback = parseClaudeCliUsage(result.stdout, now);
    } catch {
      // The credential endpoint below can still work when the CLI renderer fails.
    }
  }

  if (!credentialsPath || !fs.existsSync(credentialsPath)) {
    if (cliFallback) return cliFallback;
    return emptyQuota("unavailable", "Claude credentials not found", now);
  }

  const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as {
    claudeAiOauth?: { accessToken?: unknown; subscriptionType?: unknown };
  };
  const token = credentials.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    if (cliFallback) return cliFallback;
    return emptyQuota("unavailable", "Claude OAuth login not found", now);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": "ai-usage-display/1.0",
        },
      });
      if (!response.ok) {
        if (cliFallback) return cliFallback;
        throw new Error(`Claude usage HTTP ${response.status}`);
      }
      const body = (await response.json()) as unknown;
      const plan =
        typeof credentials.claudeAiOauth?.subscriptionType === "string"
          ? credentials.claudeAiOauth.subscriptionType
          : undefined;
      return parseClaudeQuotaBody(body, now, plan);
    } catch (error) {
      if (cliFallback) return cliFallback;
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function probeCodexQuota(
  cliPath: string,
  timeoutMs: number,
  now: Date = new Date(),
): Promise<ProviderQuota> {
  const body = await runCodexRateLimits(cliPath, timeoutMs);
  return parseCodexQuotaBody(body, now);
}

export async function probeGrokQuota(
  cliPath: string,
  timeoutMs: number,
  now: Date = new Date(),
): Promise<ProviderQuota> {
  const body = await runGrokBilling(cliPath, timeoutMs);
  return parseGrokQuotaBody(body, now);
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

export function parseClaudeQuotaBody(
  body: unknown,
  now: Date = new Date(),
  plan?: string,
): ProviderQuota {
  if (!body || typeof body !== "object") {
    return emptyQuota("error", "Claude returned invalid quota data", now);
  }

  const source = body as Record<string, unknown>;
  const definitions: Array<[string, string]> = [
    ["five_hour", "5h"],
    ["seven_day", "week"],
    ["seven_day_opus", "week opus"],
    ["seven_day_sonnet", "week sonnet"],
    ["seven_day_oauth_apps", "week apps"],
    ["seven_day_cowork", "week cowork"],
  ];
  const windows: QuotaWindow[] = [];

  for (const [id, label] of definitions) {
    const raw = source[id];
    if (!raw || typeof raw !== "object") continue;
    const bucket = raw as Record<string, unknown>;
    const used = percent(bucket.utilization);
    if (used === null) continue;
    windows.push({
      id,
      label,
      used_percent: used,
      remaining_percent: remaining(used),
      resets_at: isoDate(bucket.resets_at),
      duration_minutes: id === "five_hour" ? 300 : 10080,
    });
  }

  return quotaFromWindows(windows, now, plan, "source:claude-local-subscription");
}

export function parseClaudeCliUsage(
  stdout: string,
  now: Date = new Date(),
): ProviderQuota {
  let text = stdout;
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    if (typeof parsed.result === "string") text = parsed.result;
  } catch {
    // Plain text output is also accepted.
  }

  const windows: QuotaWindow[] = [];
  const sessionLine = text.split(/\r?\n/).find((line) => /Current session:/i.test(line));
  const weekLine = text
    .split(/\r?\n/)
    .find((line) => /Current week[^:]*:/i.test(line));
  const parseCliLine = (line: string | undefined): {
    used: string;
    resetText?: string;
    timeZone?: string;
  } | null => {
    if (!line) return null;
    const match = line.match(
      /:\s*([\d.]+)%\s*used(?:\s*[·•]\s*resets\s+(.+?)(?:\s+\(([^)]+)\))?)?\s*$/i,
    );
    if (!match) return null;
    return { used: match[1], resetText: match[2], timeZone: match[3] };
  };
  const session = parseCliLine(sessionLine);
  const week = parseCliLine(weekLine);
  if (session) {
    windows.push(
      cliQuotaWindow(
        "five_hour",
        "5h",
        session.used,
        300,
        parseClaudeCliReset(session.resetText, session.timeZone, now),
      ),
    );
  }
  if (week) {
    windows.push(
      cliQuotaWindow(
        "seven_day",
        "week",
        week.used,
        10080,
        parseClaudeCliReset(week.resetText, week.timeZone, now),
      ),
    );
  }
  return quotaFromWindows(windows, now, undefined, "source:claude-cli-usage");
}

export function parseCodexQuotaBody(
  body: unknown,
  now: Date = new Date(),
): ProviderQuota {
  if (!body || typeof body !== "object") {
    return emptyQuota("error", "Codex returned invalid quota data", now);
  }
  const root = body as {
    rateLimits?: unknown;
    rateLimitsByLimitId?: unknown;
  };
  const buckets: Array<[string, unknown]> = [];
  if (root.rateLimitsByLimitId && typeof root.rateLimitsByLimitId === "object") {
    buckets.push(...Object.entries(root.rateLimitsByLimitId as Record<string, unknown>));
  }
  // Some Codex versions include an empty limit map while still returning the
  // legacy top-level bucket. Keep the fallback for those responses.
  if (buckets.length === 0 && root.rateLimits && typeof root.rateLimits === "object") {
    const id = String((root.rateLimits as { limitId?: unknown }).limitId ?? "codex");
    buckets.push([id, root.rateLimits]);
  }

  const windows: QuotaWindow[] = [];
  let plan: string | undefined;
  for (const [limitId, raw] of buckets) {
    if (!raw || typeof raw !== "object") continue;
    const bucket = raw as Record<string, unknown>;
    if (!plan && typeof bucket.planType === "string") plan = bucket.planType;
    for (const slot of ["primary", "secondary"] as const) {
      const rawWindow = bucket[slot];
      if (!rawWindow || typeof rawWindow !== "object") continue;
      const q = rawWindow as Record<string, unknown>;
      const used = percent(q.usedPercent);
      if (used === null) continue;
      const duration = nonNegativeNumber(q.windowDurationMins);
      windows.push({
        id: `${limitId}.${slot}`,
        label: quotaDurationLabel(duration, limitId),
        used_percent: used,
        remaining_percent: remaining(used),
        resets_at: unixSecondsIso(q.resetsAt),
        ...(duration !== null ? { duration_minutes: duration } : {}),
      });
    }
  }

  return quotaFromWindows(windows, now, plan, "source:codex-app-server");
}

export function parseGrokQuotaBody(
  body: unknown,
  now: Date = new Date(),
): ProviderQuota {
  if (!body || typeof body !== "object") {
    return emptyQuota("error", "Grok returned invalid quota data", now);
  }
  const root = body as Record<string, unknown>;
  const config =
    root.config && typeof root.config === "object"
      ? (root.config as Record<string, unknown>)
      : root;
  const used = percent(config.creditUsagePercent);
  if (used === null) {
    return emptyQuota("no_data", "Grok returned no weekly quota", now);
  }
  const period =
    config.currentPeriod && typeof config.currentPeriod === "object"
      ? (config.currentPeriod as Record<string, unknown>)
      : {};
  const plan = typeof root.subscription_tier === "string" ? root.subscription_tier : undefined;
  const window: QuotaWindow = {
    id: "weekly",
    label: "week",
    used_percent: used,
    remaining_percent: remaining(used),
    resets_at: isoDate(period.end ?? config.billingPeriodEnd),
    duration_minutes: 10080,
  };
  return quotaFromWindows([window], now, plan, "source:grok-local-billing");
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

function cliQuotaWindow(
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

function parseClaudeCliReset(
  resetText: string | undefined,
  timeZone: string | undefined,
  now: Date,
): string | null {
  if (!resetText) return null;
  const match = resetText.trim().match(
    /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i,
  );
  if (!match) return null;

  const monthNames = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const month = monthNames.indexOf(match[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;

  let hour = Number.parseInt(match[3], 10);
  const minute = match[4] ? Number.parseInt(match[4], 10) : 0;
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (match[5].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (match[5].toLowerCase() === "am" && hour === 12) hour = 0;

  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let year = now.getUTCFullYear();
  let candidate = zonedCivilTimeToUtc(
    year,
    month,
    Number.parseInt(match[2], 10),
    hour,
    minute,
    zone,
  );
  if (!candidate) return null;

  // Claude omits the year. Pick the next occurrence when the displayed
  // month/day is already behind the current date.
  if (candidate.getTime() < now.getTime() - 12 * 60 * 60 * 1000) {
    year += 1;
    candidate = zonedCivilTimeToUtc(
      year,
      month,
      Number.parseInt(match[2], 10),
      hour,
      minute,
      zone,
    );
  }
  return candidate?.toISOString() ?? null;
}

function zonedCivilTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  const civilAsUtc = Date.UTC(year, month, day, hour, minute, 0);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(civilAsUtc));
    const values = new Map(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number.parseInt(part.value, 10)]),
    );
    const localAsUtc = Date.UTC(
      values.get("year") ?? year,
      (values.get("month") ?? month + 1) - 1,
      values.get("day") ?? day,
      values.get("hour") ?? hour,
      values.get("minute") ?? minute,
      values.get("second") ?? 0,
    );
    const offsetMs = localAsUtc - civilAsUtc;
    return new Date(civilAsUtc - offsetMs);
  } catch {
    return null;
  }
}

function quotaFromWindows(
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

async function runCodexRateLimits(cliPath: string, timeoutMs: number): Promise<unknown> {
  return runJsonRpcProcess(
    cliPath,
    ["app-server"],
    timeoutMs,
    (send, resolve) => {
      send({
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "ai_usage_display",
            title: "AI Usage Display",
            version: "1.0.0",
          },
        },
      });
      return (message: JsonRpcMessage) => {
        if (message.id === 0 && message.result) {
          send({ method: "initialized", params: {} });
          send({ method: "account/rateLimits/read", id: 6 });
        } else if (message.id === 6) {
          if (message.error) throw new Error(message.error.message ?? "Codex quota request failed");
          resolve(message.result);
        }
      };
    },
  );
}

async function runGrokBilling(cliPath: string, timeoutMs: number): Promise<unknown> {
  return runJsonRpcProcess(
    cliPath,
    ["agent", "--no-leader", "stdio"],
    timeoutMs,
    (send, resolve) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { terminal: false } },
      });
      return (message: JsonRpcMessage) => {
        if (message.id === 1 && message.result) {
          send({ jsonrpc: "2.0", id: 2, method: "_x.ai/billing", params: {} });
        } else if (message.id === 2) {
          if (message.error) throw new Error(message.error.message ?? "Grok billing request failed");
          resolve(message.result);
        }
      };
    },
  );
}

function runJsonRpcProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  start: (
    send: (message: unknown) => void,
    resolve: (value: unknown) => void,
  ) => (message: JsonRpcMessage) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    let stderr = "";

    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const resolveValue = (value: unknown): void => finish(undefined, value);
    const onMessage = start(send, resolveValue);
    const timer = setTimeout(
      () => finish(new Error(`local CLI timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled && code !== 0) {
        finish(
          new Error(
            `local CLI exited (${signal ?? code ?? "unknown"})${stderr ? `: ${sanitizeMessage(stderr)}` : ""}`,
          ),
        );
      }
    });
    lines.on("line", (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      try {
        onMessage(message);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("local CLI protocol failed"));
      }
    });
  });
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`local CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`local CLI exited (${signal ?? code ?? "unknown"})`));
    });
  });
}

export function resolveProviderCli(
  provider: DisplayProvider,
  configuredPath = "",
): string | null {
  if (configuredPath) return configuredPath;

  const home = os.homedir();
  const directCandidates: Record<DisplayProvider, string[]> = {
    claude: [],
    codex: [],
    grok: [path.join(home, ".grok", "bin", "grok")],
    kimi: [],
    gemini: [path.join(home, ".local", "bin", "agy")],
  };
  const extensionPatterns: Record<DisplayProvider, Array<[string, string, string]>> = {
    claude: [
      [".vscode-insiders/extensions", "anthropic.claude-code-", "resources/native-binary/claude"],
      [".vscode/extensions", "anthropic.claude-code-", "resources/native-binary/claude"],
    ],
    codex: [
      [".vscode-insiders/extensions", "openai.chatgpt-", "bin/linux-x86_64/codex"],
      [".vscode/extensions", "openai.chatgpt-", "bin/linux-x86_64/codex"],
    ],
    grok: [],
    kimi: [],
    gemini: [],
  };

  for (const candidate of directCandidates[provider]) {
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const [root, prefix, relative] of extensionPatterns[provider]) {
    const found = newestExtensionExecutable(path.join(home, root), prefix, relative);
    if (found) return found;
  }
  return executableOnPath(
    provider === "claude"
      ? "claude"
      : provider === "codex"
        ? "codex"
        : provider === "grok"
          ? "grok"
          : provider === "gemini"
            ? "agy"
          : "kimi",
  );
}

function newestExtensionExecutable(
  root: string,
  prefix: string,
  relative: string,
): string | null {
  if (!fs.existsSync(root)) return null;
  const directories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const directory of directories) {
    const candidate = path.join(root, directory, relative);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function executableOnPath(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function percent(value: unknown): number | null {
  const n = nonNegativeNumber(value);
  if (n === null) return null;
  return Math.round(Math.min(100, n) * 10) / 10;
}

function remaining(used: number): number {
  return Math.round(Math.max(0, 100 - used) * 10) / 10;
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function unixSecondsIso(value: unknown): string | null {
  const seconds = nonNegativeNumber(value);
  if (seconds === null) return null;
  return isoDate(seconds * 1000);
}

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function quotaDurationLabel(duration: number | null, fallback: string): string {
  if (duration === 300) return "5h";
  if (duration === 1440) return "day";
  if (duration === 10080) return "week";
  if (duration !== null && duration % 1440 === 0) return `${duration / 1440}d`;
  if (duration !== null && duration % 60 === 0) return `${duration / 60}h`;
  return fallback;
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
