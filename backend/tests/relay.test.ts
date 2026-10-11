import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRoutes, createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

const DEVICE = "relay-device-token";
const PUSH = "relay-push-token";

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("relay route table", () => {
  it("adds the push route only when a relay push handler exists", () => {
    const noop = () => undefined;
    expect(buildRoutes({ usage: noop, health: noop, ready: noop }).map((r) => r.name)).not.toContain(
      "relay-push",
    );
    const relay = buildRoutes({ usage: noop, health: noop, ready: noop, relayPush: noop });
    const push = relay.find((r) => r.name === "relay-push");
    expect(push).toMatchObject({ access: "relay-push", methods: ["POST"], paths: ["/api/relay/snapshot"] });
  });
});

describe("relay mode over HTTP", () => {
  const server = createServer(
    loadConfig({
      DEVICE_TOKEN: DEVICE,
      RELAY_MODE: "server",
      RELAY_PUSH_TOKEN: PUSH,
      SUBSCRIPTION_USAGE_ENABLED: "false",
    }),
  );
  let port = 0;
  const auth = { Authorization: `Bearer ${DEVICE}` };
  const pushAuth = { Authorization: `Bearer ${PUSH}`, "Content-Type": "application/json" };

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports no snapshot before the first push", async () => {
    expect((await call(port, "GET", "/ready")).status).toBe(503);
    const r = await call(port, "GET", "/api/ai-usage?window=today", auth);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("no_snapshot");
  });

  it("rejects pushes without the push token or with the device token", async () => {
    const body = JSON.stringify({ providers: [] });
    expect((await call(port, "POST", "/api/relay/snapshot", {}, body)).status).toBe(401);
    expect(
      (await call(port, "POST", "/api/relay/snapshot", { Authorization: `Bearer ${DEVICE}` }, body))
        .status,
    ).toBe(401);
  });

  it("rejects malformed and oversized pushes", async () => {
    expect((await call(port, "POST", "/api/relay/snapshot", pushAuth, "not json")).status).toBe(400);
    expect((await call(port, "POST", "/api/relay/snapshot", pushAuth, "{}")).status).toBe(400);
    const big = JSON.stringify({ providers: [], pad: "x".repeat(70 * 1024) });
    expect((await call(port, "POST", "/api/relay/snapshot", pushAuth, big)).status).toBe(413);
  });

  it("serves the pushed payload to the device token only", async () => {
    const payload = { generated_at: "2026-10-11T00:00:00Z", providers: [{ provider: "codex" }] };
    expect(
      (await call(port, "POST", "/api/relay/snapshot", pushAuth, JSON.stringify(payload))).status,
    ).toBe(200);
    expect((await call(port, "GET", "/api/ai-usage")).status).toBe(401);
    const r = await call(port, "GET", "/api/ai-usage?window=today", auth);
    expect(r.status).toBe(200);
    expect(r.json.providers).toEqual(payload.providers);
    expect((r.json.relay as { age_seconds: number }).age_seconds).toBeLessThan(5);
    expect((await call(port, "GET", "/ready")).status).toBe(200);
  });

  it("does not accept GET on the push route", async () => {
    expect((await call(port, "GET", "/api/relay/snapshot", pushAuth)).status).toBe(405);
  });
});
