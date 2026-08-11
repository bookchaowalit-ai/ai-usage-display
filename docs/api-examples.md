# API examples

## Endpoint

```
GET /api/ai-usage?window=today
```

### Query

| Param | Values | Default |
|-------|--------|---------|
| `window` | `today`, `7d`, `30d` | `today` |

### Auth

```
Authorization: Bearer <DEVICE_TOKEN>
```

or

```
X-Device-Token: <DEVICE_TOKEN>
```

## Success (200)

```json
{
  "window": "today",
  "generated_at": "2026-08-08T05:12:34.000Z",
  "cache": {
    "hit": false,
    "ttl_seconds": 60
  },
  "providers": [
    {
      "provider": "claude",
      "requests": 12,
      "input_tokens": 45000,
      "output_tokens": 8200,
      "total_tokens": 53200,
      "cost_usd": 1.24,
      "status": "ok",
      "updated_at": "2026-08-08T05:12:34.000Z",
      "quota": {
        "status": "ok",
        "plan": "pro",
        "primary": {
          "id": "five_hour",
          "label": "5h",
          "used_percent": 20,
          "remaining_percent": 80,
          "resets_at": "2026-08-08T09:00:00.000Z",
          "duration_minutes": 300
        },
        "windows": [],
        "updated_at": "2026-08-08T05:12:34.000Z"
      }
    },
    {
      "provider": "codex",
      "requests": 40,
      "input_tokens": 120000,
      "output_tokens": 18000,
      "total_tokens": 138000,
      "cost_usd": 3.05,
      "status": "ok",
      "updated_at": "2026-08-08T05:12:34.000Z"
    },
    {
      "provider": "grok",
      "requests": 0,
      "input_tokens": 0,
      "output_tokens": 0,
      "total_tokens": 0,
      "cost_usd": 0,
      "status": "unavailable",
      "updated_at": "2026-08-08T05:12:34.000Z",
      "message": "xAI public Usage API not enabled (set XAI_USAGE_ENABLED=true when available)"
    },
    {
      "provider": "kimi",
      "requests": 0,
      "input_tokens": 0,
      "output_tokens": 0,
      "total_tokens": 0,
      "cost_usd": 0,
      "status": "no_data",
      "updated_at": "2026-08-08T05:12:34.000Z",
      "quota": {
        "status": "ok",
        "plan": "Basic",
        "primary": {
          "id": "limit-1",
          "label": "5h",
          "used_percent": 0,
          "remaining_percent": 100,
          "resets_at": "2026-08-08T08:02:35.827Z",
          "duration_minutes": 300
        }
      }
    }
  ]
}
```

### Status values

| `status` | Meaning |
|----------|---------|
| `ok` | Fresh successful aggregate |
| `no_data` | Source read succeeded but no usage rows exist in the selected window |
| `stale` | Serving last good data after a later failure |
| `unavailable` | No credentials / no usage API for this provider |
| `error` | Configured but request failed |

## Cached response

Second call within 60s:

```json
{
  "window": "today",
  "generated_at": "2026-08-08T05:12:34.000Z",
  "cache": { "hit": true, "ttl_seconds": 60 },
  "providers": [ "...same as before..." ]
}
```

## Errors

### 401 Unauthorized

```json
{ "error": "unauthorized" }
```

### 400 Bad window

```json
{
  "error": "bad_request",
  "message": "Invalid window \"nope\". Use today, 7d, or 30d."
}
```

### 503 Misconfigured server

```json
{
  "error": "misconfigured",
  "message": "DEVICE_TOKEN is not set on the server"
}
```

## curl

```bash
curl -sS \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  "http://127.0.0.1:8787/api/ai-usage?window=today"
```

## Privacy

The JSON contains counts, cost, plan label, quota percentage, and reset time
only. It never includes prompts, completions, file contents, email addresses,
OAuth tokens, API keys, or other credential data.
