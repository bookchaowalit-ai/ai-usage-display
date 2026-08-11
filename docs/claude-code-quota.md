# Claude Code quota and reset timestamps

Claude Code can display reset times in its authenticated host session, but the
same CLI binary may not receive those session details when launched inside
Docker. The host exporter keeps the login on the host and writes only quota
percentages and reset timestamps to a JSON snapshot.

## Manual export

From the ai-usage-display directory:

    node backend/scripts/export-claude-quota.mjs

The default output is:

    ~/.local/share/ai-usage-display/claude-quota.json

The snapshot contains the rolling 5h and weekly windows. It never contains
Claude OAuth tokens, prompts, responses, or session content.

## Automatic refresh

This host has a user-level timer:

    ~/.config/systemd/user/ai-usage-display-claude-quota.service
    ~/.config/systemd/user/ai-usage-display-claude-quota.timer

Inspect it with:

    systemctl --user status ai-usage-display-claude-quota.timer
    systemctl --user start ai-usage-display-claude-quota.service

The timer refreshes every 60 seconds. If the host CLI temporarily returns no
quota rows, the exporter leaves the last valid snapshot in place.

## Docker wiring

docker-compose.env points `QUOTA_HOST_DIR` at the snapshot directory. Compose
mounts that directory read-only as `/data/quota` and sets:

    CLAUDE_QUOTA_PATH=/data/quota/claude-quota.json

The directory mount is intentional: the exporter atomically renames each fresh
JSON file, and an individual file bind mount would keep the old inode.

The ESP32 receives only the quota percentages and ISO reset timestamps through
the authenticated backend API.

## Troubleshooting

- If the API says quota.status: no_data, run the exporter manually and inspect
  its output.
- If the API has quota.status: ok but the screen is old, tap the screen to
  force refresh or wait for the 60-second refresh.
- If the host Claude CLI changes its /usage wording, update the exporter
  parser and add a regression test before changing firmware.
