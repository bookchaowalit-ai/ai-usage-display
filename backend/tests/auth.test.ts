import { describe, expect, it } from "vitest";
import { extractDeviceToken, isAuthorized, tokensMatch } from "../src/lib/auth.js";

describe("auth", () => {
  it("extracts Bearer token", () => {
    expect(extractDeviceToken({ authorization: "Bearer abc123" })).toBe("abc123");
  });

  it("extracts X-Device-Token", () => {
    expect(extractDeviceToken({ "x-device-token": "xyz" })).toBe("xyz");
  });

  it("matches equal tokens", () => {
    expect(tokensMatch("secret-token", "secret-token")).toBe(true);
    expect(tokensMatch("secret-token", "wrong-token!")).toBe(false);
    expect(tokensMatch("secret-token", null)).toBe(false);
  });

  it("authorizes valid headers", () => {
    expect(isAuthorized({ authorization: "Bearer my-device" }, "my-device")).toBe(true);
    expect(isAuthorized({ authorization: "Bearer other" }, "my-device")).toBe(false);
  });
});
