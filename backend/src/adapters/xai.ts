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
 * xAI / Grok usage adapter.
 *
 * As of 2026, xAI documents billing and console usage explorer but does not
 * ship a stable public Usage API comparable to OpenAI Admin usage endpoints.
 * By default this adapter returns `unavailable` unless XAI_USAGE_ENABLED=true
 * and a working path is configured — so the display stays honest.
 */
export class XaiUsageAdapter implements UsageAdapter {
  readonly name = "xai";
  readonly provider = "grok" as const;

  constructor(
    private readonly config: AppConfig["xai"],
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey) && this.config.usageEnabled;
  }

  async fetchUsage(window: UsageWindow, now: Date = new Date()): Promise<AdapterResult> {
    if (!this.config.apiKey) {
      return emptyUsage(this.provider, "unavailable", "XAI_API_KEY not set", now);
    }
    if (!this.config.usageEnabled) {
      return emptyUsage(
        this.provider,
        "unavailable",
        "xAI public Usage API not enabled (set XAI_USAGE_ENABLED=true when available)",
        now,
      );
    }

    const tw = resolveWindow(window, now);
    const path = this.config.usagePath.startsWith("/")
      ? this.config.usagePath
      : `/${this.config.usagePath}`;
    const url =
      `${this.config.baseUrl}${path}` +
      `?start_time=${tw.startUnix}&end_time=${tw.endUnix}`;

    try {
      const { status, body } = await fetchJson(this.fetchImpl, url, {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "application/json",
      });

      if (status === 401 || status === 403) {
        return emptyUsage(this.provider, "error", `xAI auth failed (${status})`, now);
      }
      if (status === 404 || status === 501) {
        return emptyUsage(
          this.provider,
          "unavailable",
          "xAI usage endpoint not available",
          now,
        );
      }
      if (status < 200 || status >= 300) {
        return emptyUsage(this.provider, "error", `xAI HTTP ${status}`, now);
      }

      const agg = aggregateXaiBody(body);
      return {
        provider: this.provider,
        ...agg,
        status: agg.requests > 0 ? "ok" : "no_data",
        updated_at: now.toISOString(),
        message:
          agg.requests > 0 ? undefined : "xAI usage API returned no rows in selected window",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "xAI fetch failed";
      return emptyUsage(this.provider, "error", message, now);
    }
  }
}

export function aggregateXaiBody(body: unknown): {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
} {
  if (!body || typeof body !== "object") {
    return { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 };
  }
  const o = body as Record<string, unknown>;
  // Support a few plausible shapes without guessing secrets/content fields.
  const totals =
    o.totals && typeof o.totals === "object"
      ? (o.totals as Record<string, unknown>)
      : o;

  const input = num(totals.input_tokens ?? totals.prompt_tokens);
  const output = num(totals.output_tokens ?? totals.completion_tokens);
  const total = num(totals.total_tokens) || input + output;
  const requests = num(totals.requests ?? totals.num_requests ?? totals.request_count);
  const cost = num(totals.cost_usd ?? totals.cost ?? totals.amount);

  return {
    requests,
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cost_usd: Math.round(cost * 1e6) / 1e6,
  };
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}
