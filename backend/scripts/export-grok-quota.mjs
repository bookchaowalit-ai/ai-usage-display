#!/usr/bin/env node

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";

const home = homedir();
const outputPath =
  process.env.GROK_QUOTA_OUTPUT_PATH ||
  join(home, ".local", "share", "ai-usage-display", "grok-quota.json");
const timeoutMs = Number.parseInt(process.env.GROK_QUOTA_TIMEOUT_MS || "30000", 10);

function findGrokCli() {
  if (process.env.GROK_CLI_PATH) return process.env.GROK_CLI_PATH;
  const candidates = [join(home, ".grok", "bin", "grok")];
  for (const directory of (process.env.PATH || "").split(":")) candidates.push(join(directory, "grok"));
  return candidates.find((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

function runBilling(cliPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, ["agent", "--no-leader", "stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb" },
    });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Grok CLI timed out")), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }
    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled && code !== 0) finish(new Error(`Grok CLI exited (${signal || code || "unknown"})`));
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1 && message.result) {
        send({ jsonrpc: "2.0", id: 2, method: "_x.ai/billing", params: {} });
      } else if (message.id === 2) {
        if (message.error) finish(new Error(message.error.message || "Grok billing request failed"));
        else finish(null, message.result);
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { terminal: false } },
    });
  });
}

function dateValue(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseQuota(body) {
  const root = body && typeof body === "object" ? body : {};
  const config = root.config && typeof root.config === "object" ? root.config : root;
  const used = Number(config.creditUsagePercent);
  if (!Number.isFinite(used)) throw new Error("Grok returned no weekly quota");
  const period = config.currentPeriod && typeof config.currentPeriod === "object" ? config.currentPeriod : {};
  const window = {
    id: "weekly",
    label: "week",
    used_percent: Math.max(0, Math.min(100, used)),
    remaining_percent: Math.max(0, Math.min(100, 100 - used)),
    resets_at: dateValue(period.end ?? config.billingPeriodEnd),
    duration_minutes: 10080,
  };
  return {
    status: "ok",
    ...(typeof root.subscription_tier === "string" ? { plan: root.subscription_tier } : { plan: "X Premium+" }),
    updated_at: new Date().toISOString(),
    message: "source:grok-host-billing",
    primary: window,
    windows: [window],
  };
}

const cliPath = findGrokCli();
if (!cliPath) {
  console.error("Grok CLI not found");
  process.exit(1);
}

try {
  const snapshot = parseQuota(await runBilling(cliPath));
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, outputPath);
  console.log(`Grok quota exported: 1 window -> ${outputPath}`);
} catch (error) {
  console.error(`Grok quota export failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
