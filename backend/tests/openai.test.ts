import { describe, expect, it } from "vitest";
import {
  aggregateOpenAICosts,
  aggregateOpenAIUsage,
  OpenAIUsageAdapter,
} from "../src/adapters/openai.js";
import type { FetchLike } from "../src/adapters/http.js";

describe("aggregateOpenAIUsage", () => {
  it("sums buckets from data array", () => {
    const body = {
      data: [
        {
          results: [
            { input_tokens: 100, output_tokens: 20, num_model_requests: 3 },
            { input_tokens: 50, output_tokens: 5, num_model_requests: 1 },
          ],
        },
      ],
    };
    expect(aggregateOpenAIUsage(body)).toEqual({
      requests: 4,
      input_tokens: 150,
      output_tokens: 25,
      total_tokens: 175,
    });
  });
});

describe("aggregateOpenAICosts", () => {
  it("sums amount.value", () => {
    const body = [
      { results: [{ amount: { value: 1.5, currency: "usd" } }] },
      { results: [{ amount: { value: 0.25, currency: "usd" } }] },
    ];
    expect(aggregateOpenAICosts(body)).toBeCloseTo(1.75);
  });
});

describe("OpenAIUsageAdapter", () => {
  it("returns unavailable without admin key", async () => {
    const adapter = new OpenAIUsageAdapter({ adminApiKey: "", baseUrl: "https://api.openai.com" });
    expect((await adapter.fetchUsage("today")).status).toBe("unavailable");
  });

  it("combines usage and costs", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/costs")) {
        const body = { data: [{ results: [{ amount: { value: 2.5 } }] }] };
        return {
          ok: true,
          status: 200,
          text: JSON.stringify(body),
          json: async () => body,
        };
      }
      const body = {
        data: [
          {
            results: [{ input_tokens: 1000, output_tokens: 100, num_model_requests: 7 }],
          },
        ],
      };
      return {
        ok: true,
        status: 200,
        text: JSON.stringify(body),
        json: async () => body,
      };
    };

    const adapter = new OpenAIUsageAdapter(
      { adminApiKey: "sk-admin", baseUrl: "https://api.openai.com" },
      fetchImpl,
    );
    const result = await adapter.fetchUsage("today");
    expect(result.status).toBe("ok");
    expect(result.provider).toBe("codex");
    expect(result.requests).toBe(7);
    expect(result.cost_usd).toBe(2.5);
  });
});
