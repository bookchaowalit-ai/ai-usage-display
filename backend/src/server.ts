import http from "node:http";
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

  const handleUsage = createAiUsageHandler({
    deviceToken: config.deviceToken,
    usageService,
  });
  const handleHealth = createHealthHandler();
  const handleReady = createReadyHandler({
    deviceToken: config.deviceToken,
    usageService,
  });

  return http.createServer((req, res) => {
    // Parse against a fixed base: only the path matters, and a client-supplied
    // Host header such as "bad host" made `new URL` throw inside the request
    // listener, which is an uncaught exception that kills the process.
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    const path = pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" || path === "/api/health") {
      handleHealth(req, res);
      return;
    }

    if (path === "/ready" || path === "/api/ready") {
      void handleReady(req, res);
      return;
    }

    if (path === "/api/ai-usage") {
      void handleUsage(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
