#!/usr/bin/env bash
# Build an OTA image without secrets and publish it to the hosted backend.
# The device keeps Wi-Fi, backend URL and token in NVS from its USB flash.
#
#   firmware/scripts/release-ota.sh            # build + publish
#   firmware/scripts/release-ota.sh --build    # build only (prints the .bin path)
#
# Needs arduino-cli with esp32:esp32, TFT_eSPI (with this repo's User_Setup.h),
# XPT2046_Touchscreen and ArduinoJson 6. Publishing reads RELAY_URL and
# RELAY_PUSH_TOKEN from backend/.env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SKETCH_SRC="$ROOT/firmware/esp32-lvgl"
FQBN="${FQBN:-esp32:esp32:esp32}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SKETCH="$WORK/esp32-lvgl"
mkdir -p "$SKETCH" "$WORK/out"
cp "$SKETCH_SRC/esp32-lvgl.ino" "$SKETCH_SRC/root_ca.h" "$SKETCH_SRC/version.h" "$SKETCH_SRC/User_Setup.h" "$SKETCH/"
cp "$SKETCH_SRC/config.h.example" "$SKETCH/config.h"
cat > "$SKETCH/secrets.h" <<'H'
#pragma once
// OTA build: no secrets. The device uses the values stored in NVS.
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define BACKEND_BASE_URL ""
#define DEVICE_TOKEN ""
H

arduino-cli compile --fqbn "$FQBN" --output-dir "$WORK/out" "$SKETCH" >&2
BIN="$WORK/out/esp32-lvgl.ino.bin"
VERSION="$(sed -n 's/^#define FW_VERSION "\(.*\)"/\1/p' "$SKETCH_SRC/version.h")"
DIST="$ROOT/firmware/dist"
mkdir -p "$DIST"
cp "$BIN" "$DIST/esp32-lvgl-$VERSION.bin"
echo "built $DIST/esp32-lvgl-$VERSION.bin ($(stat -c %s "$BIN") bytes)" >&2

if [[ "${1:-}" == "--build" ]]; then
  exit 0
fi
node "$ROOT/backend/scripts/publish-firmware.mjs" "$DIST/esp32-lvgl-$VERSION.bin" "$VERSION"
