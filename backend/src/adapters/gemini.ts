import {
  emptyUsage,
  type AdapterResult,
  type UsageAdapter,
  type UsageWindow,
} from "../types/usage.js";

/**
 * Gemini telemetry is intentionally separate from the Antigravity quota
 * bridge. The bridge supplies subscription windows; this adapter keeps the
 * normal token/cost source honest until a Gemini API telemetry source exists.
 */
export class GeminiUsageAdapter implements UsageAdapter {
  readonly name = "gemini";
  readonly provider = "gemini" as const;

  isConfigured(): boolean {
    return false;
  }

  async fetchUsage(_window: UsageWindow, now = new Date()): Promise<AdapterResult> {
    return emptyUsage(
      this.provider,
      "unavailable",
      "Gemini telemetry source not configured; quota comes from Antigravity bridge",
      now,
    );
  }
}
