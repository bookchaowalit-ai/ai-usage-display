# Upgrade plan

## Current state

**Score: 8/10** (7.5 after pass 2, 7 after pass 1, 6 originally). Backend
is small, typed and well-tested (75 Vitest tests, typecheck and build pass)
with CI; CLI process handling is now one shared, tested module. The ESP32
firmware still cannot be compiled in CI.

Local checks: `cd backend && npm ci && npm run typecheck && npm test && npm run build`.

## Backlog

### P0
- Compile the firmware in CI with `arduino-cli` (ESP32 core + LVGL +
  TFT_eSPI pinned), using the `*.example` headers copied into place.

### P1
- Finish the provider split: move Claude (OAuth + CLI `/usage` parsing and
  reset-time zone math), Codex and Grok out of `subscription-quotas.ts`
  (630 lines) into their own modules, like `kimi-subscription.ts`.
- Unit tests for `kimi-subscription.ts` refresh/lock path (fake OAuth host
  via a local `http.createServer`, temp credential file).

### P2
- Add a Dockerfile build job to CI (`docker build backend`).
- Expose cache hit/stale counters on `/ready` for the display's
  diagnostics screen.

## Done in this pass (pass 3)
- `subscription-quotas.ts` split (1228 -> 630 lines): `cli.ts` (process
  runner + JSON-RPC session + `sanitizeMessage`), `cli-resolve.ts` (CLI
  discovery), `quota-math.ts` (shared window/number helpers),
  `kimi-subscription.ts` (Kimi OAuth/usage). Public exports unchanged.
- `runCommand` and `runJsonRpcProcess` share one supervisor (timeout,
  stderr cap, spawn error, single settle). Bug fixed: `runCommand` resolved
  on `exit`, which can drop the tail of stdout; it now resolves on `close`.
  Non-zero exits now include redacted stderr; stdout is hard-capped at
  1 MiB; a throwing JSON-RPC start callback no longer leaks the child.
- `tests/cli.test.ts` (9 tests, fake executables): burst-then-exit output,
  output cap, stderr redaction, timeout, ENOENT, start-callback failure,
  JWT redaction, CLI resolution via config and PATH.

## Done in pass 2
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
