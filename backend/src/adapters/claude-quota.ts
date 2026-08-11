import type { ProviderQuota } from "../types/usage.js";
import { readQuotaSnapshotFile } from "./gemini-quota.js";

export function readClaudeQuotaFile(
  filePath: string,
  now = new Date(),
  maxAgeSeconds = 0,
): ProviderQuota {
  return readQuotaSnapshotFile(filePath, "Claude", "claude", now, maxAgeSeconds);
}
