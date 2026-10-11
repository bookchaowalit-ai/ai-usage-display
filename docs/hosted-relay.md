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
