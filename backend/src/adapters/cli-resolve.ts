import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DisplayProvider } from "../types/usage.js";

/**
 * Locates a provider CLI: explicit config path first, then known install
 * locations (including VS Code extension bundles, newest version first),
 * then PATH.
 */
export function resolveProviderCli(
  provider: DisplayProvider,
  configuredPath = "",
): string | null {
  if (configuredPath) return configuredPath;

  const home = os.homedir();
  const directCandidates: Record<DisplayProvider, string[]> = {
    claude: [],
    codex: [],
    grok: [path.join(home, ".grok", "bin", "grok")],
    kimi: [],
    gemini: [path.join(home, ".local", "bin", "agy")],
  };
  const extensionPatterns: Record<DisplayProvider, Array<[string, string, string]>> = {
    claude: [
      [".vscode-insiders/extensions", "anthropic.claude-code-", "resources/native-binary/claude"],
      [".vscode/extensions", "anthropic.claude-code-", "resources/native-binary/claude"],
    ],
    codex: [
      [".vscode-insiders/extensions", "openai.chatgpt-", "bin/linux-x86_64/codex"],
      [".vscode/extensions", "openai.chatgpt-", "bin/linux-x86_64/codex"],
    ],
    grok: [],
    kimi: [],
    gemini: [],
  };

  for (const candidate of directCandidates[provider]) {
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const [root, prefix, relative] of extensionPatterns[provider]) {
    const found = newestExtensionExecutable(path.join(home, root), prefix, relative);
    if (found) return found;
  }
  return executableOnPath(
    provider === "claude"
      ? "claude"
      : provider === "codex"
        ? "codex"
        : provider === "grok"
          ? "grok"
          : provider === "gemini"
            ? "agy"
          : "kimi",
  );
}

function newestExtensionExecutable(
  root: string,
  prefix: string,
  relative: string,
): string | null {
  if (!fs.existsSync(root)) return null;
  const directories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const directory of directories) {
    const candidate = path.join(root, directory, relative);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function executableOnPath(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
