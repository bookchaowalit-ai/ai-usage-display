# Security notes

## Threat model (summary)

| Asset | Where it lives | Who may hold it |
|-------|----------------|-----------------|
| Provider Admin / API keys and local CLI sessions | Backend host only | Host running backend |
| Device token | Backend `.env` + ESP32 `secrets.h` | Backend + devices you control |
| Wi-Fi password | ESP32 `secrets.h` | Device only |
| Usage aggregates | Memory cache + HTTP responses | LAN clients with device token |
| Prompts / responses / PII | **Nowhere in this system** | N/A |

## Hard rules

1. **Never put Anthropic, OpenAI, xAI, or Kimi credentials in firmware.**
2. **ESP32 must not call provider APIs directly.** Only `GET /api/ai-usage`.
3. **Do not log or store prompts, responses, or personal content.**
4. **Do not commit** `.env`, `secrets.h`, or real tokens.
5. **Solo Empire DB is read-only.** The backend opens SQLite with Node `DatabaseSync(..., { readOnly: true })` and never issues INSERT/UPDATE/DELETE.
6. **Local CLI credentials never enter API responses.** Subscription probes
   return only plan label, percentages, quota window, and reset timestamp.
7. **Kimi refresh stays local.** The backend may rotate Kimi's short-lived OAuth
   credentials in Kimi's own credential file; it uses a cross-process lock and
   never copies those values into logs, API responses, or firmware.

## Device token

- Generate a long random value (`openssl rand -hex 32`).
- Rotate if a device is lost or the token leaks.
- Prefer LAN-only binding or a reverse proxy with TLS if exposed beyond home Wi-Fi.

## Network recommendations

- Run the backend on a private LAN.
- Do not expose Admin keys or the usage API to the public internet without TLS and stronger auth.
- If you need remote access, put the backend behind a VPN or authenticated reverse proxy; keep provider keys on that host only.

## Firmware surface

- Firmware stores only Wi-Fi + backend URL + device token.
- Serial debug (`DEBUG_SERIAL`) may print usage JSON (counts only). Disable for production kiosks if desired.
- OTA updates are out of scope; treat physical USB access as full device compromise.

## Cache

- In-memory 60s cache reduces provider API chatter.
- The same cache also prevents spawning provider CLI quota probes more than once per minute.
- Cached payloads still require a valid device token on every request.

## Status honesty

Providers without a working usage API report `unavailable`. A successful source
with no matching rows reports `no_data`, instead of inventing zeros that look
like real success.
