import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRoutes, createServer, type RouteAccess } from "../src/server.js";
import { loadConfig } from "../src/config.js";

/**
 * Route access matrix. Every route in buildRoutes() (the real table the
 * server dispatches on) must be pinned here; a new route, a changed level or
 * a state-changing method fails CI until this table is updated on purpose.
 */
const EXPECTED: Record<string, { access: RouteAccess; methods: string[] }> = {
  health: { access: "public", methods: ["GET", "HEAD"] },
  ready: { access: "public", methods: ["GET"] },
  "ai-usage": { access: "device", methods: ["GET"] },
};

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const TOKEN = "matrix-device-token";

const noop = () => undefined;
const table = buildRoutes({ usage: noop, health: noop, ready: noop });

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("route access matrix", () => {
  it("pins every route's access level and methods", () => {
    const actual = Object.fromEntries(
      table.map((r) => [r.name, { access: r.access, methods: [...r.methods] }]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("serves no state-changing method", () => {
    for (const route of table) {
      for (const method of route.methods) {
        expect(SAFE_METHODS.has(method), `${route.name} allows ${method}`).toBe(true);
      }
    }
  });

  it("gives every path exactly one route", () => {
    const paths = table.flatMap((r) => r.paths);
    expect(new Set(paths).size).toBe(paths.length);
  });

  describe("over HTTP", () => {
    const server = createServer(
      loadConfig({ DEVICE_TOKEN: TOKEN, SUBSCRIPTION_USAGE_ENABLED: "false" }),
    );
    let port = 0;

    beforeAll(async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    for (const route of table) {
      for (const path of route.paths) {
        for (const method of ALL_METHODS) {
          const allowed = route.methods.includes(method);
          it(`${method} ${path} (${route.access}) without a token`, async () => {
            const status = await request(port, method, path);
            if (!allowed) {
              expect(status).toBe(405);
            } else if (route.access === "device") {
              expect(status).toBe(401);
            } else {
              expect(status).not.toBe(401);
              expect(status).not.toBe(405);
            }
          });
        }
        if (route.access === "device") {
          it(`GET ${path} rejects a wrong token`, async () => {
            expect(await request(port, "GET", path, { Authorization: "Bearer wrong" })).toBe(401);
            expect(await request(port, "GET", path, { "X-Device-Token": "wrong" })).toBe(401);
          });
        }
      }
    }
  });
});
