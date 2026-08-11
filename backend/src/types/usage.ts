/** Display / API provider identifiers shown on the ESP32 cards. */
export type DisplayProvider = "claude" | "codex" | "grok" | "kimi" | "gemini";

/** Lifecycle status for one provider row. */
export type UsageStatus = "ok" | "no_data" | "stale" | "unavailable" | "error";

export type UsageWindow = "today" | "7d" | "30d";

/** One provider subscription quota window, independent of API token telemetry. */
export interface QuotaWindow {
  id: string;
  label: string;
  used_percent: number;
  remaining_percent: number;
  resets_at: string | null;
  duration_minutes?: number;
}

/** Subscription quota read from an authenticated local provider CLI. */
export interface ProviderQuota {
  status: UsageStatus;
  plan?: string;
  primary?: QuotaWindow;
  windows: QuotaWindow[];
  updated_at: string;
  message?: string;
}

export interface ProviderUsage {
  provider: DisplayProvider;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  status: UsageStatus;
  updated_at: string;
  quota?: ProviderQuota;
  /** Optional human-readable reason when not ok (never secrets). */
  message?: string;
}

export interface UsageResponse {
  window: UsageWindow;
  generated_at: string;
  cache: {
    hit: boolean;
    ttl_seconds: number;
  };
  providers: ProviderUsage[];
}

export interface AdapterResult {
  provider: DisplayProvider;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  status: UsageStatus;
  updated_at: string;
  quota?: ProviderQuota;
  message?: string;
}

export function emptyQuota(
  status: UsageStatus,
  message?: string,
  now: Date = new Date(),
): ProviderQuota {
  return {
    status,
    windows: [],
    updated_at: now.toISOString(),
    message,
  };
}

export interface UsageAdapter {
  readonly name: string;
  readonly provider: DisplayProvider;
  /** Whether credentials / config allow attempting a fetch. */
  isConfigured(): boolean;
  fetchUsage(window: UsageWindow, now?: Date): Promise<AdapterResult>;
}

export function emptyUsage(
  provider: DisplayProvider,
  status: UsageStatus,
  message?: string,
  now: Date = new Date(),
): AdapterResult {
  return {
    provider,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    status,
    updated_at: now.toISOString(),
    message,
  };
}
