import {
  emptyUsage,
  type AdapterResult,
  type UsageAdapter,
  type UsageWindow,
} from "../types/usage.js";

/**
 * Kimi Code subscription quota is attached independently by
 * LocalSubscriptionQuotaAdapter. Token/cost telemetry can still be supplied by
 * Solo Empire in hybrid mode.
 */
export class KimiUsageAdapter implements UsageAdapter {
  readonly name = "kimi";
  readonly provider = "kimi" as const;

  isConfigured(): boolean {
    return false;
  }

  async fetchUsage(
    _window: UsageWindow,
    now: Date = new Date(),
  ): Promise<AdapterResult> {
    return emptyUsage(
      this.provider,
      "unavailable",
      "Kimi token telemetry not configured; subscription quota is separate",
      now,
    );
  }
}
