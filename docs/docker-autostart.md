# Docker background service

The backend can run as a Docker Compose service and restart automatically when
the Docker daemon starts after a machine reboot.

## One-time setup

From the `ai-usage-display/` directory:

```bash
cp docker-compose.env.example docker-compose.env
# edit docker-compose.env only if the host paths or UID/GID differ

docker compose --env-file docker-compose.env build
docker compose --env-file docker-compose.env up -d
docker compose --env-file docker-compose.env ps
```

`backend/.env` remains the source for `DEVICE_TOKEN`, port settings, and
optional provider admin keys. It is not copied into the Docker image.

The Compose service mounts the already-authenticated local sessions for
Codex, Grok, and Kimi. Grok and Kimi quota snapshots are refreshed on the host
and mounted read-only; Codex keeps the direct App Server fallback because its
host App Server may require a graphical/session context. Kimi's credential file
is writable because its short-lived OAuth token may rotate; the container runs
with the host UID/GID so the host Kimi Code process can continue to read the
file. Solo Empire's
database is mounted read-only at `/data/solo-empire.db`. Gemini is different:
the host-side Antigravity exporter writes only a quota snapshot, mounted
read-only at `/data/quota/gemini-quota.json`; no Antigravity token is mounted into
the container. Claude uses the same pattern for its quota/reset snapshot at
`/data/quota/claude-quota.json`. All quota snapshots are mounted through the
parent directory, so atomic exporter renames are visible to Docker without
recreating the container. The host exporters write only percentages and reset
timestamps; no provider token is copied into Docker or firmware.

Compose pins DNS to Cloudflare and Google resolvers. This avoids a Docker
bridge DNS failure when the host is using WARP/Tailscale DNS after a reboot;
the backend still uses the host network only for the published LAN port.

Set up Gemini once before starting Compose:

    agy
    node backend/scripts/export-gemini-quota.mjs

Keep the exporter refreshed every minute with the user systemd timer described
in [gemini-antigravity.md](./gemini-antigravity.md). If the machine must
refresh it before a graphical login, enable user lingering with

    sudo loginctl enable-linger "$USER"

Claude's exporter and timer are documented in
[claude-code-quota.md](./claude-code-quota.md).

Grok and Kimi exporters are run by the same user-level systemd pattern:

    node backend/scripts/export-grok-quota.mjs
    node backend/scripts/export-kimi-quota.mjs

Their snapshots are `~/.local/share/ai-usage-display/grok-quota.json` and
`kimi-quota.json`. Codex also has an exporter, but this host's App Server timed
out during validation, so Compose keeps the working direct CLI path until a
host Codex session is available.

The host also runs `ai-usage-display-recovery.timer`. It performs the same
health/readiness/authenticated API smoke check 120 seconds after user-systemd
startup and every five minutes afterward. Inspect its result with:

    systemctl --user status ai-usage-display-recovery.timer
    journalctl --user -u ai-usage-display-recovery.service -n 30 --no-pager

## Start automatically after reboot

Enable Docker once:

```bash
sudo systemctl enable --now docker
```

The service has `restart: unless-stopped`, so Docker starts it again after a
reboot. Check it with:

```bash
docker compose --env-file docker-compose.env ps
docker compose --env-file docker-compose.env logs -f --tail=100
curl -sS http://127.0.0.1:3000/health
# Deep post-reboot check (does not print the device token)
npm --prefix backend run smoke:recovery
```

The ESP32 continues using the same URL:

```text
http://<LAN-IP-of-this-machine>:3000
```

## Updating the backend

After source changes:

```bash
docker compose --env-file docker-compose.env up -d --build
```

Do not run `npm run dev` on port 3000 at the same time as the container.

After a power loss, check liveness first. If `/health` is healthy but `/ready`
returns HTTP 503, inspect the provider exporter timers and snapshot status:

```bash
curl -sS http://127.0.0.1:3000/ready | jq .
systemctl --user list-timers 'ai-usage-display-*'
```
