import { describe, expect, it } from "vitest";
import {
  parseClaudeCliUsage,
  parseClaudeQuotaBody,
  parseCodexQuotaBody,
  parseGrokQuotaBody,
  parseKimiQuotaBody,
} from "../src/adapters/subscription-quotas.js";

const now = new Date("2026-08-08T07:00:00.000Z");

describe("local subscription quota parsers", () => {
  it("maps Claude five-hour and weekly windows and selects the tighter one", () => {
    const quota = parseClaudeQuotaBody(
      {
        five_hour: { utilization: 12, resets_at: "2026-08-08T09:00:00Z" },
        seven_day: { utilization: 64, resets_at: "2026-08-11T16:00:00Z" },
      },
      now,
      "pro",
    );

    expect(quota.status).toBe("ok");
    expect(quota.plan).toBe("pro");
    expect(quota.primary?.label).toBe("week");
    expect(quota.primary?.remaining_percent).toBe(36);
    expect(quota.windows).toHaveLength(2);
  });

  it("parses Claude non-interactive /usage output as a safe fallback", () => {
    const quota = parseClaudeCliUsage(
      JSON.stringify({
        result:
          "Current session: 25% used · resets Aug 9, 9:29pm (Asia/Bangkok)\n" +
          "Current week (all models): 40% used · resets Aug 13, 6:59am (Asia/Bangkok)",
      }),
      now,
    );

    expect(quota.primary?.remaining_percent).toBe(60);
    expect(quota.windows.find((window) => window.label === "5h")?.resets_at).toBe(
      "2026-08-09T14:29:00.000Z",
    );
    expect(quota.windows.find((window) => window.label === "week")?.resets_at).toBe(
      "2026-08-12T23:59:00.000Z",
    );
  });

  it("parses Claude reset times when the CLI omits minutes", () => {
    const quota = parseClaudeCliUsage(
      "Current session: 25% used · resets Aug 9, 9:30pm (Asia/Bangkok)\n" +
        "Current week (all models): 40% used · resets Aug 13, 7am (Asia/Bangkok)",
      now,
    );

    expect(quota.windows.find((window) => window.label === "week")?.resets_at).toBe(
      "2026-08-13T00:00:00.000Z",
    );
  });

  it("maps Codex app-server rate limits", () => {
    const quota = parseCodexQuotaBody(
      {
        rateLimitsByLimitId: {
          codex: {
            planType: "plus",
            primary: {
              usedPercent: 64,
              windowDurationMins: 10080,
              resetsAt: 1786174571,
            },
          },
        },
      },
      now,
    );

    expect(quota.status).toBe("ok");
    expect(quota.plan).toBe("plus");
    expect(quota.primary).toMatchObject({
      label: "week",
      used_percent: 64,
      remaining_percent: 36,
    });
    expect(quota.primary?.resets_at).toBe("2026-08-08T07:36:11.000Z");
  });

  it("falls back to the legacy Codex bucket when the limit map is empty", () => {
    const quota = parseCodexQuotaBody(
      {
        rateLimitsByLimitId: {},
        rateLimits: {
          limitId: "codex",
          planType: "plus",
          primary: {
            usedPercent: 12,
            windowDurationMins: 10080,
            resetsAt: 1786174571,
          },
        },
      },
      now,
    );

    expect(quota.status).toBe("ok");
    expect(quota.primary?.label).toBe("week");
    expect(quota.primary?.remaining_percent).toBe(88);
  });

  it("maps Grok weekly billing percentage and reset", () => {
    const quota = parseGrokQuotaBody(
      {
        config: {
          creditUsagePercent: 22,
          currentPeriod: { end: "2026-08-11T16:43:23.633082+00:00" },
        },
        subscription_tier: "X Premium+",
      },
      now,
    );

    expect(quota.status).toBe("ok");
    expect(quota.plan).toBe("X Premium+");
    expect(quota.primary?.remaining_percent).toBe(78);
    expect(quota.primary?.resets_at).toBe("2026-08-11T16:43:23.633Z");
  });

  it("maps Kimi weekly and rolling five-hour quota", () => {
    const quota = parseKimiQuotaBody(
      {
        usage: {
          used: "400",
          limit: "1000",
          resetTime: "2026-08-15T07:00:00Z",
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              used: "75",
              limit: "100",
              resetTime: "2026-08-08T09:00:00Z",
            },
          },
        ],
      },
      now,
    );

    expect(quota.status).toBe("ok");
    expect(quota.plan).toBe("Kimi Code");
    expect(quota.windows).toHaveLength(2);
    expect(quota.primary).toMatchObject({
      label: "5h",
      used_percent: 75,
      remaining_percent: 25,
      resets_at: "2026-08-08T09:00:00.000Z",
    });
  });

  it("supports Kimi's remaining-based payload and membership level", () => {
    const quota = parseKimiQuotaBody(
      {
        user: { membership: { level: "LEVEL_BASIC" } },
        usage: {
          remaining: "80",
          limit: "100",
          resetTime: "2026-08-15T07:00:00Z",
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              remaining: "35",
              limit: "100",
              resetTime: "2026-08-08T10:00:00Z",
            },
          },
        ],
      },
      now,
    );

    expect(quota.plan).toBe("Basic");
    expect(quota.primary).toMatchObject({
      label: "5h",
      used_percent: 65,
      remaining_percent: 35,
    });
  });
});
