# Gemini quota via Antigravity CLI

Antigravity exposes the signed-in Gemini subscription quota through its
interactive /usage command. The display backend uses a small host-side
bridge because the Antigravity login is stored in the host session/keyring and
must not be copied into Docker or firmware.

## Install and sign in

Install the official CLI and sign in once:

    curl -fsSL https://antigravity.google/cli/install.sh | bash
    agy

The official CLI documentation is at
https://antigravity.google/docs/cli-install.
The CLI must be able to run this command successfully:

    agy -p '/usage' --output-format text

The exporter extracts only the Gemini weekly and rolling five-hour rows. It
writes percentages and reset timestamps, never access tokens:

    node backend/scripts/export-gemini-quota.mjs

Default output:

    ~/.local/share/ai-usage-display/gemini-quota.json

## Automatic refresh

This setup uses these user-level units on the host:

    ~/.config/systemd/user/ai-usage-display-gemini-quota.service
    ~/.config/systemd/user/ai-usage-display-gemini-quota.timer

Enable and inspect them:

    systemctl --user daemon-reload
    systemctl --user enable --now ai-usage-display-gemini-quota.timer
    systemctl --user status ai-usage-display-gemini-quota.timer
    systemctl --user start ai-usage-display-gemini-quota.service

For refresh after reboot before an interactive login:

    sudo loginctl enable-linger "$USER"

The timer runs every 60 seconds. If Antigravity is logged out or unavailable,
the exporter reports the failure in the systemd journal; the backend can
continue showing the last valid quota according to its normal cache/stale
behavior.

## Docker wiring

Set `QUOTA_HOST_DIR` in docker-compose.env to the exporter directory:

    QUOTA_HOST_DIR=/home/you/.local/share/ai-usage-display

Compose mounts that directory as `/data/quota:ro` and sets:

    GEMINI_QUOTA_PATH=/data/quota/gemini-quota.json

The directory mount is intentional: the exporter atomically renames refreshed
JSON files, and an individual file bind mount would keep the old inode.

The ESP32 receives only the resulting remaining_percent values and
resets_at timestamps through the authenticated backend API.

## Troubleshooting

- You are not logged into Antigravity: run agy, complete Google sign-in, then
  run the exporter again.
- agy returned no Gemini quota windows: inspect agy -p '/usage'
  --output-format text; the CLI output format may have changed.
- Docker shows Gemini quota snapshot not found: check `QUOTA_HOST_DIR`, run the
  exporter manually, and check the mounted `/data/quota` directory.
- The card shows --: check the API providers[].quota.status and the
  exporter/timer journal before changing firmware.
