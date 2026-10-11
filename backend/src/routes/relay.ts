import type { IncomingMessage, ServerResponse } from "node:http";
import { extractDeviceToken, isAuthorized, tokensMatch } from "../lib/auth.js";
import type { RelayStore } from "../lib/relay-store.js";

const MAX_PUSH_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
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
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Accepts the usage payload from the host pusher. The payload carries only
 * quota percentages, reset times and status text; provider credentials stay on
 * the host.
 */
export function createRelayPushHandler(opts: { pushToken: string; store: RelayStore }) {
  return async function handleRelayPush(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!tokensMatch(opts.pushToken, extractDeviceToken(req.headers))) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let raw: string | null;
    try {
      raw = await readBody(req, MAX_PUSH_BYTES);
    } catch {
      sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (raw === null) {
      sendJson(res, 413, { error: "payload_too_large" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "bad_request", message: "invalid JSON" });
      return;
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Array.isArray((body as Record<string, unknown>).providers)
    ) {
      sendJson(res, 400, { error: "bad_request", message: "providers array required" });
      return;
    }
    opts.store.set(body as Record<string, unknown>);
    sendJson(res, 200, { ok: true });
  };
}

/** Serves the last pushed payload to the device while it is fresh. */
export function createRelayUsageHandler(opts: {
  deviceToken: string;
  store: RelayStore;
  maxAgeSeconds: number;
}) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!opts.deviceToken) {
      sendJson(res, 503, { error: "misconfigured", message: "DEVICE_TOKEN is not set on the server" });
      return;
    }
    if (!isAuthorized(req.headers, opts.deviceToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const snapshot = opts.store.get();
    const age = opts.store.ageSeconds();
    if (!snapshot || age === null) {
      sendJson(res, 503, { error: "no_snapshot", message: "relay has not received usage yet" });
      return;
    }
    if (age > opts.maxAgeSeconds) {
      sendJson(res, 503, { error: "snapshot_stale", message: `last push ${age}s ago` });
      return;
    }
    sendJson(res, 200, { ...snapshot.payload, relay: { age_seconds: age } });
  };
}

export function createRelayReadyHandler(opts: { store: RelayStore; maxAgeSeconds: number }) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    const age = opts.store.ageSeconds();
    const ready = age !== null && age <= opts.maxAgeSeconds;
    sendJson(res, ready ? 200 : 503, { ok: ready, ready, mode: "relay", snapshot_age_seconds: age });
  };
}
