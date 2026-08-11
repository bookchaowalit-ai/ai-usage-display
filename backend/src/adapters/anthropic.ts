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
 * Anthropic Admin Usage API adapter.
 * Docs: GET /v1/organizations/usage_report/messages
 * Auth: Admin API key (x-api-key) or OAuth Bearer.
 * Never stores prompts or response content — aggregates tokens only.
 */
export class AnthropicUsageAdapter implements UsageAdapter {
  readonly name = "anthropic";
  readonly provider = "claude" as const;

  constructor(
    private readonly config: AppConfig["anthropic"],
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.adminApiKey);
  }

  async fetchUsage(window: UsageWindow, now: Date = new Date()): Promise<AdapterResult> {
    if (!this.isConfigured()) {
      return emptyUsage(this.provider, "unavailable", "ANTHROPIC_ADMIN_API_KEY not set", now);
    }

    const tw = resolveWindow(window, now);
    const params = new URLSearchParams({
      starting_at: tw.startingAt,
      ending_at: tw.endingAt,
      bucket_width: window === "today" ? "1h" : "1d",
    });
    // limit depends on bucket_width; keep within published maxes
    params.set("limit", window === "today" ? "24" : window === "7d" ? "7" : "31");

    const url = `${this.config.baseUrl}/v1/organizations/usage_report/messages?${params}`;

    try {
      const { status, body } = await fetchJson(this.fetchImpl, url, {
        "anthropic-version": "2023-06-01",
        "x-api-key": this.config.adminApiKey,
        Authorization: `Bearer ${this.config.adminApiKey}`,
        Accept: "application/json",
      });

      if (status === 401 || status === 403) {
        return emptyUsage(this.provider, "error", `Anthropic auth failed (${status})`, now);
      }
      if (status === 404) {
        return emptyUsage(
          this.provider,
          "unavailable",
          "Anthropic usage report endpoint not available for this account",
          now,
        );
      }
      if (status < 200 || status >= 300) {
        return emptyUsage(this.provider, "error", `Anthropic HTTP ${status}`, now);
      }

      const aggregated = aggregateAnthropicBody(body);
      return {
        provider: this.provider,
        ...aggregated,
        cost_usd: 0, // cost report is a separate Admin endpoint; keep 0 unless cost API wired
        status: aggregated.requests > 0 ? "ok" : "no_data",
        updated_at: now.toISOString(),
        message:
          aggregated.requests > 0
            ? undefined
            : "Anthropic usage API returned no rows in selected window",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Anthropic fetch failed";
      return emptyUsage(this.provider, "error", message, now);
    }
  }
}

export function aggregateAnthropicBody(body: unknown): {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  let input = 0;
  let output = 0;
  let requests = 0;

  if (!body || typeof body !== "object") {
    return { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }

  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }

  for (const bucket of data) {
    if (!bucket || typeof bucket !== "object") continue;
    const results = (bucket as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const row of results) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const uncached = num(r.uncached_input_tokens);
      const cacheRead = num(r.cache_read_input_tokens);
      const cacheCreate = r.cache_creation;
      let cacheCreateTokens = 0;
      if (cacheCreate && typeof cacheCreate === "object") {
        const c = cacheCreate as Record<string, unknown>;
        cacheCreateTokens =
          num(c.ephemeral_1h_input_tokens) + num(c.ephemeral_5m_input_tokens);
      }
      const out = num(r.output_tokens);
      input += uncached + cacheRead + cacheCreateTokens;
      output += out;
      // Anthropic usage report does not always include request counts; estimate 1 per result row
      // when no explicit field is present.
      const explicit =
        num(r.num_requests) ||
        num(r.request_count) ||
        num(r.requests) ||
        num(r.message_count);
      requests += explicit > 0 ? explicit : 1;
    }
  }

  return {
    requests,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
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
