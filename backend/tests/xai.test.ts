import { describe, expect, it } from "vitest";
import { aggregateXaiBody, XaiUsageAdapter } from "../src/adapters/xai.js";

describe("XaiUsageAdapter", () => {
  it("returns unavailable when usage API disabled", async () => {
    const adapter = new XaiUsageAdapter({
      apiKey: "xai-key",
      baseUrl: "https://api.x.ai",
      usageEnabled: false,
      usagePath: "/v1/usage",
    });
    const result = await adapter.fetchUsage("today");
    expect(result.status).toBe("unavailable");
    expect(result.provider).toBe("grok");
  });

  it("aggregates known shapes", () => {
    expect(
      aggregateXaiBody({
        totals: {
          input_tokens: 10,
          output_tokens: 5,
          requests: 2,
          cost_usd: 0.01,
        },
      }),
    ).toEqual({
      requests: 2,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cost_usd: 0.01,
    });
  });
});
