import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthorized } from "../lib/auth.js";
import type { UsageService } from "../lib/usage-service.js";
import { parseWindow } from "../lib/window.js";

function readUrl(req: IncomingMessage): URL {
  // Fixed base: never build a URL from the client-controlled Host header.
  return new URL(req.url ?? "/", "http://localhost");
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createAiUsageHandler(opts: {
  deviceToken: string;
  usageService: UsageService;
}) {
  return async function handleAiUsage(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (!opts.deviceToken) {
      sendJson(res, 503, {
        error: "misconfigured",
        message: "DEVICE_TOKEN is not set on the server",
      });
      return;
    }

    if (!isAuthorized(req.headers, opts.deviceToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const url = readUrl(req);
    let window;
    try {
      window = parseWindow(url.searchParams.get("window"));
    } catch (err) {
      sendJson(res, 400, {
        error: "bad_request",
        message: err instanceof Error ? err.message : "invalid window",
      });
      return;
    }

    try {
      const data = await opts.usageService.getUsage(window);
      // Strip internal messages for device if desired? Keep them — useful for OFFLINE/unavailable UI.
      sendJson(res, 200, data);
    } catch (err) {
      sendJson(res, 500, {
        error: "internal_error",
        message: err instanceof Error ? err.message : "unknown error",
      });
    }
  };
}

export function createHealthHandler() {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    sendJson(res, 200, { ok: true, service: "ai-usage-display" });
  };
}

/**
 * Readiness is separate from liveness. It uses the same cached aggregation as
 * the display and reports stale or unavailable quota bridges without exposing
 * provider credentials.
 */
export function createReadyHandler(opts: {
  deviceToken: string;
  usageService: UsageService;
}) {
  return async function handleReady(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (!opts.deviceToken) {
      sendJson(res, 503, {
        ok: false,
        ready: false,
        error: "misconfigured",
        message: "DEVICE_TOKEN is not set on the server",
      });
      return;
    }

    try {
      const usage = await opts.usageService.getUsage("today");
      const providers = usage.providers.map((provider) => ({
        provider: provider.provider,
        usage_status: provider.status,
        quota_status: provider.quota?.status ?? "unavailable",
        quota_updated_at: provider.quota?.updated_at ?? null,
        message: provider.quota?.message ?? provider.message ?? null,
      }));
      const ready = providers.every(
        (provider) => provider.quota_status === "ok",
      );
      sendJson(res, ready ? 200 : 503, {
        ok: ready,
        ready,
        service: "ai-usage-display",
        generated_at: usage.generated_at,
        cache: usage.cache,
        providers,
      });
    } catch (error) {
      sendJson(res, 503, {
        ok: false,
        ready: false,
        error: "not_ready",
        message: error instanceof Error ? error.message : "usage aggregation failed",
      });
    }
  };
}
