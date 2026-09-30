import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MAX_COMMAND_OUTPUT,
  runCommand,
  runJsonRpcProcess,
  sanitizeMessage,
} from "../src/adapters/cli.js";
import { resolveProviderCli } from "../src/adapters/cli-resolve.js";

// Fake executables only: no network, no real provider CLIs or credentials.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-clihelpers-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeCli(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}

describe("runCommand", () => {
  it("returns all output written right before exit", async () => {
    // Large output followed by an immediate exit: resolving on "exit"
    // instead of "close" could drop the tail of stdout.
    const cli = fakeCli(
      "burst",
      `process.stdout.write("x".repeat(300000) + "END"); process.exitCode = 0;`,
    );
    const result = await runCommand(cli, [], 5000);
    expect(result.stdout.length).toBe(300003);
    expect(result.stdout.endsWith("END")).toBe(true);
  });

  it("caps stdout at MAX_COMMAND_OUTPUT", async () => {
    const cli = fakeCli(
      "flood",
      `const chunk = "y".repeat(65536); for (let i = 0; i < 20; i++) process.stdout.write(chunk);`,
    );
    const result = await runCommand(cli, [], 5000);
    expect(result.stdout.length).toBe(MAX_COMMAND_OUTPUT);
  });

  it("reports non-zero exits with redacted stderr", async () => {
    const cli = fakeCli(
      "fail",
      `process.stderr.write("auth failed: Bearer sk-secret-value"); process.exit(3);`,
    );
    const error = await runCommand(cli, [], 5000).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("local CLI exited (3)");
    expect((error as Error).message).toContain("Bearer [redacted]");
    expect((error as Error).message).not.toContain("sk-secret-value");
  });

  it("times out and kills a hanging process", async () => {
    const cli = fakeCli("hang", `setInterval(() => {}, 1000);`);
    await expect(runCommand(cli, [], 200)).rejects.toThrow("timed out after 200ms");
  });

  it("rejects when the executable does not exist", async () => {
    await expect(runCommand(path.join(dir, "missing"), [], 1000)).rejects.toThrow(/ENOENT/);
  });
});

describe("runJsonRpcProcess", () => {
  it("fails the session when the start callback throws", async () => {
    const cli = fakeCli("idle", `setInterval(() => {}, 1000);`);
    await expect(
      runJsonRpcProcess(cli, [], 5000, () => {
        throw new Error("bad handshake");
      }),
    ).rejects.toThrow("bad handshake");
  });
});

describe("sanitizeMessage", () => {
  it("redacts JWTs, collapses whitespace and bounds length", () => {
    const out = sanitizeMessage(`token eyJhbGciOiJIUzI1NiJ9.e30.sig\n\n${"z".repeat(400)}`);
    expect(out).not.toContain("eyJ");
    expect(out).not.toMatch(/\n/);
    expect(out.length).toBeLessThanOrEqual(180);
  });
});

describe("resolveProviderCli", () => {
  it("prefers an explicitly configured path", () => {
    expect(resolveProviderCli("codex", "/opt/custom/codex")).toBe("/opt/custom/codex");
  });

  it("falls back to an executable on PATH", () => {
    const bin = fs.mkdtempSync(path.join(dir, "bin-"));
    fakeCli(path.relative(dir, path.join(bin, "kimi")), "");
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(resolveProviderCli("kimi")).toBe(path.join(bin, "kimi"));
    } finally {
      process.env.PATH = previous;
    }
  });
});
