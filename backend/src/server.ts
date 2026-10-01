import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import { AnthropicUsageAdapter } from "./adapters/anthropic.js";
import { OpenAIUsageAdapter } from "./adapters/openai.js";
import { SoloEmpireAdapter } from "./adapters/solo-empire.js";
import { XaiUsageAdapter } from "./adapters/xai.js";
import { KimiUsageAdapter } from "./adapters/kimi.js";
import { GeminiUsageAdapter } from "./adapters/gemini.js";
import { LocalSubscriptionQuotaAdapter } from "./adapters/subscription-quotas.js";
import { UsageService } from "./lib/usage-service.js";
import {
  createAiUsageHandler,
  createHealthHandler,
  createReadyHandler,
} from "./routes/ai-usage.js";

/**
 * Access level of a route:
 * - "public": no credentials (liveness/readiness probes; aggregate status only).
 * - "device": the ESP32 device token (`Authorization: Bearer` or
 *   `X-Device-Token`), checked inside the handler.
 */
export type RouteAccess = "public" | "device";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface RouteDef {
  name: string;
  paths: readonly string[];
  methods: readonly string[];
  access: RouteAccess;
  handler: Handler;
}

/**
 * The server's whole route table. tests/route-access.test.ts walks it, so a
 * new route must declare its access level and methods here.
 */
export function buildRoutes(handlers: {
  usage: Handler;
  health: Handler;
  ready: Handler;
}): RouteDef[] {
  return [
    {
      name: "health",
      paths: ["/health", "/api/health"],
      methods: ["GET", "HEAD"],
      access: "public",
      handler: handlers.health,
    },
    {
      name: "ready",
      paths: ["/ready", "/api/ready"],
      methods: ["GET"],
      access: "public",
      handler: handlers.ready,
    },
    {
      name: "ai-usage",
      paths: ["/api/ai-usage"],
      methods: ["GET"],
      access: "device",
      handler: handlers.usage,
    },
  ];
}

function sendError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

export function createServer(config: AppConfig): http.Server {
  const adapters = {
    claude: new AnthropicUsageAdapter(config.anthropic),
    codex: new OpenAIUsageAdapter(config.openai),
    grok: new XaiUsageAdapter(config.xai),
    kimi: new KimiUsageAdapter(),
    gemini: new GeminiUsageAdapter(),
  };
  const soloEmpire = new SoloEmpireAdapter(config.soloEmpire);
  const subscriptionQuotas = new LocalSubscriptionQuotaAdapter(config.subscriptionUsage);
  const usageService = new UsageService(
    {
      cacheTtlSeconds: config.cacheTtlSeconds,
      staleMaxAgeSeconds: config.staleMaxAgeSeconds,
      usageSource: config.usageSource,
    },
    adapters,
    soloEmpire,
    subscriptionQuotas,
  );

  const routes = buildRoutes({
    usage: createAiUsageHandler({ deviceToken: config.deviceToken, usageService }),
    health: createHealthHandler(),
    ready: createReadyHandler({ deviceToken: config.deviceToken, usageService }),
  });

  return http.createServer((req, res) => {
    // Parse against a fixed base: only the path matters, and a client-supplied
    // Host header such as "bad host" made `new URL` throw inside the request
    // listener, which is an uncaught exception that kills the process.
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendError(res, 400, "bad_request");
      return;
    }
    const path = pathname.replace(/\/+$/, "") || "/";

    const route = routes.find((r) => r.paths.includes(path));
    if (!route) {
      sendError(res, 404, "not_found");
      return;
    }
    // Every route is read-only; nothing on this server changes state.
    if (!route.methods.includes(req.method ?? "")) {
      res.setHeader("Allow", route.methods.join(", "));
      sendError(res, 405, "method_not_allowed");
      return;
    }
    void route.handler(req, res);
  });
}
