import { appConfig } from "./config.js";
import { createServer } from "./server.js";

function main(): void {
  if (!appConfig.deviceToken) {
    console.error(
      "[ai-usage-display] DEVICE_TOKEN is required. Copy .env.example to .env and set a long random token.",
    );
    process.exit(1);
  }
  if (appConfig.relay.enabled && !appConfig.relay.pushToken) {
    console.error("[ai-usage-display] RELAY_MODE=server requires RELAY_PUSH_TOKEN.");
    process.exit(1);
  }

  const server = createServer(appConfig);
  server.listen(appConfig.port, appConfig.host, () => {
    console.log(
      `[ai-usage-display] listening on http://${appConfig.host}:${appConfig.port}`,
    );
    console.log(
      appConfig.relay.enabled
        ? `[ai-usage-display] relay mode: serving pushed snapshots (max age ${appConfig.relay.maxAgeSeconds}s)`
        : `[ai-usage-display] usage source=${appConfig.usageSource} cache_ttl=${appConfig.cacheTtlSeconds}s`,
    );
    console.log(
      "[ai-usage-display] GET /api/ai-usage?window=today  (Authorization: Bearer <DEVICE_TOKEN>)",
    );
  });
}

main();
