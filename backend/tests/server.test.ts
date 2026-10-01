import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(data);
    });
  });
}

describe("server", () => {
  const server = createServer(
    loadConfig({ DEVICE_TOKEN: "test-token", SUBSCRIPTION_USAGE_ENABLED: "false" }),
  );
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("survives a malformed Host header (used to throw inside the request handler)", async () => {
    const res = await rawRequest(
      port,
      "GET /health HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n",
    );
    expect(res).toMatch(/^HTTP\/1\.1 200/);

    const again = await rawRequest(
      port,
      "GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    expect(again).toMatch(/^HTTP\/1\.1 200/);
  });

  it("returns 404 JSON for unknown paths", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("requires the device token on /api/ai-usage", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/ai-usage`);
    expect(res.status).toBe(401);
  });
});
