#!/usr/bin/env node

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const agyPath = process.env.AGY_CLI_PATH || join(homedir(), ".local", "bin", "agy");
const outputPath =
  process.env.GEMINI_QUOTA_OUTPUT_PATH ||
  join(homedir(), ".local", "share", "ai-usage-display", "gemini-quota.json");
const timeoutMs = Number.parseInt(process.env.GEMINI_QUOTA_TIMEOUT_MS || "30000", 10);

const result = spawnSync(agyPath, ["-p", "/usage", "--output-format", "text"], {
  encoding: "utf8",
  timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
  maxBuffer: 1024 * 1024,
  env: {
    ...process.env,
    TERM: "dumb",
  },
});

if (result.error) {
  console.error(`agy failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`agy exited with status ${result.status ?? "unknown"}`);
  process.exit(result.status && result.status > 0 ? result.status : 1);
}

const windows = [];
for (const rawLine of result.stdout.split(/\r?\n/)) {
  const columns = rawLine.trim().split(/\t+/);
  if (columns.length < 4) continue;

  const group = columns[0].toLowerCase();
  const windowName = columns[1].toLowerCase();
  if (!group.includes("gemini")) continue;

  const remaining = Number.parseFloat(columns[2].replace("%", ""));
  const resetsAt = columns[3].trim();
  if (!Number.isFinite(remaining) || !/^\d{4}-\d{2}-\d{2}t/i.test(resetsAt)) continue;

  const weekly = windowName.includes("weekly") || windowName.includes("week");
  const fiveHour = windowName.includes("five") || windowName.includes("5 hour");
  if (!weekly && !fiveHour) continue;

  windows.push({
    id: weekly ? "weekly" : "five_hour",
    label: weekly ? "week" : "5h",
    used_percent: Math.max(0, Math.min(100, 100 - remaining)),
    remaining_percent: Math.max(0, Math.min(100, remaining)),
    resets_at: resetsAt,
    duration_minutes: weekly ? 10080 : 300,
  });
}

if (windows.length === 0) {
  console.error("agy returned no Gemini quota windows");
  process.exit(1);
}

const snapshot = {
  status: "ok",
  plan: "antigravity",
  updated_at: new Date().toISOString(),
  message: "source:antigravity-cli",
  windows,
};

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
const tempPath = `${outputPath}.tmp-${process.pid}`;
writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
renameSync(tempPath, outputPath);
console.log(`Gemini quota exported: ${windows.length} windows -> ${outputPath}`);
