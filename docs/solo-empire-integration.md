# Solo Empire integration (read-only)

This product is a **separate repository**. Solo Empire remains the control plane.
The backend may **read** local telemetry; it must **never write** the main database.

## Data source: `ai_run_telemetry`

Schema (counts/metadata only — no prompt/response text):

| Column | Use |
|--------|-----|
| `provider` | Mapped to display cards |
| `input_tokens` / `output_tokens` / `total_tokens` | Aggregates |
| `estimated_cost_usd` | Cost sum |
| `created_at` | Window filter (`today` / `7d` / `30d`) |
| `run_id`, `route`, `model`, `status`, … | Not required for the display |

Contract owner in Solo Empire:

- `infra/scripts/agent/telemetry.py`
- `infra/database/migrations/025_ai_run_telemetry.sql`

## Provider → card mapping

| Telemetry `provider` (examples) | Card |
|---------------------------------|------|
| `anthropic`, `claude`, `claude-code` | CLAUDE |
| `openai`, `codex`, `gpt…` | CODEX |
| `xai`, `grok…` | GROK |
| anything else | ignored for cards |

## Configuration

```bash
USAGE_SOURCE=hybrid
SOLO_EMPIRE_DB_PATH=/absolute/path/to/solo-empire/infra/database/solo-empire.db
```

Or HTTP adapter (preferred if you later expose a read API from Solo Empire):

```bash
USAGE_SOURCE=solo_empire
SOLO_EMPIRE_USAGE_API_URL=http://127.0.0.1:9xxx/internal/ai-usage
SOLO_EMPIRE_USAGE_API_TOKEN=optional
```

Expected API body shape (subset):

```json
{
  "providers": [
    {
      "provider": "anthropic",
      "requests": 3,
      "input_tokens": 100,
      "output_tokens": 20,
      "total_tokens": 120,
      "cost_usd": 0.05
    }
  ]
}
```

## Modes

| Mode | Behaviour |
|------|-----------|
| `providers` | Only external Admin Usage APIs |
| `solo_empire` | Only telemetry DB/API (read-only) |
| `hybrid` | Provider APIs first; fill `no_data`/`unavailable`/`error` from telemetry |

## Safety guarantees

1. SQLite opened read-only (`DatabaseSync(path, { readOnly: true })` from `node:sqlite`).
2. No migration runner, no writes, no shared write connection pool. No system `sqlite3` CLI required.
3. Telemetry contract already forbids prompt/response payloads — this display
   only aggregates numeric fields.
4. Nested product repo under `book-dev`; Solo Empire catalog remains SSOT for
   ops state.

## Suggested ops flow

1. Solo Empire agents continue recording via  
   `npm --prefix infra run agent:telemetry -- …`
2. `ai-usage-display` backend runs on the same machine or LAN.
3. ESP32 polls the display backend every 60s with the device token.
