#!/usr/bin/env node
// Host-side relay pusher: reads the local backend's usage payload and pushes
// it to a hosted backend running with RELAY_MODE=server. Only quota
// percentages, reset times and status text leave the host; provider
// credentials never do. Tokens are never printed.
//
//   node scripts/relay-push.mjs            # loop every RELAY_PUSH_INTERVAL_SECONDS
//   node scripts/relay-push.mjs --once     # push once and exit
import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const env = (name, fallback = "") => (process.env[name] ?? fallback).trim();
const localUrl = env("RELAY_LOCAL_URL", `http://127.0.0.1:${env("PORT", "8787")}`).replace(/\/+$/, "");
const relayUrl = env("RELAY_URL").replace(/\/+$/, "");
const deviceToken = env("DEVICE_TOKEN");
const pushToken = env("RELAY_PUSH_TOKEN");
const intervalSeconds = Math.max(15, Number.parseInt(env("RELAY_PUSH_INTERVAL_SECONDS", "60"), 10) || 60);

if (!relayUrl || !deviceToken || !pushToken) {
  console.error("[relay-push] RELAY_URL, DEVICE_TOKEN and RELAY_PUSH_TOKEN are required");
  process.exit(1);
}

async function pushOnce() {
  const local = await fetch(`${localUrl}/api/ai-usage?window=today`, {
    headers: { Authorization: `Bearer ${deviceToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!local.ok) throw new Error(`local backend HTTP ${local.status}`);
  const body = await local.text();
  const remote = await fetch(`${relayUrl}/api/relay/snapshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pushToken}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!remote.ok) throw new Error(`relay HTTP ${remote.status}`);
  return Buffer.byteLength(body);
}

async function run() {
  try {
    const bytes = await pushOnce();
    console.log(JSON.stringify({ relay_push: "ok", bytes }));
    return true;
  } catch (error) {
    console.error(JSON.stringify({ relay_push: "error", message: String(error?.message ?? error) }));
    return false;
  }
}

if (process.argv.includes("--once")) {
  process.exit((await run()) ? 0 : 1);
}
for (;;) {
  await run();
  await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
}
