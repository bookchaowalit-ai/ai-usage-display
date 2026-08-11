# Backend setup

## Requirements

- Node.js 20+
- Node.js 22+ recommended when using Solo Empire SQLite via built-in `node:sqlite`
- Network access to provider Admin Usage APIs (if using `USAGE_SOURCE=providers` or `hybrid`)
- Signed-in Claude Code, Codex, Grok, Kimi Code, and Antigravity CLI sessions for subscription quota percentage

## Install

```bash
cd backend
cp .env.example .env
# edit .env — at minimum set DEVICE_TOKEN
npm install
```

Generate a device token:

```bash
openssl rand -hex 32
```

## Run (development)

```bash
npm run dev
```

Server defaults to `http://0.0.0.0:8787`.

## Run (production)

```bash
npm run build
npm start
```

## Smoke test

```bash
export DEVICE_TOKEN='your-token'
curl -sS -H "Authorization: Bearer $DEVICE_TOKEN" \
  "http://127.0.0.1:8787/api/ai-usage?window=today" | jq .
```

Health check (no auth):

```bash
curl -sS http://127.0.0.1:8787/health
```

## Tests

```bash
npm test
npm run typecheck
```

## LAN access for ESP32

1. Run the backend on a machine on the same Wi-Fi as the ESP32.
2. Allow inbound TCP on `PORT` (default 8787) if a firewall is enabled.
3. Point firmware `BACKEND_BASE_URL` at `http://<lan-ip>:8787`.

## Usage sources

| `USAGE_SOURCE` | Behaviour |
|----------------|-----------|
| `providers` | Anthropic + OpenAI + xAI token adapters; Kimi token telemetry remains unavailable |
| `solo_empire` | Read-only telemetry (SQLite or HTTP) only |
| `hybrid` (default) | Providers first; fill `no_data`/`unavailable`/`error` from Solo Empire |

See [solo-empire-integration.md](./solo-empire-integration.md).

Subscription quota is an independent overlay and works even when the telemetry
table is empty. Disable it with `SUBSCRIPTION_USAGE_ENABLED=false` if this
backend is hosted somewhere without your local coding CLIs.

For Gemini quota, authenticate the host with Antigravity CLI and run the
exporter described in [gemini-antigravity.md](./gemini-antigravity.md). The
backend reads the resulting non-secret JSON snapshot; it never receives the
Antigravity login token.

For Claude quota and reset timestamps, run the host exporter described in
[claude-code-quota.md](./claude-code-quota.md). This is recommended when the
backend runs in Docker because the host Claude CLI can have session context
that is not available inside the container.
