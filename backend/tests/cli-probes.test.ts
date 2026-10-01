import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  probeClaudeQuota,
  probeCodexQuota,
  probeGrokQuota,
} from "../src/adapters/subscription-quotas.js";

// Fake provider CLIs: small Node scripts on disk, spawned exactly like the
// real binaries. No network, no real credentials.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-cli-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const now = new Date("2026-08-08T07:00:00.000Z");

function fakeCli(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}

// Line-oriented JSON-RPC responder. `reply` maps a request to a response
// object (or null for no reply).
function jsonRpcCli(name: string, reply: string, prelude = ""): string {
  return fakeCli(
    name,
    `${prelude}
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const out = (${reply})(msg);
  if (out) process.stdout.write(JSON.stringify(out) + "\\n");
});`,
  );
}

const codexReply = `(msg) => {
  if (msg.method === "initialize") return { id: msg.id, result: {} };
  if (msg.method === "account/rateLimits/read") return { id: msg.id, result: {
    rateLimits: { limitId: "codex", planType: "plus",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1786180000 } } } };
  return null;
}`;

describe("local CLI quota probes (fake executables)", () => {
  it("reads Codex rate limits over JSON-RPC and skips non-JSON noise", async () => {
    const cli = jsonRpcCli("codex-ok", codexReply, `process.stdout.write("booting codex...\\n");`);
    const quota = await probeCodexQuota(cli, 5000, now);
    expect(quota.status).toBe("ok");
    expect(quota.plan).toBe("plus");
    expect(quota.primary?.remaining_percent).toBe(75);
  });

  it("keeps a reply written just before a clean exit", async () => {
    const cli = jsonRpcCli(
      "codex-fast-exit",
      codexReply.replace(
        'return { id: msg.id, result: {\n    rateLimits',
        'setImmediate(() => process.exit(0)); return { id: msg.id, result: {\n    rateLimits',
      ),
    );
    expect(fs.readFileSync(cli, "utf8")).toContain("process.exit(0)");
    const quota = await probeCodexQuota(cli, 5000, now);
    expect(quota.status).toBe("ok");
  });

  it("surfaces a JSON-RPC error from Codex", async () => {
    const cli = jsonRpcCli(
      "codex-error",
      `(msg) => msg.method === "initialize"
        ? { id: msg.id, result: {} }
        : msg.id === 6 ? { id: 6, error: { message: "not logged in" } } : null`,
    );
    await expect(probeCodexQuota(cli, 5000, now)).rejects.toThrow("not logged in");
  });

  it("reads Grok billing over JSON-RPC", async () => {
    const cli = jsonRpcCli(
      "grok-ok",
      `(msg) => msg.id === 1 ? { jsonrpc: "2.0", id: 1, result: {} }
        : msg.id === 2 ? { jsonrpc: "2.0", id: 2, result: { subscription_tier: "SuperGrok",
            config: { creditUsagePercent: 40 } } } : null`,
    );
    const quota = await probeGrokQuota(cli, 5000, now);
    expect(quota.status).toBe("ok");
    expect(quota.primary?.used_percent).toBe(40);
  });

  it("times out a CLI that never answers", async () => {
    const cli = fakeCli("codex-hang", "setInterval(() => {}, 1000);");
    await expect(probeCodexQuota(cli, 300, now)).rejects.toThrow(/timed out after 300ms/);
  });

  it("fails fast when the CLI exits cleanly without answering", async () => {
    const cli = fakeCli("codex-silent", "process.exit(0);");
    const started = Date.now();
    await expect(probeCodexQuota(cli, 5000, now)).rejects.toThrow(/exited before responding/);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("redacts bearer tokens from a crashing CLI's stderr", async () => {
    const cli = fakeCli(
      "codex-crash",
      `process.stderr.write("auth failed: Bearer sk-fake-not-real-123\\n"); process.exit(3);`,
    );
    const err = await probeCodexQuota(cli, 5000, now).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exited \(3\)/);
    expect((err as Error).message).not.toContain("sk-fake-not-real-123");
  });

  it("rejects (without crashing the process) when the binary is missing", async () => {
    await expect(probeCodexQuota(path.join(dir, "does-not-exist"), 5000, now)).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("uses Claude CLI /usage output when no credentials file exists", async () => {
    const cli = fakeCli(
      "claude-ok",
      `process.stdout.write(JSON.stringify({ result: "Current session: 30% used\\nCurrent week (all models): 50% used" }));`,
    );
    const quota = await probeClaudeQuota(cli, path.join(dir, "missing.json"), 5000, now);
    expect(quota.status).toBe("ok");
    expect(quota.windows.map((w) => w.used_percent).sort()).toEqual([30, 50]);
  });

  it("reports Claude unavailable when the CLI prints garbage and has no credentials", async () => {
    const cli = fakeCli("claude-garbage", `process.stdout.write("not json at all");`);
    const quota = await probeClaudeQuota(cli, path.join(dir, "missing.json"), 5000, now);
    expect(quota.status).not.toBe("ok");
  });

  it("reports Claude unavailable when the CLI hangs and has no credentials", async () => {
    const cli = fakeCli("claude-hang", "setInterval(() => {}, 1000);");
    const quota = await probeClaudeQuota(cli, path.join(dir, "missing.json"), 300, now);
    expect(quota.status).toBe("unavailable");
  });
});
