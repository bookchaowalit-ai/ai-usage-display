import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

/**
 * Process helpers for the local provider CLIs (Claude, Codex, Grok, ...).
 * Both the one-shot command runner and the JSON-RPC session share one
 * supervisor, so timeouts, stderr capture, spawn errors and exit handling
 * behave the same way for every provider.
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export const MAX_COMMAND_OUTPUT = 1024 * 1024;
const MAX_STDERR = 4096;

interface Supervisor {
  child: ChildProcess;
  finish: (error?: Error, value?: unknown) => void;
  stderr: () => string;
  /** Registers teardown to run once when the process settles. */
  onSettle: (fn: () => void) => void;
}

/**
 * Spawns `executable` and settles exactly once: on `finish`, a spawn error,
 * the timeout, or the process closing. `onClose` decides the outcome of a
 * close that happens before anything else settled. "close" (not "exit")
 * fires after stdout/stderr are drained, so output written right before the
 * process exits is never lost.
 */
function supervise(
  executable: string,
  args: string[],
  timeoutMs: number,
  stdin: "pipe" | "ignore",
  resolve: (value: unknown) => void,
  reject: (error: Error) => void,
  onClose: (code: number | null, signal: NodeJS.Signals | null, sup: Supervisor) => void,
): Supervisor {
  const child = spawn(executable, args, { stdio: [stdin, "pipe", "pipe"] });
  let settled = false;
  let stderr = "";
  let cleanup = (): void => {};

  const finish = (error?: Error, value?: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanup();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (error) reject(error);
    else resolve(value);
  };
  const sup: Supervisor = {
    child,
    finish,
    stderr: () => stderr,
    onSettle: (fn) => {
      cleanup = fn;
    },
  };
  const timer = setTimeout(
    () => finish(new Error(`local CLI timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => finish(error));
  // A CLI that dies before reading stdin makes writes fail with EPIPE; the
  // close handler reports that, so keep the stream error from being an
  // uncaught exception.
  child.stdin?.on("error", () => {});
  child.on("close", (code, signal) => {
    if (!settled) onClose(code, signal, sup);
  });
  return sup;
}

function exitError(code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
  return new Error(
    `local CLI exited (${signal ?? code ?? "unknown"})${stderr ? `: ${sanitizeMessage(stderr)}` : ""}`,
  );
}

/** Runs a CLI to completion and returns its (size-capped) output. */
export function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const sup = supervise(
      executable,
      args,
      timeoutMs,
      "ignore",
      (value) => resolve(value as CommandResult),
      reject,
      (code, signal, s) => {
        if (code === 0) s.finish(undefined, { stdout, stderr: s.stderr() });
        else s.finish(exitError(code, signal, s.stderr()));
      },
    );
    sup.child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) {
        stdout += chunk.toString("utf8").slice(0, MAX_COMMAND_OUTPUT - stdout.length);
      }
    });
  });
}

/**
 * Talks line-delimited JSON-RPC to a CLI. `start` sends the opening requests
 * and returns the handler for each parsed message; the handler calls
 * `resolve` with the final value or throws to fail the session. Non-JSON
 * lines (banners, logs) are ignored.
 */
export function runJsonRpcProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  start: (
    send: (message: unknown) => void,
    resolve: (value: unknown) => void,
  ) => (message: JsonRpcMessage) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sup = supervise(executable, args, timeoutMs, "pipe", resolve, reject, (code, signal, s) => {
      // Any exit without a reply settles immediately instead of waiting for
      // the timeout.
      if (code === 0) s.finish(new Error("local CLI exited before responding"));
      else s.finish(exitError(code, signal, s.stderr()));
    });
    const { child, finish } = sup;
    if (!child.stdout || !child.stdin) {
      finish(new Error("local CLI stdio unavailable"));
      return;
    }
    const lines = readline.createInterface({ input: child.stdout });
    sup.onSettle(() => lines.close());
    const stdinStream = child.stdin;
    const send = (message: unknown): void => {
      stdinStream.write(`${JSON.stringify(message)}\n`);
    };
    let onMessage: (message: JsonRpcMessage) => void;
    try {
      onMessage = start(send, (value) => finish(undefined, value));
    } catch (error) {
      finish(error instanceof Error ? error : new Error("local CLI protocol failed"));
      return;
    }
    lines.on("line", (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      try {
        onMessage(message);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("local CLI protocol failed"));
      }
    });
  });
}

/** Redacts bearer tokens/JWTs and bounds the length of CLI error text. */
export function sanitizeMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
