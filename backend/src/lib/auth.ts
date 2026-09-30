import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Extract device bearer token from Authorization header or X-Device-Token.
 * Never logs the token value.
 */
export function extractDeviceToken(headers: IncomingHttpHeaders): string | null {
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const device = headers["x-device-token"];
  if (typeof device === "string" && device.trim()) return device.trim();
  if (Array.isArray(device) && device[0]?.trim()) return device[0].trim();
  return null;
}

/**
 * Constant-time token comparison. Both sides are hashed first so the
 * comparison length is fixed and does not reveal the expected length.
 */
export function tokensMatch(expected: string, provided: string | null): boolean {
  if (!expected || !provided) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function isAuthorized(
  headers: IncomingHttpHeaders,
  deviceToken: string,
): boolean {
  if (!deviceToken) return false;
  return tokensMatch(deviceToken, extractDeviceToken(headers));
}
