import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createAiUsageHandler,
  createHealthHandler,
  createReadyHandler,
} from "../src/routes/ai-usage.js";
import type { UsageService } from "../src/lib/usage-service.js";

function mockRes() {
  const chunks: Buffer[] = [];
  let statusCode = 0;
  let headers: Record<string, string | number | string[]> = {};
  const res = {
    writeHead(code: number, h: Record<string, string | number | string[]>) {
      statusCode = code;
      headers = h;
    },
    end(payload?: string | Buffer) {
      if (payload) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    get status() {
      return statusCode;
    },
    get headers() {
      return headers;
    },
    body() {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    },
  };
}

describe("routes", () => {
  it("health returns ok", () => {
    const handler = createHealthHandler();
    const out = mockRes();
    handler({} as http.IncomingMessage, out.res);
    expect(out.status).toBe(200);
    expect(out.body().ok).toBe(true);
  });

  it("rejects missing auth", async () => {
    const usageService = {
      getUsage: vi.fn(),
    } as unknown as UsageService;
    const handler = createAiUsageHandler({ deviceToken: "secret", usageService });
    const out = mockRes();
    await handler(
      { method: "GET", headers: {}, url: "/api/ai-usage?window=today" } as http.IncomingMessage,
      out.res,
    );
    expect(out.status).toBe(401);
  });

  it("returns usage for authorized request", async () => {
    const usageService = {
      getUsage: vi.fn(async () => ({
        window: "today",
        generated_at: "2026-08-08T00:00:00.000Z",
        cache: { hit: false, ttl_seconds: 60 },
        providers: [
          {
            provider: "claude",
            requests: 1,
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            cost_usd: 0,
            status: "ok",
            updated_at: "2026-08-08T00:00:00.000Z",
          },
        ],
      })),
    } as unknown as UsageService;

    const handler = createAiUsageHandler({ deviceToken: "secret", usageService });
    const out = mockRes();
    await handler(
      {
        method: "GET",
        headers: { authorization: "Bearer secret", host: "localhost" },
        url: "/api/ai-usage?window=today",
      } as http.IncomingMessage,
      out.res,
    );
    expect(out.status).toBe(200);
    expect(out.body().providers[0].provider).toBe("claude");
  });

  it("validates window", async () => {
    const handler = createAiUsageHandler({
      deviceToken: "secret",
      usageService: { getUsage: vi.fn() } as unknown as UsageService,
    });
    const out = mockRes();
    await handler(
      {
        method: "GET",
        headers: { authorization: "Bearer secret", host: "localhost" },
        url: "/api/ai-usage?window=nope",
      } as http.IncomingMessage,
      out.res,
    );
    expect(out.status).toBe(400);
  });

  it("reports readiness and quota status without requiring device auth", async () => {
    const usageService = {
      getUsage: vi.fn(async () => ({
        window: "today",
        generated_at: "2026-08-08T00:00:00.000Z",
        cache: { hit: false, ttl_seconds: 60 },
        providers: [
          {
            provider: "claude",
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cost_usd: 0,
            status: "ok",
            updated_at: "2026-08-08T00:00:00.000Z",
            quota: {
              status: "ok",
              windows: [],
              updated_at: "2026-08-08T00:00:00.000Z",
            },
          },
        ],
      })),
    } as unknown as UsageService;
    const handler = createReadyHandler({ deviceToken: "secret", usageService });
    const out = mockRes();

    await handler(
      { method: "GET", headers: {}, url: "/ready" } as http.IncomingMessage,
      out.res,
    );

    expect(out.status).toBe(200);
    expect(out.body().ready).toBe(true);
    expect(out.body().providers[0].quota_status).toBe("ok");
  });

  it("returns not ready when a quota snapshot is stale", async () => {
    const usageService = {
      getUsage: vi.fn(async () => ({
        window: "today",
        generated_at: "2026-08-08T00:00:00.000Z",
        cache: { hit: false, ttl_seconds: 60 },
        providers: [
          {
            provider: "claude",
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cost_usd: 0,
            status: "ok",
            updated_at: "2026-08-08T00:00:00.000Z",
            quota: {
              status: "stale",
              windows: [],
              updated_at: "2026-08-07T00:00:00.000Z",
              message: "snapshot is stale",
            },
          },
        ],
      })),
    } as unknown as UsageService;
    const handler = createReadyHandler({ deviceToken: "secret", usageService });
    const out = mockRes();

    await handler(
      { method: "GET", headers: {}, url: "/ready" } as http.IncomingMessage,
      out.res,
    );

    expect(out.status).toBe(503);
    expect(out.body().ready).toBe(false);
    expect(out.body().providers[0].quota_status).toBe("stale");
  });
});
