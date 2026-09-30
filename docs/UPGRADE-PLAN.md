# Upgrade plan

## Current state

**Score: 7/10** (was 6/10). Backend is small, typed and well-tested
(54 Vitest tests, typecheck and build pass) and now has CI. The ESP32
firmware cannot be compiled in CI yet, and the 1.2k-line
`subscription-quotas.ts` adapter carries most of the risk.

Local checks: `cd backend && npm ci && npm run typecheck && npm test && npm run build`.

## Backlog

### P0
- Compile the firmware in CI with `arduino-cli` (ESP32 core + LVGL +
  TFT_eSPI pinned), using the `*.example` headers copied into place.

### P1
- Split `backend/src/adapters/subscription-quotas.ts` per provider and add
  tests for the CLI-spawn paths (timeouts, non-JSON stdout, missing binary)
  with a fake executable.
- The 500 response in `routes/ai-usage.ts` returns `err.message` to the
  device; replace it with a fixed message and log the detail server-side.
- `/ready` and `/health` are unauthenticated; document that the service
  must stay on a trusted LAN or behind a reverse proxy (docs/security.md).

### P2
- Add a Dockerfile build job to CI (`docker build backend`).
- Expose cache hit/stale counters on `/ready` for the display's
  diagnostics screen.

## Done in this pass (2026-09-30)
- Fixed a remote crash: a request with a malformed `Host` header (for
  example `Host: bad host`) made `new URL()` throw inside the HTTP request
  listener, an uncaught exception that terminated the process. URLs are now
  parsed against a fixed base; regression test in `tests/server.test.ts`
  drives a real socket.
- Device-token comparison uses SHA-256 + `crypto.timingSafeEqual`
  instead of a hand-rolled loop; extra auth tests.
- Added `.github/workflows/backend-ci.yml` (typecheck, test, build, script
  syntax check, and a guard against committing `firmware/**/secrets.h`).
