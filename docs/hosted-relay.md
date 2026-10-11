# Hosted relay (PaaS)

The ESP32 can read usage from a hosted backend instead of a LAN machine. The
hosted copy never holds provider credentials: the host still probes quotas
locally and pushes only the resulting payload (percentages, reset times,
status text).

```
host backend (127.0.0.1:8787, probes providers)
   └─ scripts/relay-push.mjs ──HTTPS POST──▶ hosted backend (RELAY_MODE=server)
                                               └─ GET /api/ai-usage ◀── ESP32 (HTTPS)
```

## Hosted service (Railway)

Deploy `backend/` with its Dockerfile and set:

| Variable | Value |
|----------|-------|
| `RELAY_MODE` | `server` |
| `RELAY_PUSH_TOKEN` | long random token, used only by the host pusher |
| `DEVICE_TOKEN` | same token the firmware sends |
| `SUBSCRIPTION_USAGE_ENABLED` | `false` |
| `RELAY_MAX_AGE_SECONDS` | optional, default `600` |

In relay mode the server has one extra route, `POST /api/relay/snapshot`
(push token, 64 KB limit). `GET /api/ai-usage` returns the last push while it
is younger than `RELAY_MAX_AGE_SECONDS`, otherwise 503 so the display shows
OFFLINE instead of old numbers. `/ready` is 200 only with a fresh snapshot.
The snapshot lives in memory; the pusher refills it within a minute after a
restart.

## Host pusher

Add to the host `backend/.env`:

```
RELAY_URL=https://<service>.up.railway.app
RELAY_PUSH_TOKEN=<same as hosted>
```

Run `node scripts/relay-push.mjs --once` to test, then keep it running (for
example as a systemd user service with `Restart=always`). It pushes every
`RELAY_PUSH_INTERVAL_SECONDS` (default 60). With the relay in place the host
backend can bind to `HOST=127.0.0.1`.

## Firmware

Set `BACKEND_BASE_URL` in `secrets.h` to the `https://` URL. HTTPS requests
verify the server against the Let's Encrypt roots in `root_ca.h`; `http://`
URLs keep working for a LAN backend.

## Firmware updates over the air

After one USB flash with this firmware, later updates come from the hosted
backend; the board can stay on any USB power source.

- On every boot the firmware copies non-empty `secrets.h` values (Wi-Fi,
  `BACKEND_BASE_URL`, `DEVICE_TOKEN`) into NVS and then reads them from NVS.
  OTA images are built with empty secrets, so they contain no credentials and
  keep the stored values.
- About 30 s after boot and then every `OTA_CHECK_MS` (default 1 h), the board
  reads `GET /api/firmware/manifest`. When `version` differs from
  `FW_VERSION` it downloads `GET /api/firmware/latest.bin`, checks size and
  MD5, flashes the inactive OTA slot and restarts. A failed or partial
  download leaves the current firmware running.
- Both firmware routes need the device token. Publishing (`POST /api/firmware`)
  needs the relay push token, accepts only ESP32 images (magic byte `0xE9`)
  up to 2 MB, and verifies the `X-Firmware-MD5` header. The hosted service
  stores the image under `FIRMWARE_DIR` (a Railway volume at `/data/firmware`).

Release a new version:

1. Bump `FW_VERSION` in `firmware/esp32-lvgl/version.h`.
2. Run `firmware/scripts/release-ota.sh` (builds with empty secrets and
   publishes using `RELAY_URL` / `RELAY_PUSH_TOKEN` from `backend/.env`).

The board picks it up within an hour, or immediately after a power cycle.
There is no automatic rollback: an image that boots but cannot reach the
network needs a USB flash, so test a release on the bench first when it
touches Wi-Fi or HTTP code.
