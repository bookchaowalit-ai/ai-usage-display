import type { SoloEmpireAdapter } from "../adapters/solo-empire.js";
import type { AppConfig, UsageSourceMode } from "../config.js";
import type {
  AdapterResult,
  DisplayProvider,
  ProviderQuota,
  ProviderUsage,
  UsageResponse,
  UsageAdapter,
  UsageWindow,
} from "../types/usage.js";
import { emptyUsage } from "../types/usage.js";
import { TtlCache } from "./cache.js";

export interface ProviderAdapters {
  claude: UsageAdapter;
  codex: UsageAdapter;
  grok: UsageAdapter;
  kimi: UsageAdapter;
  gemini: UsageAdapter;
}

export interface SubscriptionQuotaSource {
  fetchAll(now?: Date): Promise<Record<DisplayProvider, ProviderQuota>>;
}

const PROVIDERS: DisplayProvider[] = ["claude", "codex", "grok", "kimi", "gemini"];

/**
 * Aggregates provider adapters + optional Solo Empire read-only source,
 * with 60s response cache and stale-on-error behaviour.
 */
export class UsageService {
  private readonly cache: TtlCache<UsageResponse>;
  private readonly lastGood = new Map<string, { at: number; providers: ProviderUsage[] }>();

  constructor(
    private readonly config: Pick<
      AppConfig,
      "cacheTtlSeconds" | "staleMaxAgeSeconds" | "usageSource"
    >,
    private readonly adapters: ProviderAdapters,
    private readonly soloEmpire: SoloEmpireAdapter,
    private readonly subscriptionQuotas?: SubscriptionQuotaSource,
  ) {
    this.cache = new TtlCache<UsageResponse>(config.cacheTtlSeconds * 1000);
  }

  async getUsage(window: UsageWindow, now: Date = new Date()): Promise<UsageResponse> {
    const cacheKey = `usage:${window}`;
    const cached = this.cache.get(cacheKey, now.getTime());
    if (cached.hit) {
      return {
        ...cached.value,
        cache: { hit: true, ttl_seconds: this.config.cacheTtlSeconds },
      };
    }

    try {
      const [providers, quotas] = await Promise.all([
        this.collect(window, now),
        this.subscriptionQuotas
          ? this.subscriptionQuotas.fetchAll(now).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      const response: UsageResponse = {
        window,
        generated_at: now.toISOString(),
        cache: { hit: false, ttl_seconds: this.config.cacheTtlSeconds },
        providers: PROVIDERS.map((p) =>
          toProviderUsage(
            quotas ? { ...providers[p], quota: quotas[p] } : providers[p],
          ),
        ),
      };
      this.cache.set(cacheKey, response, undefined, now.getTime());
      this.lastGood.set(cacheKey, { at: now.getTime(), providers: response.providers });
      return response;
    } catch {
      return this.staleOrEmpty(cacheKey, window, now, "upstream aggregation failed");
    }
  }

  /** Exposed for tests. */
  async collect(
    window: UsageWindow,
    now: Date,
  ): Promise<Record<DisplayProvider, AdapterResult>> {
    const mode: UsageSourceMode = this.config.usageSource;

    if (mode === "solo_empire") {
      return this.soloEmpire.fetchAll(window, now);
    }

    const [claude, codex, grok, kimi, gemini] = await Promise.all([
      this.safeFetch(this.adapters.claude, window, now),
      this.safeFetch(this.adapters.codex, window, now),
      this.safeFetch(this.adapters.grok, window, now),
      this.safeFetch(this.adapters.kimi, window, now),
      this.safeFetch(this.adapters.gemini, window, now),
    ]);

    let result: Record<DisplayProvider, AdapterResult> = {
      claude,
      codex,
      grok,
      kimi,
      gemini,
    };

    if (mode === "hybrid" && this.soloEmpire.isConfigured()) {
      const needsFill = PROVIDERS.some(
        (p) =>
          result[p].status === "no_data" ||
          result[p].status === "unavailable" ||
          result[p].status === "error",
      );
      if (needsFill) {
        const solo = await this.soloEmpire.fetchAll(window, now);
        result = mergePreferPrimary(result, solo);
      }
    }

    return result;
  }

  private async safeFetch(
    adapter: { fetchUsage: (w: UsageWindow, now?: Date) => Promise<AdapterResult>; provider: DisplayProvider },
    window: UsageWindow,
    now: Date,
  ): Promise<AdapterResult> {
    try {
      return await adapter.fetchUsage(window, now);
    } catch (err) {
      const message = err instanceof Error ? err.message : "adapter failed";
      return emptyUsage(adapter.provider, "error", message, now);
    }
  }

  private staleOrEmpty(
    cacheKey: string,
    window: UsageWindow,
    now: Date,
    message: string,
  ): UsageResponse {
    const prev = this.lastGood.get(cacheKey);
    const age = prev ? now.getTime() - prev.at : Infinity;
    if (prev && age <= this.config.staleMaxAgeSeconds * 1000) {
      return {
        window,
        generated_at: now.toISOString(),
        cache: { hit: false, ttl_seconds: this.config.cacheTtlSeconds },
        providers: prev.providers.map((p) => ({
          ...p,
          status: "stale" as const,
          message: message,
        })),
      };
    }
    return {
      window,
      generated_at: now.toISOString(),
      cache: { hit: false, ttl_seconds: this.config.cacheTtlSeconds },
      providers: PROVIDERS.map((p) =>
        toProviderUsage(emptyUsage(p, "error", message, now)),
      ),
    };
  }
}

export function mergePreferPrimary(
  primary: Record<DisplayProvider, AdapterResult>,
  fallback: Record<DisplayProvider, AdapterResult>,
): Record<DisplayProvider, AdapterResult> {
  const out = { ...primary };
  for (const p of PROVIDERS) {
    if (
      primary[p].status === "no_data" ||
      primary[p].status === "unavailable" ||
      primary[p].status === "error"
    ) {
      // The fallback source was read successfully even when its window is empty.
      if (fallback[p].status === "ok" || fallback[p].status === "no_data") {
        out[p] = {
          ...fallback[p],
          message: fallback[p].message ?? "filled-from-solo-empire",
        };
      }
    }
  }
  return out;
}

function toProviderUsage(r: AdapterResult): ProviderUsage {
  const row: ProviderUsage = {
    provider: r.provider,
    requests: r.requests,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    total_tokens: r.total_tokens,
    cost_usd: r.cost_usd,
    status: r.status,
    updated_at: r.updated_at,
  };
  if (r.message) row.message = r.message;
  if (r.quota) row.quota = r.quota;
  return row;
}
