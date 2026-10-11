import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Version, size and MD5 of the firmware image the device should run. */
export interface FirmwareManifest {
  version: string;
  size: number;
  md5: string;
  sha256: string;
  uploaded_at: string;
}

const VERSION_RE = /^[0-9A-Za-z._-]{1,40}$/;
export const MAX_FIRMWARE_BYTES = 2 * 1024 * 1024;

/**
 * OTA images live in a directory (a Railway volume when hosted). They are
 * built without secrets: the device keeps Wi-Fi, URL and token in NVS.
 */
export class FirmwareStore {
  constructor(private readonly dir: string) {}

  private get binPath(): string {
    return path.join(this.dir, "latest.bin");
  }

  private get manifestPath(): string {
    return path.join(this.dir, "manifest.json");
  }

  manifest(): FirmwareManifest | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, "utf8")) as FirmwareManifest;
      if (!VERSION_RE.test(parsed.version) || !fs.existsSync(this.binPath)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  binary(): Buffer | null {
    try {
      return fs.readFileSync(this.binPath);
    } catch {
      return null;
    }
  }

  /** Validates and atomically replaces the published image. */
  publish(version: string, md5: string, image: Buffer, now: Date = new Date()): FirmwareManifest {
    if (!VERSION_RE.test(version)) throw new Error("invalid version");
    if (image.length === 0 || image.length > MAX_FIRMWARE_BYTES) throw new Error("invalid size");
    // ESP32 application images start with the 0xE9 magic byte.
    if (image[0] !== 0xe9) throw new Error("not an ESP32 image");
    const actualMd5 = createHash("md5").update(image).digest("hex");
    if (actualMd5 !== md5.toLowerCase()) throw new Error("md5 mismatch");
    const manifest: FirmwareManifest = {
      version,
      size: image.length,
      md5: actualMd5,
      sha256: createHash("sha256").update(image).digest("hex"),
      uploaded_at: now.toISOString(),
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(`${this.binPath}.tmp`, image);
    fs.renameSync(`${this.binPath}.tmp`, this.binPath);
    fs.writeFileSync(`${this.manifestPath}.tmp`, JSON.stringify(manifest));
    fs.renameSync(`${this.manifestPath}.tmp`, this.manifestPath);
    return manifest;
  }
}
