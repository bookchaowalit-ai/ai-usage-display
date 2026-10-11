import type { AppConfig } from "../config.js";
import {
  emptyUsage,
  type AdapterResult,
  type DisplayProvider,
  type UsageAdapter,
  type UsageWindow,
} from "../types/usage.js";
import { defaultFetch, fetchJson, type FetchLike } from "./http.js";

/**
 * Map Solo Empire telemetry provider strings to display cards.
 * Counts/metadata only — never prompt/response text.
 */
export function mapTelemetryProvider(raw: string | null | undefined): DisplayProvider | null {
  if (!raw) return null;
  const p = raw.toLowerCase().trim();
  if (
    p.includes("anthropic") ||
    p.includes("claude") ||
    p === "claude-code" ||
    p === "claude_code"
  ) {
    return "claude";
  }
  if (
    p.includes("openai") ||
    p.includes("codex") ||
    p.includes("gpt") ||
    p === "oai"
  ) {
    return "codex";
  }
  if (p.includes("xai") || p.includes("grok") || p.includes("x-ai")) {
    return "grok";
  }
  if (p.includes("kimi") || p.includes("moonshot")) {
    return "kimi";
  }
  if (p.includes("gemini") || p.includes("google") || p.includes("antigravity")) {
    return "gemini";
  }
  return null;
}

export interface TelemetryRow {
  provider: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

/**
 * Read-only Solo Empire adapter.
 *
 * Source: SOLO_EMPIRE_USAGE_API_URL (HTTP GET returning partial usage rows).
 * The retired SQLite control-plane database is no longer read.
 * If the API is not configured, returns unavailable.
 */
export class SoloEmpireAdapter {
  readonly name = "solo-empire";

  constructor(
    private readonly config: AppConfig["soloEmpire"],
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiUrl);
  }

  /**
   * Fetch aggregated usage for all display providers from Solo Empire.
   */
  async fetchAll(
    window: UsageWindow,
    now: Date = new Date(),
  ): Promise<Record<DisplayProvider, AdapterResult>> {
    const base: Record<DisplayProvider, AdapterResult> = {
      claude: emptyUsage("claude", "unavailable", "Solo Empire source not configured", now),
      codex: emptyUsage("codex", "unavailable", "Solo Empire source not configured", now),
      grok: emptyUsage("grok", "unavailable", "Solo Empire source not configured", now),
      kimi: emptyUsage("kimi", "unavailable", "Solo Empire source not configured", now),
      gemini: emptyUsage("gemini", "unavailable", "Solo Empire source not configured", now),
    };

    if (!this.isConfigured()) return base;

    try {
      const rows: TelemetryRow[] = await this.fetchFromApi(window);

      const buckets: Record<
        DisplayProvider,
        { requests: number; input: number; output: number; total: number; cost: number }
      > = {
        claude: { requests: 0, input: 0, output: 0, total: 0, cost: 0 },
        codex: { requests: 0, input: 0, output: 0, total: 0, cost: 0 },
        grok: { requests: 0, input: 0, output: 0, total: 0, cost: 0 },
        kimi: { requests: 0, input: 0, output: 0, total: 0, cost: 0 },
        gemini: { requests: 0, input: 0, output: 0, total: 0, cost: 0 },
      };
      const seen = new Set<DisplayProvider>();

      for (const row of rows) {
        const key = mapTelemetryProvider(row.provider);
        if (!key) continue;
        seen.add(key);
        buckets[key].requests += row.requests;
        buckets[key].input += row.input_tokens;
        buckets[key].output += row.output_tokens;
        buckets[key].total += row.total_tokens || row.input_tokens + row.output_tokens;
        buckets[key].cost += row.cost_usd;
      }

      // A successful read-only query with no row for a card is not usage data.
      for (const provider of Object.keys(buckets) as DisplayProvider[]) {
        const b = buckets[provider];
        const hasData = seen.has(provider);
        base[provider] = {
          provider,
          requests: b.requests,
          input_tokens: b.input,
          output_tokens: b.output,
          total_tokens: b.total || b.input + b.output,
          cost_usd: Math.round(b.cost * 1e6) / 1e6,
          status: hasData ? "ok" : "no_data",
          updated_at: now.toISOString(),
          message: hasData
            ? "source:solo-empire-telemetry"
            : "source:solo-empire-telemetry; no rows in selected window",
        };
      }
      return base;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Solo Empire read failed";
      return {
        claude: emptyUsage("claude", "error", message, now),
        codex: emptyUsage("codex", "error", message, now),
        grok: emptyUsage("grok", "error", message, now),
        kimi: emptyUsage("kimi", "error", message, now),
        gemini: emptyUsage("gemini", "error", message, now),
      };
    }
  }

  private async fetchFromApi(window: UsageWindow): Promise<TelemetryRow[]> {
    const url = new URL(this.config.apiUrl);
    url.searchParams.set("window", window);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.apiToken) {
      headers.Authorization = `Bearer ${this.config.apiToken}`;
    }
    const { status, body } = await fetchJson(this.fetchImpl, url.toString(), headers);
    if (status < 200 || status >= 300) {
      throw new Error(`Solo Empire API HTTP ${status}`);
    }
    return parseApiBody(body);
  }
}

/**
 * Thin per-provider wrapper so Solo Empire can sit in the same adapter list.
 * Prefer SoloEmpireAdapter.fetchAll from UsageService for batching.
 */
export class SoloEmpireProviderAdapter implements UsageAdapter {
  readonly name: string;
  readonly provider: DisplayProvider;

  constructor(
    private readonly parent: SoloEmpireAdapter,
    provider: DisplayProvider,
  ) {
    this.provider = provider;
    this.name = `solo-empire-${provider}`;
  }

  isConfigured(): boolean {
    return this.parent.isConfigured();
  }

  async fetchUsage(window: UsageWindow, now?: Date): Promise<AdapterResult> {
    const all = await this.parent.fetchAll(window, now);
    return all[this.provider];
  }
}

export function parseApiBody(body: unknown): TelemetryRow[] {
  if (!body || typeof body !== "object") return [];
  const o = body as { providers?: unknown; by_provider?: unknown; rows?: unknown };
  const list = o.providers ?? o.by_provider ?? o.rows;
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    return {
      provider: typeof r.provider === "string" ? r.provider : null,
      requests: num(r.requests),
      input_tokens: num(r.input_tokens),
      output_tokens: num(r.output_tokens),
      total_tokens: num(r.total_tokens),
      cost_usd: num(r.cost_usd ?? r.estimated_cost_usd),
    };
  });
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}
