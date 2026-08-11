import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readGeminiQuotaFile } from "../src/adapters/gemini-quota.js";

describe("readGeminiQuotaFile", () => {
  it("reads weekly and five-hour windows from a non-secret snapshot", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "ai-usage-gemini-"));
    const filePath = path.join(directory, "quota.json");
    try {
      writeFileSync(
        filePath,
        JSON.stringify({
          status: "ok",
          plan: "antigravity",
          updated_at: "2026-08-08T11:00:00.000Z",
          message: "source:antigravity-cli",
          windows: [
            {
              id: "weekly",
              label: "week",
              used_percent: 25,
              remaining_percent: 75,
              resets_at: "2026-08-15T11:00:00.000Z",
              duration_minutes: 10080,
            },
            {
              id: "five_hour",
              label: "5h",
              used_percent: 10,
              remaining_percent: 90,
              resets_at: "2026-08-08T16:00:00.000Z",
              duration_minutes: 300,
            },
          ],
        }),
      );

      const quota = readGeminiQuotaFile(filePath);
      expect(quota.status).toBe("ok");
      expect(quota.plan).toBe("antigravity");
      expect(quota.windows.map((window) => window.label)).toEqual(["week", "5h"]);
      expect(quota.primary?.remaining_percent).toBe(75);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns unavailable when the snapshot is missing", () => {
    const quota = readGeminiQuotaFile("/tmp/ai-usage-display-no-gemini-quota.json");
    expect(quota.status).toBe("unavailable");
    expect(quota.windows).toEqual([]);
  });

  it("marks an old snapshot as stale when a production age limit is supplied", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "ai-usage-gemini-stale-"));
    const filePath = path.join(directory, "quota.json");
    const now = new Date("2026-08-10T00:00:00.000Z");
    try {
      writeFileSync(
        filePath,
        JSON.stringify({
          status: "ok",
          updated_at: "2026-08-09T23:54:00.000Z",
          windows: [
            {
              id: "weekly",
              label: "week",
              remaining_percent: 80,
              resets_at: "2026-08-15T00:00:00.000Z",
            },
          ],
        }),
      );

      const quota = readGeminiQuotaFile(filePath, now, 300);
      expect(quota.status).toBe("stale");
      expect(quota.windows).toHaveLength(1);
      expect(quota.message).toContain("stale");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
