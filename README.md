# AI Usage Display

Display **Codex Spark**, **Codex/OpenAI**, **Grok**, **Kimi Code**, and **Gemini** paid-plan quota on an
**ESP32-2432S028** 2.8" ILI9341 320×240 touch LCD.

```
ai-usage-display/
├── backend/                 # TypeScript/Node.js usage aggregator
├── firmware/esp32-lvgl/     # ESP32 + LVGL display client
├── docs/                    # Setup, security, API examples
└── README.md
```

## Design principles

| Rule | Why |
|------|-----|
| API keys stay on the **backend only** | ESP32 must never call providers or hold provider secrets |
| ESP32 only fetches `GET /api/ai-usage` | Small attack surface; device token auth |
| No prompts, responses, or PII | Aggregates only: requests, tokens, cost, status |
| Unavailable providers stay honest | `status: "unavailable"` when no usage API / missing credentials |
| Solo Empire is read-only | Optional `ai_run_telemetry` SQLite adapter; never writes the main DB |
| Subscription quota stays local | Reads signed-in provider CLIs or non-secret host snapshots; ESP32 receives only percentages/reset times |

## Architecture

```
┌─────────────┐  Admin keys   ┌──────────────────────┐  device token  ┌─────────────┐
│ Anthropic   │──────────────▶│                      │◀───────────────│  ESP32      │
│ OpenAI      │               │  backend (Node/TS)   │  GET /api/…    │  + LVGL     │
│ xAI / Kimi  │──────────────▶│  cache 60s           │───────────────▶│  320×240    │
└─────────────┘               │  adapters + status   │                └─────────────┘
                              │                      │
┌─────────────┐  quota JSON   │                      │
│ Antigravity │──────────────▶│  local quota overlay │
│ agy / Gemini│  host only    └──────────────────────┘
└─────────────┘
┌─────────────┐  read-only    │                      │
│ Solo Empire │──────────────▶│  (optional)          │
│ ai_run_     │  SQLite       └──────────────────────┘
│ telemetry   │
└─────────────┘
```

## Quick start

### Backend

```bash
cd backend
cp .env.example .env
# edit .env — DEVICE_TOKEN is required; provider keys optional
npm install
npm test
npm run dev
```

```bash
curl -H "Authorization: Bearer $DEVICE_TOKEN" \
  "http://127.0.0.1:8787/api/ai-usage?window=today"
```

For a background service that starts again after reboot, use
[Docker Compose](docs/docker-autostart.md). It keeps the provider sessions on
the host and mounts Solo Empire's database read-only.

### Firmware

1. Copy `firmware/esp32-lvgl/config.h.example` → `config.h`
2. Copy `firmware/esp32-lvgl/secrets.h.example` → `secrets.h`
3. Set Wi-Fi SSID/password, backend URL, and the same device token
4. Flash with Arduino IDE (ESP32 Dev Module) — see [docs/firmware-upload.md](docs/firmware-upload.md)

## API response shape

```json
{
  "window": "today",
  "generated_at": "2026-08-08T05:00:00.000Z",
  "cache": { "hit": false, "ttl_seconds": 60 },
  "providers": [
    {
      "provider": "claude",
      "requests": 12,
      "input_tokens": 45000,
      "output_tokens": 8200,
      "total_tokens": 53200,
      "cost_usd": 1.24,
      "status": "ok",
      "updated_at": "2026-08-08T05:00:00.000Z",
      "quota": {
        "status": "ok",
        "plan": "pro",
        "primary": {
          "label": "5h",
          "used_percent": 20,
          "remaining_percent": 80,
          "resets_at": "2026-08-08T09:00:00.000Z"
        }
      }
    }
  ]
}
```

`status` values: `ok` | `no_data` | `stale` | `unavailable` | `error`

Telemetry status and subscription quota are independent. A provider can have
`status: "unavailable"` when no token/cost usage source is configured while
`quota.status: "ok"` confirms that its signed-in subscription quota is live.

`no_data` means the source was read successfully but has no matching usage
rows in the selected time window. It is intentionally different from `ok`
with zero values.

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/backend-setup.md](docs/backend-setup.md) | Install and run the backend |
| [docs/environment-variables.md](docs/environment-variables.md) | Env vars reference |
| [docs/firmware-upload.md](docs/firmware-upload.md) | Arduino upload steps |
| [docs/touch-calibration.md](docs/touch-calibration.md) | XPT2046 calibration |
| [docs/physical-buttons.md](docs/physical-buttons.md) | External button/keycap wiring and GPIO safety |
| [docs/portable-use.md](docs/portable-use.md) | Power bank, battery safety, and standalone/network use |
| [docs/api-examples.md](docs/api-examples.md) | Sample JSON |
| [docs/security.md](docs/security.md) | Security notes |
| [docs/solo-empire-integration.md](docs/solo-empire-integration.md) | Read-only telemetry adapter |
| [docs/docker-autostart.md](docs/docker-autostart.md) | Docker background service and reboot auto-start |
| [docs/gemini-antigravity.md](docs/gemini-antigravity.md) | Gemini quota bridge from authenticated Antigravity CLI |
| [docs/claude-code-quota.md](docs/claude-code-quota.md) | Claude Code quota bridge and reset timestamps |

## License

MIT
