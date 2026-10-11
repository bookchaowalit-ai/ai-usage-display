import type { IncomingMessage, ServerResponse } from "node:http";
import { extractDeviceToken, isAuthorized, tokensMatch } from "../lib/auth.js";
import { MAX_FIRMWARE_BYTES, type FirmwareStore } from "../lib/firmware-store.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBinary(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value ?? "").trim();
}

export function createFirmwareManifestHandler(opts: { deviceToken: string; store: FirmwareStore }) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!isAuthorized(req.headers, opts.deviceToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const manifest = opts.store.manifest();
    if (!manifest) {
      sendJson(res, 404, { error: "no_firmware" });
      return;
    }
    sendJson(res, 200, manifest);
  };
}

export function createFirmwareBinaryHandler(opts: { deviceToken: string; store: FirmwareStore }) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!isAuthorized(req.headers, opts.deviceToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const image = opts.store.binary();
    if (!image) {
      sendJson(res, 404, { error: "no_firmware" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Length": image.length,
    });
    res.end(req.method === "HEAD" ? undefined : image);
  };
}

/** Publishes a new OTA image; uses the relay push token, never the device token. */
export function createFirmwarePublishHandler(opts: { pushToken: string; store: FirmwareStore }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!tokensMatch(opts.pushToken, extractDeviceToken(req.headers))) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let image: Buffer | null;
    try {
      image = await readBinary(req, MAX_FIRMWARE_BYTES);
    } catch {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (image === null) {
      sendJson(res, 413, { error: "payload_too_large" });
      return;
    }
    try {
      const manifest = opts.store.publish(
        header(req, "x-firmware-version"),
        header(req, "x-firmware-md5"),
        image,
      );
      sendJson(res, 200, manifest);
    } catch (err) {
      sendJson(res, 400, { error: "bad_request", message: err instanceof Error ? err.message : "invalid" });
    }
  };
}
