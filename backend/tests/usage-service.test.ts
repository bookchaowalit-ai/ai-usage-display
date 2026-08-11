import { describe, expect, it, vi } from "vitest";
import type { AdapterResult, UsageAdapter, UsageWindow } from "../src/types/usage.js";
import { emptyQuota, emptyUsage } from "../src/types/usage.js";
import { mergePreferPrimary, UsageService } from "../src/lib/usage-service.js";
import type { SoloEmpireAdapter } from "../src/adapters/solo-empire.js";

function stubAdapter(
  provider: AdapterResult["provider"],
  result: Partial<AdapterResult> & { status: AdapterResult["status"] },
): UsageAdapter {
  return {
    name: provider,
    provider,
    isConfigured: () => true,
    fetchUsage: async (_w: UsageWindow, now = new Date()) => ({
      provider,
      requests: result.requests ?? 0,
      input_tokens: result.input_tokens ?? 0,
      output_tokens: result.output_tokens ?? 0,
      total_tokens: result.total_tokens ?? 0,
      cost_usd: result.cost_usd ?? 0,
      status: result.status,
      updated_at: now.toISOString(),
      message: result.message,
    }),
  };
}

describe("mergePreferPrimary", () => {
  it("fills unavailable from fallback", () => {
    const now = new Date();
    const primary = {
      claude: emptyUsage("claude", "unavailable", "no key", now),
      codex: { ...emptyUsage("codex", "ok", undefined, now), requests: 5, total_tokens: 10 },
      grok: emptyUsage("grok", "error", "fail", now),
      kimi: emptyUsage("kimi", "unavailable", "no key", now),
      gemini: emptyUsage("gemini", "unavailable", "no key", now),
    };
    const fallback = {
      claude: { ...emptyUsage("claude", "ok", undefined, now), requests: 2, total_tokens: 20 },
      codex: emptyUsage("codex", "ok", undefined, now),
      grok: { ...emptyUsage("grok", "ok", undefined, now), requests: 1 },
      kimi: emptyUsage("kimi", "no_data", undefined, now),
      gemini: emptyUsage("gemini", "no_data", undefined, now),
    };
    const merged = mergePreferPrimary(primary, fallback);
    expect(merged.claude.requests).toBe(2);
    expect(merged.codex.requests).toBe(5);
    expect(merged.grok.requests).toBe(1);
  });

  it("fills no_data from fallback", () => {
    const now = new Date();
    const primary = {
      claude: emptyUsage("claude", "no_data", "provider returned no rows", now),
      codex: emptyUsage("codex", "ok", undefined, now),
      grok: emptyUsage("grok", "no_data", "provider returned no rows", now),
      kimi: emptyUsage("kimi", "unavailable", "no key", now),
      gemini: emptyUsage("gemini", "unavailable", "no key", now),
    };
    const fallback = {
      claude: { ...emptyUsage("claude", "ok", undefined, now), requests: 2, total_tokens: 20 },
      codex: emptyUsage("codex", "no_data", undefined, now),
      grok: emptyUsage("grok", "no_data", undefined, now),
      kimi: emptyUsage("kimi", "no_data", undefined, now),
      gemini: emptyUsage("gemini", "no_data", undefined, now),
    };
    const merged = mergePreferPrimary(primary, fallback);
    expect(merged.claude.requests).toBe(2);
    expect(merged.codex.status).toBe("ok");
    expect(merged.grok.status).toBe("no_data");
  });

  it("preserves a successful no_data fallback over provider unavailable", () => {
    const now = new Date();
    const merged = mergePreferPrimary(
      {
        claude: emptyUsage("claude", "unavailable", "no key", now),
        codex: emptyUsage("codex", "unavailable", "no key", now),
        grok: emptyUsage("grok", "unavailable", "no key", now),
        kimi: emptyUsage("kimi", "unavailable", "no key", now),
        gemini: emptyUsage("gemini", "unavailable", "no key", now),
      },
      {
        claude: emptyUsage("claude", "no_data", "telemetry read succeeded", now),
        codex: emptyUsage("codex", "no_data", "telemetry read succeeded", now),
        grok: emptyUsage("grok", "no_data", "telemetry read succeeded", now),
        kimi: emptyUsage("kimi", "no_data", "telemetry read succeeded", now),
        gemini: emptyUsage("gemini", "no_data", "telemetry read succeeded", now),
      },
    );
    expect(merged.claude.status).toBe("no_data");
    expect(merged.codex.status).toBe("no_data");
    expect(merged.grok.status).toBe("no_data");
  });
});

describe("UsageService", () => {
  it("adds subscription quota without replacing telemetry fields", async () => {
    const service = new UsageService(
      { cacheTtlSeconds: 60, staleMaxAgeSeconds: 3600, usageSource: "providers" },
      {
        claude: stubAdapter("claude", { status: "no_data" }) as never,
        codex: stubAdapter("codex", { status: "ok", requests: 3 }) as never,
        grok: stubAdapter("grok", { status: "no_data" }) as never,
        kimi: stubAdapter("kimi", { status: "no_data" }) as never,
        gemini: stubAdapter("gemini", { status: "no_data" }) as never,
      },
      {
        isConfigured: () => false,
        fetchAll: async () => ({
          claude: emptyUsage("claude", "unavailable"),
          codex: emptyUsage("codex", "unavailable"),
          grok: emptyUsage("grok", "unavailable"),
          kimi: emptyUsage("kimi", "unavailable"),
          gemini: emptyUsage("gemini", "unavailable"),
        }),
      } as SoloEmpireAdapter,
      {
        fetchAll: async (now = new Date()) => ({
          claude: {
            status: "ok",
            primary: {
              id: "five_hour",
              label: "5h",
              used_percent: 20,
              remaining_percent: 80,
              resets_at: null,
            },
            windows: [],
            updated_at: now.toISOString(),
          },
          codex: emptyQuota("unavailable", "Codex CLI not found", now),
          grok: {
            status: "ok",
            primary: {
              id: "weekly",
              label: "week",
              used_percent: 22,
              remaining_percent: 78,
              resets_at: "2026-08-11T16:43:23.633Z",
            },
            windows: [],
            updated_at: now.toISOString(),
          },
          kimi: emptyQuota("unavailable", "Kimi login not found", now),
          gemini: emptyQuota("unavailable", "Gemini quota bridge not configured", now),
        }),
      },
    );

    const response = await service.getUsage("today");
    expect(response.providers.find((p) => p.provider === "codex")?.requests).toBe(3);
    expect(
      response.providers.find((p) => p.provider === "grok")?.quota?.primary
        ?.remaining_percent,
    ).toBe(78);
  });

  it("caches responses for TTL", async () => {
    let calls = 0;
    const claude = {
      ...stubAdapter("claude", { status: "ok", requests: 1 }),
      fetchUsage: async () => {
        calls += 1;
        return {
          provider: "claude" as const,
          requests: calls,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          status: "ok" as const,
          updated_at: new Date().toISOString(),
        };
      },
    };

    const service = new UsageService(
      { cacheTtlSeconds: 60, staleMaxAgeSeconds: 3600, usageSource: "providers" },
      {
        claude: claude as never,
        codex: stubAdapter("codex", { status: "unavailable" }) as never,
        grok: stubAdapter("grok", { status: "unavailable" }) as never,
        kimi: stubAdapter("kimi", { status: "unavailable" }) as never,
        gemini: stubAdapter("gemini", { status: "unavailable" }) as never,
      },
      {
        isConfigured: () => false,
        fetchAll: async () => ({
          claude: emptyUsage("claude", "unavailable"),
          codex: emptyUsage("codex", "unavailable"),
          grok: emptyUsage("grok", "unavailable"),
          kimi: emptyUsage("kimi", "unavailable"),
          gemini: emptyUsage("gemini", "unavailable"),
        }),
      } as SoloEmpireAdapter,
    );

    const a = await service.getUsage("today");
    const b = await service.getUsage("today");
    expect(a.cache.hit).toBe(false);
    expect(b.cache.hit).toBe(true);
    expect(a.providers.find((p) => p.provider === "claude")?.requests).toBe(1);
    expect(b.providers.find((p) => p.provider === "claude")?.requests).toBe(1);
    expect(calls).toBe(1);
  });

  it("hybrid fills from solo empire", async () => {
    const solo = {
      isConfigured: () => true,
      fetchAll: vi.fn(async () => ({
        claude: {
          provider: "claude" as const,
          requests: 9,
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          cost_usd: 0.1,
          status: "ok" as const,
          updated_at: new Date().toISOString(),
        },
        codex: emptyUsage("codex", "unavailable"),
        grok: emptyUsage("grok", "unavailable"),
        kimi: emptyUsage("kimi", "unavailable"),
        gemini: emptyUsage("gemini", "unavailable"),
      })),
    };

    const service = new UsageService(
      { cacheTtlSeconds: 60, staleMaxAgeSeconds: 3600, usageSource: "hybrid" },
      {
        claude: stubAdapter("claude", { status: "unavailable", message: "no key" }) as never,
        codex: stubAdapter("codex", { status: "ok", requests: 3 }) as never,
        grok: stubAdapter("grok", { status: "unavailable" }) as never,
        kimi: stubAdapter("kimi", { status: "unavailable" }) as never,
        gemini: stubAdapter("gemini", { status: "unavailable" }) as never,
      },
      solo as unknown as SoloEmpireAdapter,
    );

    const res = await service.getUsage("today");
    expect(res.providers.find((p) => p.provider === "claude")?.requests).toBe(9);
    expect(res.providers.find((p) => p.provider === "codex")?.requests).toBe(3);
    expect(solo.fetchAll).toHaveBeenCalled();
  });
});
