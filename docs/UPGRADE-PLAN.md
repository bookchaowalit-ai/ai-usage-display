# Upgrade plan

## Current state

**Score: 7.5/10** (was 7/10 after pass 1, 6/10 originally). Backend is small, typed and well-tested
(54 Vitest tests, typecheck and build pass) and now has CI. The ESP32
firmware cannot be compiled in CI yet, and the 1.2k-line
`subscription-quotas.ts` adapter carries most of the risk.

Local checks: `cd backend && npm ci && npm run typecheck && npm test && npm run build`.

## Backlog

### P0
- Compile the firmware in CI with `arduino-cli` (ESP32 core + LVGL +
  TFT_eSPI pinned), using the `*.example` headers copied into place.

### P1
- Split `backend/src/adapters/subscription-quotas.ts` per provider
  (claude/codex/grok/kimi/gemini modules + shared `cli.ts` spawn helpers);
  `tests/cli-probes.test.ts` now pins the spawn behavior for the refactor.
- `runCommand` (Claude CLI) and `runJsonRpcProcess` duplicate spawn/timeout
  logic; unify them once split.

### P2
- Add a Dockerfile build job to CI (`docker build backend`).
- Expose cache hit/stale counters on `/ready` for the display's
  diagnostics screen.

## Done in this pass (pass 2)
- Bug: a Codex/Grok CLI that exited 0 without replying left the quota
  probe hanging until the timeout; it now fails immediately. Replies written
  just before exit are still read (`close` instead of `exit`), and a stdin
  EPIPE can no longer surface as an uncaught stream error.
- 11 fake-executable tests (`tests/cli-probes.test.ts`): Codex/Grok JSON-RPC
  happy paths, non-JSON noise, RPC errors, timeout, clean/early exit,
  non-zero exit with bearer token redacted, missing binary, Claude CLI
  fallback/garbage/hang with no credentials.
- `/api/ai-usage` 500 and `/ready` 503 no longer echo raw error text
  (paths, upstream bodies); details go to the server log. Test added.
- docs/security.md documents the unauthenticated `/health` and `/ready`.

## Done in pass 1 (2026-09-30)
- Fixed a remote crash: a request with a malformed `Host` header (for
  example `Host: bad host`) made `new URL()` throw inside the HTTP request
  listener, an uncaught exception that terminated the process. URLs are now
  parsed against a fixed base; regression test in `tests/server.test.ts`
  drives a real socket.
- Device-token comparison uses SHA-256 + `crypto.timingSafeEqual`
  instead of a hand-rolled loop; extra auth tests.
- Added `.github/workflows/backend-ci.yml` (typecheck, test, build, script
  syntax check, and a guard against committing `firmware/**/secrets.h`).
