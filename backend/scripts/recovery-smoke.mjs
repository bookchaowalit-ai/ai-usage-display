import fs from "node:fs";
import path from "node:path";

const backendDir = path.resolve(new URL("..", import.meta.url).pathname);
const envPath = path.join(backendDir, ".env");

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    values[key] = value;
  }
  return values;
}

const fileEnv = readEnvFile(envPath);
const env = { ...fileEnv, ...process.env };
const port = Number.parseInt(env.PORT || "3000", 10);
const baseUrl = (env.RECOVERY_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
const deviceToken = env.DEVICE_TOKEN || "";

if (!deviceToken) {
  console.error("recovery smoke: DEVICE_TOKEN is missing in backend/.env");
  process.exit(2);
}

async function getJson(route, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { headers });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The HTTP status is enough to diagnose a dead or non-HTTP service.
  }
  return { response, body };
}

try {
  const health = await getJson("/health");
  if (!health.response.ok || health.body?.ok !== true) {
    throw new Error(`health failed with HTTP ${health.response.status}`);
  }

  const ready = await getJson("/ready");
  const readyProviders = Array.isArray(ready.body?.providers) ? ready.body.providers : [];
  const badProviders = readyProviders.filter((provider) => provider.quota_status !== "ok");
  if (!ready.response.ok || ready.body?.ready !== true || badProviders.length > 0) {
    const summary = readyProviders
      .map((provider) => `${provider.provider}:${provider.quota_status}`)
      .join(", ");
    throw new Error(`readiness failed with HTTP ${ready.response.status} (${summary || "no providers"})`);
  }

  const usage = await getJson("/api/ai-usage?window=today", {
    Authorization: `Bearer ${deviceToken}`,
  });
  const providers = Array.isArray(usage.body?.providers) ? usage.body.providers : [];
  if (!usage.response.ok || providers.length !== 5) {
    throw new Error(`usage failed with HTTP ${usage.response.status} (${providers.length} providers)`);
  }

  console.log(`recovery smoke: PASS (${baseUrl}, ${providers.length} providers, ready)`);
} catch (error) {
  console.error(`recovery smoke: FAIL (${error instanceof Error ? error.message : "unknown error"})`);
  process.exitCode = 1;
}
