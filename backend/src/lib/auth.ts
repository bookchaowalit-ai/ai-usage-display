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
 * Constant-time-ish string compare to reduce timing leaks for short tokens.
 */
export function tokensMatch(expected: string, provided: string | null): boolean {
  if (!expected || !provided) return false;
  if (expected.length !== provided.length) {
    // Still walk expected to avoid trivial short-circuit timing on length alone
    let acc = 0;
    for (let i = 0; i < expected.length; i++) {
      acc |= expected.charCodeAt(i) ^ 0;
    }
    return acc < 0; // always false
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

export function isAuthorized(
  headers: IncomingHttpHeaders,
  deviceToken: string,
): boolean {
  if (!deviceToken) return false;
  return tokensMatch(deviceToken, extractDeviceToken(headers));
}
