import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

const DEVICE = "fw-device-token";
const PUSH = "fw-push-token";

function call(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: Buffer,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

describe("firmware OTA routes (relay mode)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
  const server = createServer(
    loadConfig({
      DEVICE_TOKEN: DEVICE,
      RELAY_MODE: "server",
      RELAY_PUSH_TOKEN: PUSH,
      FIRMWARE_DIR: dir,
      SUBSCRIPTION_USAGE_ENABLED: "false",
    }),
  );
  let port = 0;
  const device = { Authorization: `Bearer ${DEVICE}` };
  const image = Buffer.concat([Buffer.from([0xe9]), Buffer.alloc(4096, 7)]);

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const publish = (headers: Record<string, string>, body: Buffer) =>
    call(port, "POST", "/api/firmware", { "Content-Type": "application/octet-stream", ...headers }, body);

  it("has no firmware before the first publish", async () => {
    expect((await call(port, "GET", "/api/firmware/manifest", device)).status).toBe(404);
  });

  it("only accepts publishes with the push token", async () => {
    const h = { "X-Firmware-Version": "1.0.0", "X-Firmware-MD5": md5(image) };
    expect((await publish(h, image)).status).toBe(401);
    expect((await publish({ ...h, Authorization: `Bearer ${DEVICE}` }, image)).status).toBe(401);
  });

  it("rejects a wrong MD5, a non-ESP32 image and a bad version", async () => {
    const auth = { Authorization: `Bearer ${PUSH}` };
    expect((await publish({ ...auth, "X-Firmware-Version": "1", "X-Firmware-MD5": "0".repeat(32) }, image)).status).toBe(400);
    const notEsp = Buffer.alloc(100, 1);
    expect((await publish({ ...auth, "X-Firmware-Version": "1", "X-Firmware-MD5": md5(notEsp) }, notEsp)).status).toBe(400);
    expect((await publish({ ...auth, "X-Firmware-Version": "../x", "X-Firmware-MD5": md5(image) }, image)).status).toBe(400);
  });

  it("publishes and serves the image to the device token", async () => {
    const r = await publish(
      { Authorization: `Bearer ${PUSH}`, "X-Firmware-Version": "2026.10.11.1", "X-Firmware-MD5": md5(image) },
      image,
    );
    expect(r.status).toBe(200);
    const manifest = await call(port, "GET", "/api/firmware/manifest", device);
    expect(manifest.status).toBe(200);
    expect(JSON.parse(manifest.body.toString())).toMatchObject({
      version: "2026.10.11.1",
      size: image.length,
      md5: md5(image),
    });
    expect((await call(port, "GET", "/api/firmware/latest.bin")).status).toBe(401);
    const bin = await call(port, "GET", "/api/firmware/latest.bin", device);
    expect(bin.status).toBe(200);
    expect(bin.body.equals(image)).toBe(true);
  });
});
