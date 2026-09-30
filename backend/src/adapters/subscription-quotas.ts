import fs from "node:fs";
import type { AppConfig } from "../config.js";
import {
  emptyQuota,
  type DisplayProvider,
  type ProviderQuota,
  type QuotaWindow,
} from "../types/usage.js";
import { readGeminiQuotaFile, readQuotaSnapshotFile } from "./gemini-quota.js";
import { readClaudeQuotaFile } from "./claude-quota.js";
import {
  runCommand,
  runJsonRpcProcess,
  sanitizeMessage,
  type JsonRpcMessage,
} from "./cli.js";
import { resolveProviderCli } from "./cli-resolve.js";

import { probeKimiQuota } from "./kimi-subscription.js";
import {
  cliQuotaWindow,
  isoDate,
  nonNegativeNumber,
  percent,
  quotaDurationLabel,
  quotaFromWindows,
  remaining,
  unixSecondsIso,
} from "./quota-math.js";

export { resolveProviderCli } from "./cli-resolve.js";
export { parseKimiQuotaBody, probeKimiQuota } from "./kimi-subscription.js";

type SubscriptionConfig = AppConfig["subscriptionUsage"];

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
