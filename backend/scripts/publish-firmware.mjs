#!/usr/bin/env node
// Publish an OTA image to the hosted backend:
//   node scripts/publish-firmware.mjs <image.bin> <version>
// Uses RELAY_URL and RELAY_PUSH_TOKEN from backend/.env; never prints tokens.
import { config as loadDotenv } from "dotenv";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const [file, version] = process.argv.slice(2);
const relayUrl = (process.env.RELAY_URL ?? "").trim().replace(/\/+$/, "");
const pushToken = (process.env.RELAY_PUSH_TOKEN ?? "").trim();
if (!file || !version || !relayUrl || !pushToken) {
  console.error("usage: publish-firmware.mjs <image.bin> <version>  (needs RELAY_URL, RELAY_PUSH_TOKEN)");
  process.exit(1);
}

const image = readFileSync(file);
const response = await fetch(`${relayUrl}/api/firmware`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${pushToken}`,
    "Content-Type": "application/octet-stream",
    "X-Firmware-Version": version,
    "X-Firmware-MD5": createHash("md5").update(image).digest("hex"),
  },
  body: image,
  signal: AbortSignal.timeout(120_000),
});
const body = await response.text();
if (!response.ok) {
  console.error(`publish failed: HTTP ${response.status} ${body}`);
  process.exit(1);
}
console.log(body);
