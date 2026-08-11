import type { AppConfig } from "../config.js";
import { resolveWindow } from "../lib/window.js";
import {
  emptyUsage,
  type AdapterResult,
  type UsageAdapter,
  type UsageWindow,
} from "../types/usage.js";
import { defaultFetch, fetchJson, type FetchLike } from "./http.js";

/**
 * OpenAI Organization Completions Usage + Costs APIs.
 * Requires an Admin key (not a standard project API key).
 * Display label: CODEX (covers OpenAI/Codex usage).
 */
export class OpenAIUsageAdapter implements UsageAdapter {
  readonly name = "openai";
  readonly provider = "codex" as const;

  constructor(
    private readonly config: AppConfig["openai"],
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.adminApiKey);
  }

  async fetchUsage(window: UsageWindow, now: Date = new Date()): Promise<AdapterResult> {
    if (!this.isConfigured()) {
      return emptyUsage(this.provider, "unavailable", "OPENAI_ADMIN_API_KEY not set", now);
    }

    const tw = resolveWindow(window, now);
    const limit = window === "today" ? 1 : window === "7d" ? 7 : 30;
    const bucketWidth = window === "today" ? "1d" : "1d";

    const usageUrl =
      `${this.config.baseUrl}/v1/organization/usage/completions` +
      `?start_time=${tw.startUnix}&bucket_width=${bucketWidth}&limit=${limit}`;

    const costsUrl =
      `${this.config.baseUrl}/v1/organization/costs` +
      `?start_time=${tw.startUnix}&bucket_width=1d&limit=${limit}`;

    const headers = {
      Authorization: `Bearer ${this.config.adminApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    try {
      const [usageRes, costsRes] = await Promise.all([
        fetchJson(this.fetchImpl, usageUrl, headers),
        fetchJson(this.fetchImpl, costsUrl, headers),
      ]);

      if (usageRes.status === 401 || usageRes.status === 403) {
        return emptyUsage(this.provider, "error", `OpenAI auth failed (${usageRes.status})`, now);
      }
      if (usageRes.status === 404) {
        return emptyUsage(
          this.provider,
          "unavailable",
          "OpenAI usage endpoint not available",
          now,
        );
      }
      if (usageRes.status < 200 || usageRes.status >= 300) {
        return emptyUsage(this.provider, "error", `OpenAI usage HTTP ${usageRes.status}`, now);
      }

      const tokens = aggregateOpenAIUsage(usageRes.body);
      const cost =
        costsRes.status >= 200 && costsRes.status < 300
          ? aggregateOpenAICosts(costsRes.body)
          : 0;

      return {
        provider: this.provider,
        ...tokens,
        cost_usd: roundCost(cost),
        status: tokens.requests > 0 ? "ok" : "no_data",
        updated_at: now.toISOString(),
        message:
          tokens.requests > 0
            ? undefined
            : "OpenAI usage API returned no rows in selected window",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "OpenAI fetch failed";
      return emptyUsage(this.provider, "error", message, now);
    }
  }
}

export function aggregateOpenAIUsage(body: unknown): {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  let input = 0;
  let output = 0;
  let requests = 0;

  const buckets = extractBuckets(body);
  for (const bucket of buckets) {
    const results = Array.isArray(bucket.results) ? bucket.results : [];
    for (const row of results) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      input += num(r.input_tokens);
      output += num(r.output_tokens);
      requests += num(r.num_model_requests);
    }
  }

  return {
    requests,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  };
}

export function aggregateOpenAICosts(body: unknown): number {
  let total = 0;
  const buckets = extractBuckets(body);
  for (const bucket of buckets) {
    const results = Array.isArray(bucket.results) ? bucket.results : [];
    for (const row of results) {
      if (!row || typeof row !== "object") continue;
      const amount = (row as { amount?: { value?: unknown } }).amount;
      total += num(amount?.value);
    }
  }
  return total;
}

function extractBuckets(body: unknown): Array<{ results?: unknown[] }> {
  if (!body) return [];
  if (Array.isArray(body)) return body as Array<{ results?: unknown[] }>;
  if (typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: Array<{ results?: unknown[] }> }).data;
  }
  return [];
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function roundCost(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
