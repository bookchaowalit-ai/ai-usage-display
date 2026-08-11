import { describe, expect, it } from "vitest";
import { aggregateAnthropicBody, AnthropicUsageAdapter } from "../src/adapters/anthropic.js";
import type { FetchLike } from "../src/adapters/http.js";

describe("aggregateAnthropicBody", () => {
  it("sums input/output tokens across buckets", () => {
    const body = {
      data: [
        {
          results: [
            {
              uncached_input_tokens: 1000,
              cache_read_input_tokens: 200,
              cache_creation: {
                ephemeral_1h_input_tokens: 100,
                ephemeral_5m_input_tokens: 50,
              },
              output_tokens: 300,
            },
          ],
        },
      ],
    };
    const agg = aggregateAnthropicBody(body);
    expect(agg.input_tokens).toBe(1350);
    expect(agg.output_tokens).toBe(300);
    expect(agg.total_tokens).toBe(1650);
    expect(agg.requests).toBe(1);
  });

  it("handles empty body", () => {
    expect(aggregateAnthropicBody(null)).toEqual({
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
  });
});

describe("AnthropicUsageAdapter", () => {
  it("returns unavailable without key", async () => {
    const adapter = new AnthropicUsageAdapter({ adminApiKey: "", baseUrl: "https://api.anthropic.com" });
    const result = await adapter.fetchUsage("today");
    expect(result.status).toBe("unavailable");
    expect(result.provider).toBe("claude");
  });

  it("maps successful usage response", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({
        data: [
          {
            results: [
              {
                uncached_input_tokens: 10,
                cache_read_input_tokens: 0,
                cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
                output_tokens: 5,
              },
            ],
          },
        ],
      }),
      json: async () => ({
        data: [
          {
            results: [
              {
                uncached_input_tokens: 10,
                cache_read_input_tokens: 0,
                cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
                output_tokens: 5,
              },
            ],
          },
        ],
      }),
    });

    const adapter = new AnthropicUsageAdapter(
      { adminApiKey: "sk-admin-test", baseUrl: "https://api.anthropic.com" },
      fetchImpl,
    );
    const result = await adapter.fetchUsage("today");
    expect(result.status).toBe("ok");
    expect(result.input_tokens).toBe(10);
    expect(result.output_tokens).toBe(5);
    expect(result.total_tokens).toBe(15);
  });
});
