# Environment variables

Copy `backend/.env.example` → `backend/.env`. **Never commit real secrets.**

## Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `DEVICE_TOKEN` | *(required)* | Shared secret for ESP32 / clients |
| `CACHE_TTL_SECONDS` | `60` | Response cache TTL |
| `STALE_MAX_AGE_SECONDS` | `3600` | Max age for serving last-good data as `stale` |
| `USAGE_SOURCE` | `hybrid` | `providers` \| `solo_empire` \| `hybrid` |

## Local subscription quota

These settings add paid-plan remaining percentage and reset time to every
provider row. They do not replace the token/cost source selected by
`USAGE_SOURCE`.

| Variable | Default | Description |
|----------|---------|-------------|
| `SUBSCRIPTION_USAGE_ENABLED` | `true` | Read quota from authenticated local provider CLIs |
| `SUBSCRIPTION_USAGE_TIMEOUT_MS` | `15000` | Per-provider CLI timeout |
| `QUOTA_SNAPSHOT_MAX_AGE_SECONDS` | `300` | Maximum host snapshot age before status becomes `stale` |
| `CLAUDE_CLI_PATH` | auto | Optional Claude executable override |
| `CODEX_CLI_PATH` | auto | Optional Codex executable override |
| `CODEX_QUOTA_PATH` | *(empty)* | Optional read-only host Codex quota snapshot |
| `GROK_CLI_PATH` | auto | Optional Grok executable override |
| `GROK_QUOTA_PATH` | *(empty)* | Optional read-only host Grok quota snapshot |
| `CLAUDE_CREDENTIALS_PATH` | `~/.claude/.credentials.json` | Claude OAuth credential file read locally; never returned by the API |
| `CLAUDE_QUOTA_PATH` | *(empty)* | Read-only JSON snapshot exported by the authenticated host Claude CLI |
| `KIMI_CODE_HOME` | `~/.kimi-code` | Kimi Code shared home used to resolve the credential file |
| `KIMI_CREDENTIALS_PATH` | `$KIMI_CODE_HOME/credentials/kimi-code.json` | Optional Kimi OAuth credential file override |
| `KIMI_QUOTA_PATH` | *(empty)* | Optional read-only host Kimi quota snapshot |
| `KIMI_USAGE_BASE_URL` | `https://api.kimi.com/coding/v1` | Kimi managed usage endpoint base |
| `KIMI_OAUTH_HOST` | `https://auth.kimi.com` | Kimi OAuth refresh host |
| `GEMINI_QUOTA_PATH` | *(empty)* | Read-only JSON snapshot exported by the authenticated Antigravity CLI |

Auto-discovery checks `PATH`, current VS Code/VS Code Insiders provider
extensions, and `~/.grok/bin/grok`. The local account must already be signed in.

- Claude: `/usage` plus the authenticated Claude Code usage response.
- Codex: App Server `account/rateLimits/read`.
- Grok: ACP billing extension used by `/usage`.
- Kimi Code: managed `/usages` endpoint (weekly + rolling 5-hour quota).
- Gemini: host-side Antigravity `/usage` export (weekly + rolling 5-hour quota).

Kimi access tokens are short-lived. The backend refreshes them with Kimi's
local refresh token and atomically updates Kimi's own credential file under the
same lock convention used by Kimi Code. Tokens are never returned by this API.

Claude and Grok quota transports are tied to their installed CLI versions and
may change upstream. Failures produce an honest quota status instead of a
guessed percentage.

Gemini is intentionally different: Antigravity authentication stays on the
host keyring. A host exporter writes only percentages and reset timestamps to
`GEMINI_QUOTA_PATH`; the Docker backend mounts that JSON read-only. See
[gemini-antigravity.md](./gemini-antigravity.md).

Claude and Gemini use host-side quota snapshots when Docker cannot reproduce
the host CLI session context. The exporters write only percentages and reset
timestamps; Docker mounts the JSON files read-only. See
[claude-code-quota.md](./claude-code-quota.md) and
[gemini-antigravity.md](./gemini-antigravity.md).

Docker mounts the quota snapshot directory rather than individual files. This
is required because exporters atomically rename refreshed JSON files; mounting
individual files would leave Docker reading the old inode.

`GET /health` is a liveness check and does not require the device token.
`GET /ready` is a deeper cached check and returns HTTP 200 only when all five
quota bridges are `ok`. An old exporter snapshot becomes `stale` and makes
`/ready` return HTTP 503. The recovery smoke command checks both endpoints and
the authenticated usage endpoint.

## Anthropic (Claude card)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_ADMIN_API_KEY` | Admin API key or OAuth token for Usage Report |
| `ANTHROPIC_USAGE_BASE_URL` | Default `https://api.anthropic.com` |

Uses `GET /v1/organizations/usage_report/messages`.

## OpenAI / Codex card

| Variable | Description |
|----------|-------------|
| `OPENAI_ADMIN_API_KEY` | **Admin** organization key (not a project key) |
| `OPENAI_USAGE_BASE_URL` | Default `https://api.openai.com` |

Uses:

- `GET /v1/organization/usage/completions`
- `GET /v1/organization/costs`

## xAI / Grok card

| Variable | Description |
|----------|-------------|
| `XAI_API_KEY` | xAI API key |
| `XAI_USAGE_BASE_URL` | Default `https://api.x.ai` |
| `XAI_USAGE_ENABLED` | `false` by default — set `true` only when a usage endpoint works |
| `XAI_USAGE_PATH` | Default `/v1/usage` |

If usage is not enabled or not available, the Grok card status is `unavailable`
(honest empty state). Hybrid mode can still fill from Solo Empire telemetry.

## Solo Empire (read-only)

| Variable | Description |
|----------|-------------|
| `SOLO_EMPIRE_DB_PATH` | Path to `solo-empire.db` (opened read-only via Node `node:sqlite`) |
| `SOLO_EMPIRE_USAGE_API_URL` | Optional HTTP adapter URL |
| `SOLO_EMPIRE_USAGE_API_TOKEN` | Optional Bearer for that URL |

When both API URL and DB path are set, **API URL wins**.

### Example path from this nested repo

From `ai-usage-display/backend/`, a typical relative path into Solo Empire is
deep; prefer an absolute path:

```bash
SOLO_EMPIRE_DB_PATH=/home/you/book/solo-empire/infra/database/solo-empire.db
```

## What must never appear in env

- Prompt text, completion text, chat logs
- Personal user content
- Putting provider keys into firmware `secrets.h`
