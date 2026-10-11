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
import { RelayStore } from "./lib/relay-store.js";
import { FirmwareStore } from "./lib/firmware-store.js";
import {
  createFirmwareBinaryHandler,
  createFirmwareManifestHandler,
  createFirmwarePublishHandler,
} from "./routes/firmware.js";
import {
  createRelayPushHandler,
  createRelayReadyHandler,
  createRelayUsageHandler,
} from "./routes/relay.js";
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
 * - "relay-push": the host pusher's RELAY_PUSH_TOKEN; exists only in relay mode.
 */
export type RouteAccess = "public" | "device" | "relay-push";

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
  firmwareManifest: Handler;
  firmwareBinary: Handler;
  relayPush?: Handler;
  firmwarePublish?: Handler;
}): RouteDef[] {
  const routes: RouteDef[] = [
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
    {
      name: "firmware-manifest",
      paths: ["/api/firmware/manifest"],
      methods: ["GET"],
      access: "device",
      handler: handlers.firmwareManifest,
    },
    {
      name: "firmware-binary",
      paths: ["/api/firmware/latest.bin"],
      methods: ["GET", "HEAD"],
      access: "device",
      handler: handlers.firmwareBinary,
    },
  ];
  if (handlers.relayPush) {
    // The only state-changing route; it only replaces the in-memory snapshot.
    routes.push({
      name: "relay-push",
      paths: ["/api/relay/snapshot"],
      methods: ["POST"],
      access: "relay-push",
      handler: handlers.relayPush,
    });
  }
  if (handlers.firmwarePublish) {
    routes.push({
      name: "firmware-publish",
      paths: ["/api/firmware"],
      methods: ["POST"],
      access: "relay-push",
      handler: handlers.firmwarePublish,
    });
  }
  return routes;
}

function sendError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function firmwareHandlers(config: AppConfig, firmware: FirmwareStore) {
  return {
    firmwareManifest: createFirmwareManifestHandler({ deviceToken: config.deviceToken, store: firmware }),
    firmwareBinary: createFirmwareBinaryHandler({ deviceToken: config.deviceToken, store: firmware }),
  };
}

function relayRoutes(config: AppConfig): RouteDef[] {
  const store = new RelayStore();
  const firmware = new FirmwareStore(config.firmwareDir);
  const maxAgeSeconds = config.relay.maxAgeSeconds;
  return buildRoutes({
    usage: createRelayUsageHandler({ deviceToken: config.deviceToken, store, maxAgeSeconds }),
    health: createHealthHandler(),
    ready: createRelayReadyHandler({ store, maxAgeSeconds }),
    ...firmwareHandlers(config, firmware),
    relayPush: createRelayPushHandler({ pushToken: config.relay.pushToken, store }),
    firmwarePublish: createFirmwarePublishHandler({ pushToken: config.relay.pushToken, store: firmware }),
  });
}

function probeRoutes(config: AppConfig): RouteDef[] {
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

  return buildRoutes({
    usage: createAiUsageHandler({ deviceToken: config.deviceToken, usageService }),
    health: createHealthHandler(),
    ready: createReadyHandler({ deviceToken: config.deviceToken, usageService }),
    ...firmwareHandlers(config, new FirmwareStore(config.firmwareDir)),
  });
}

export function createServer(config: AppConfig): http.Server {
  const routes = config.relay.enabled ? relayRoutes(config) : probeRoutes(config);

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
    // Only the relay-mode push and firmware publish routes change state.
    if (!route.methods.includes(req.method ?? "")) {
      res.setHeader("Allow", route.methods.join(", "));
      sendError(res, 405, "method_not_allowed");
      return;
    }
    void route.handler(req, res);
  });
}
