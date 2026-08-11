import { config as loadDotenv } from "dotenv";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, "../.env") });

export type UsageSourceMode = "providers" | "solo_empire" | "hybrid";

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback = false): boolean {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function usageSource(): UsageSourceMode {
  const raw = env("USAGE_SOURCE", "hybrid").toLowerCase();
  if (raw === "providers" || raw === "solo_empire" || raw === "hybrid") {
    return raw;
  }
  return "hybrid";
}

export interface AppConfig {
  host: string;
  port: number;
  deviceToken: string;
  cacheTtlSeconds: number;
  staleMaxAgeSeconds: number;
  usageSource: UsageSourceMode;
  subscriptionUsage: {
    enabled: boolean;
    timeoutMs: number;
    quotaSnapshotMaxAgeSeconds: number;
    claudeCliPath: string;
    claudeCredentialsPath: string;
    claudeQuotaPath: string;
    codexQuotaPath: string;
    codexCliPath: string;
    grokQuotaPath: string;
    grokCliPath: string;
    kimiCredentialsPath: string;
    kimiQuotaPath: string;
    kimiBaseUrl: string;
    kimiOAuthHost: string;
    geminiQuotaPath: string;
  };
  anthropic: {
    adminApiKey: string;
    baseUrl: string;
  };
  openai: {
    adminApiKey: string;
    baseUrl: string;
  };
  xai: {
    apiKey: string;
    baseUrl: string;
    usageEnabled: boolean;
    usagePath: string;
  };
  soloEmpire: {
    dbPath: string;
    apiUrl: string;
    apiToken: string;
  };
}

export function loadConfig(envOverrides: NodeJS.ProcessEnv = process.env): AppConfig {
  const get = (name: string, fallback = ""): string =>
    (envOverrides[name] ?? process.env[name] ?? fallback).trim();
  const getInt = (name: string, fallback: number): number => {
    const raw = get(name);
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const getBool = (name: string, fallback = false): boolean => {
    const raw = get(name).toLowerCase();
    if (!raw) return fallback;
    return raw === "1" || raw === "true" || raw === "yes";
  };
  const sourceRaw = get("USAGE_SOURCE", "hybrid").toLowerCase();
  const usageSourceMode: UsageSourceMode =
    sourceRaw === "providers" || sourceRaw === "solo_empire" || sourceRaw === "hybrid"
      ? sourceRaw
      : "hybrid";

  return {
    host: get("HOST", "0.0.0.0"),
    port: getInt("PORT", 8787),
    deviceToken: get("DEVICE_TOKEN"),
    cacheTtlSeconds: getInt("CACHE_TTL_SECONDS", 60),
    staleMaxAgeSeconds: getInt("STALE_MAX_AGE_SECONDS", 3600),
    usageSource: usageSourceMode,
    subscriptionUsage: {
      enabled: getBool("SUBSCRIPTION_USAGE_ENABLED", true),
      timeoutMs: getInt("SUBSCRIPTION_USAGE_TIMEOUT_MS", 15000),
      quotaSnapshotMaxAgeSeconds: getInt("QUOTA_SNAPSHOT_MAX_AGE_SECONDS", 300),
      claudeCliPath: get("CLAUDE_CLI_PATH"),
      claudeCredentialsPath: get(
        "CLAUDE_CREDENTIALS_PATH",
        path.join(os.homedir(), ".claude", ".credentials.json"),
      ),
      claudeQuotaPath: get("CLAUDE_QUOTA_PATH"),
      codexQuotaPath: get("CODEX_QUOTA_PATH"),
      codexCliPath: get("CODEX_CLI_PATH"),
      grokQuotaPath: get("GROK_QUOTA_PATH"),
      grokCliPath: get("GROK_CLI_PATH"),
      kimiCredentialsPath: get(
        "KIMI_CREDENTIALS_PATH",
        path.join(
          get("KIMI_CODE_HOME", path.join(os.homedir(), ".kimi-code")),
          "credentials",
          "kimi-code.json",
        ),
      ),
      kimiQuotaPath: get("KIMI_QUOTA_PATH"),
      kimiBaseUrl: get(
        "KIMI_USAGE_BASE_URL",
        "https://api.kimi.com/coding/v1",
      ).replace(/\/+$/, ""),
      kimiOAuthHost: get("KIMI_OAUTH_HOST", "https://auth.kimi.com").replace(
        /\/+$/,
        "",
      ),
      geminiQuotaPath: get("GEMINI_QUOTA_PATH"),
    },
    anthropic: {
      adminApiKey: get("ANTHROPIC_ADMIN_API_KEY"),
      baseUrl: get("ANTHROPIC_USAGE_BASE_URL", "https://api.anthropic.com").replace(/\/$/, ""),
    },
    openai: {
      adminApiKey: get("OPENAI_ADMIN_API_KEY"),
      baseUrl: get("OPENAI_USAGE_BASE_URL", "https://api.openai.com").replace(/\/$/, ""),
    },
    xai: {
      apiKey: get("XAI_API_KEY"),
      baseUrl: get("XAI_USAGE_BASE_URL", "https://api.x.ai").replace(/\/$/, ""),
      usageEnabled: getBool("XAI_USAGE_ENABLED", false),
      usagePath: get("XAI_USAGE_PATH", "/v1/usage"),
    },
    soloEmpire: {
      dbPath: get("SOLO_EMPIRE_DB_PATH"),
      apiUrl: get("SOLO_EMPIRE_USAGE_API_URL"),
      apiToken: get("SOLO_EMPIRE_USAGE_API_TOKEN"),
    },
  };
}

/** Default config loaded from process.env / .env at import time for the server. */
export const appConfig: AppConfig = loadConfig();

// Keep helper exports for modules that already imported named helpers.
export { env, envInt, envBool, usageSource };
