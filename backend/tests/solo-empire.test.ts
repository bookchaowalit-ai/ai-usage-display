import { describe, expect, it } from "vitest";
import {
  mapTelemetryProvider,
  parseApiBody,
  parseSqliteCsv,
  SoloEmpireAdapter,
} from "../src/adapters/solo-empire.js";

describe("mapTelemetryProvider", () => {
  it("maps known providers", () => {
    expect(mapTelemetryProvider("anthropic")).toBe("claude");
    expect(mapTelemetryProvider("claude-code")).toBe("claude");
    expect(mapTelemetryProvider("openai")).toBe("codex");
    expect(mapTelemetryProvider("codex")).toBe("codex");
    expect(mapTelemetryProvider("xai")).toBe("grok");
    expect(mapTelemetryProvider("grok-4")).toBe("grok");
    expect(mapTelemetryProvider("moonshot-ai/kimi-code")).toBe("kimi");
    expect(mapTelemetryProvider("qwen")).toBeNull();
  });
});

describe("parseSqliteCsv", () => {
  it("parses pipe-separated rows", () => {
    const raw = "anthropic|3|100|20|120|0.05\nopenai|1|10|2|12|0.01\n";
    const rows = parseSqliteCsv(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.provider).toBe("anthropic");
    expect(rows[0]!.requests).toBe(3);
    expect(rows[1]!.cost_usd).toBe(0.01);
  });
});

describe("parseApiBody", () => {
  it("reads providers array", () => {
    const rows = parseApiBody({
      providers: [{ provider: "xai", requests: 2, input_tokens: 5, output_tokens: 1, total_tokens: 6, cost_usd: 0 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("xai");
  });
});

describe("SoloEmpireAdapter", () => {
  it("returns unavailable when not configured", async () => {
    const adapter = new SoloEmpireAdapter({ dbPath: "", apiUrl: "", apiToken: "" });
    const all = await adapter.fetchAll("today");
    expect(all.claude.status).toBe("unavailable");
    expect(all.codex.status).toBe("unavailable");
    expect(all.grok.status).toBe("unavailable");
    expect(all.kimi.status).toBe("unavailable");
  });

  it("aggregates from HTTP API", async () => {
    const fetchImpl = async () => {
      const body = {
        providers: [
          { provider: "claude", requests: 4, input_tokens: 200, output_tokens: 40, total_tokens: 240, cost_usd: 0.2 },
          { provider: "openai", requests: 1, input_tokens: 10, output_tokens: 2, total_tokens: 12, cost_usd: 0.01 },
        ],
      };
      return {
        ok: true,
        status: 200,
        text: JSON.stringify(body),
        json: async () => body,
      };
    };

    const adapter = new SoloEmpireAdapter(
      { dbPath: "", apiUrl: "http://localhost:9/telemetry", apiToken: "t" },
      fetchImpl,
    );
    const all = await adapter.fetchAll("today");
    expect(all.claude.status).toBe("ok");
    expect(all.claude.requests).toBe(4);
    expect(all.codex.requests).toBe(1);
    expect(all.grok.status).toBe("no_data");
    expect(all.kimi.status).toBe("no_data");
    expect(all.grok.requests).toBe(0);
  });

  it("marks every card as no_data when the read-only source has no rows", async () => {
    const adapter = new SoloEmpireAdapter(
      { dbPath: "", apiUrl: "http://localhost:9/telemetry", apiToken: "" },
      async () => ({
        ok: true,
        status: 200,
        text: "{}",
        json: async () => ({}),
      }),
    );
    const all = await adapter.fetchAll("today");
    expect(all.claude.status).toBe("no_data");
    expect(all.codex.status).toBe("no_data");
    expect(all.grok.status).toBe("no_data");
    expect(all.kimi.status).toBe("no_data");
    expect(all.claude.message).toContain("no rows");
  });
});
