#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const home = homedir();
const outputPath =
  process.env.CLAUDE_QUOTA_OUTPUT_PATH ||
  join(home, ".local", "share", "ai-usage-display", "claude-quota.json");
const timeoutMs = Number.parseInt(process.env.CLAUDE_QUOTA_TIMEOUT_MS || "30000", 10);

function findClaudeCli() {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  const candidates = [];
  for (const root of [
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".vscode", "extensions"),
  ]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("anthropic.claude-code-")) continue;
      const candidate = join(
        root,
        entry,
        "resources",
        "native-binary",
        "claude",
      );
      try {
        if (statSync(candidate).isFile()) candidates.push(candidate);
      } catch {
        // Ignore incomplete extension directories.
      }
    }
  }
  return candidates.sort().at(-1) || "claude";
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function zonedCivilTimeToUtc(year, month, day, hour, minute, timeZone) {
  const civilAsUtc = Date.UTC(year, month, day, hour, minute, 0);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(civilAsUtc));
    const values = new Map(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number.parseInt(part.value, 10)]),
    );
    const localAsUtc = Date.UTC(
      values.get("year") || year,
      (values.get("month") || month + 1) - 1,
      values.get("day") || day,
      values.get("hour") ?? hour,
      values.get("minute") ?? minute,
      values.get("second") ?? 0,
    );
    return new Date(civilAsUtc - (localAsUtc - civilAsUtc));
  } catch {
    return null;
  }
}

function parseReset(resetText, timeZone, now) {
  if (!resetText) return null;
  const match = resetText.trim().match(
    /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i,
  );
  if (!match) return null;
  const months = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const month = months.indexOf(match[1].slice(0, 3).toLowerCase());
  const day = Number.parseInt(match[2], 10);
  let hour = Number.parseInt(match[3], 10);
  const minute = match[4] ? Number.parseInt(match[4], 10) : 0;
  if (
    month < 0 ||
    day < 1 ||
    day > daysInMonth(now.getUTCFullYear(), month) ||
    hour < 1 ||
    hour > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  if (match[5].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (match[5].toLowerCase() === "am" && hour === 12) hour = 0;

  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let year = now.getUTCFullYear();
  let candidate = zonedCivilTimeToUtc(year, month, day, hour, minute, zone);
  if (!candidate) return null;
  if (candidate.getTime() < now.getTime() - 12 * 60 * 60 * 1000) {
    year += 1;
    candidate = zonedCivilTimeToUtc(year, month, day, hour, minute, zone);
  }
  return candidate ? candidate.toISOString() : null;
}

function parseLine(line, now) {
  if (!line) return null;
  const match = line.match(
    /:\s*([\d.]+)%\s*used(?:\s*[·•]\s*resets\s+(.+?)(?:\s+\(([^)]+)\))?)?\s*$/i,
  );
  if (!match) return null;
  const used = Number.parseFloat(match[1]);
  if (!Number.isFinite(used)) return null;
  return {
    used_percent: Math.max(0, Math.min(100, used)),
    remaining_percent: Math.max(0, Math.min(100, 100 - used)),
    resets_at: parseReset(match[2], match[3], now),
  };
}

const cliPath = findClaudeCli();
const result = spawnSync(
  cliPath,
  ["-p", "--output-format", "json", "--no-session-persistence", "/usage"],
  {
    encoding: "utf8",
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, TERM: "dumb" },
  },
);

if (result.error) {
  console.error("Claude CLI failed: " + result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error("Claude CLI exited with status " + (result.status ?? "unknown"));
  process.exit(result.status && result.status > 0 ? result.status : 1);
}

// The CLI is expected to emit a single JSON object on stdout, but some
// configurations (e.g. an MCP server logging to stdout) can interleave
// extra non-JSON lines around it. Parsing `result.stdout` as a whole then
// silently falling back to the raw multi-line text made the "Current
// session:" / "Current week:" line lookups below both match the same
// (unparsed, single-line) JSON blob, corrupting both quota windows at
// once. Instead, find the line that is itself a complete JSON object and
// parse only that.
let text = result.stdout;
const jsonLine = result.stdout
  .split(/\r?\n/)
  .find((line) => line.trim().startsWith("{") && line.trim().endsWith("}"));
if (jsonLine) {
  try {
    const parsed = JSON.parse(jsonLine);
    if (typeof parsed.result === "string") text = parsed.result;
  } catch {
    // Plain text output is also accepted.
  }
}

const now = new Date();
const lines = text.split(/\r?\n/);
const session = parseLine(
  lines.find((line) => /Current session:/i.test(line)),
  now,
);
const week = parseLine(
  lines.find((line) => /Current week[^:]*:/i.test(line)),
  now,
);
const windows = [];
if (session) {
  windows.push({
    id: "five_hour",
    label: "5h",
    ...session,
    duration_minutes: 300,
  });
}
if (week) {
  windows.push({
    id: "seven_day",
    label: "week",
    ...week,
    duration_minutes: 10080,
  });
}
if (windows.length === 0) {
  console.error("Claude CLI returned no quota windows");
  process.exit(1);
}

const snapshot = {
  status: "ok",
  plan: "claude",
  updated_at: now.toISOString(),
  message: "source:claude-cli-host",
  windows,
};
mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
const tempPath = outputPath + ".tmp-" + process.pid;
writeFileSync(tempPath, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
renameSync(tempPath, outputPath);
console.log("Claude quota exported: " + windows.length + " windows -> " + outputPath);
