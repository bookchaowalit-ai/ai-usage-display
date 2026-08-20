#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";

const home = homedir();
const outputPath =
  process.env.CODEX_QUOTA_OUTPUT_PATH ||
  join(home, ".local", "share", "ai-usage-display", "codex-quota.json");
const timeoutMs = Number.parseInt(process.env.CODEX_QUOTA_TIMEOUT_MS || "30000", 10);

function executable(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findCodexCli() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  for (const root of [join(home, ".vscode-insiders", "extensions"), join(home, ".vscode", "extensions")]) {
    if (!existsSync(root)) continue;
    const entries = readdirSync(root)
      .filter((entry) => entry.startsWith("openai.chatgpt-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const entry of entries) {
      const candidate = join(root, entry, "bin", "linux-x86_64", "codex");
      if (executable(candidate)) return candidate;
    }
  }
  for (const directory of (process.env.PATH || "").split(":")) {
    const candidate = join(directory, "codex");
    if (executable(candidate)) return candidate;
  }
  return null;
}

function runRateLimits(cliPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb" },
    });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    let stderr = "";
    const timeout = setTimeout(() => finish(new Error("Codex CLI timed out")), timeoutMs);

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

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled && code !== 0) {
        finish(new Error(`Codex CLI exited (${signal || code || "unknown"})`));
      }
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 0 && message.result) {
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 6 });
      } else if (message.id === 6) {
        if (message.error) {
          finish(new Error(message.error.message || "Codex quota request failed"));
        } else {
          finish(null, message.result);
        }
      }
    });
  });
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function dateValue(value) {
  const number = numberValue(value);
  const date = new Date(number === null ? value : number * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function durationLabel(duration, fallback) {
  if (duration === 300) return "5h";
  if (duration === 10080) return "week";
  if (duration && duration % 1440 === 0) return `${duration / 1440}d`;
  if (duration && duration % 60 === 0) return `${duration / 60}h`;
  return fallback;
}

function parseQuota(body) {
  const buckets = [];
  if (body?.rateLimitsByLimitId && typeof body.rateLimitsByLimitId === "object") {
    buckets.push(...Object.entries(body.rateLimitsByLimitId));
  }
  if (!buckets.length && body?.rateLimits && typeof body.rateLimits === "object") {
    buckets.push([String(body.rateLimits.limitId || "codex"), body.rateLimits]);
  }
  const windows = [];
  let plan;
  for (const [limitId, bucket] of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    if (!plan && typeof bucket.planType === "string") plan = bucket.planType;
    for (const slot of ["primary", "secondary"]) {
      const raw = bucket[slot];
      const used = numberValue(raw?.usedPercent);
      if (!raw || typeof raw !== "object" || used === null) continue;
      const duration = numberValue(raw.windowDurationMins);
      windows.push({
        id: `${limitId}.${slot}`,
        label: durationLabel(duration, limitId),
        used_percent: Math.min(100, used),
        remaining_percent: Math.max(0, 100 - Math.min(100, used)),
        resets_at: dateValue(raw.resetsAt),
        ...(duration !== null ? { duration_minutes: duration } : {}),
      });
    }
  }
  if (!windows.length) throw new Error("Codex returned no quota windows");
  return { status: "ok", plan: plan || "codex", updated_at: new Date().toISOString(), message: "source:codex-host-app-server", windows };
}

const cliPath = findCodexCli();
if (!cliPath) {
  console.error("Codex CLI not found");
  process.exit(1);
}

try {
  const snapshot = parseQuota(await runRateLimits(cliPath));
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, outputPath);
  console.log(`Codex quota exported: ${snapshot.windows.length} windows -> ${outputPath}`);
} catch (error) {
  console.error(`Codex quota export failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
