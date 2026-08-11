# Firmware — ESP32-2432S028 + LVGL

Arduino sketch for the **ESP32-2432S028** 2.8" ILI9341 320×240 touch LCD.

## Security

- The device only talks to **your backend** (`GET /api/ai-usage`).
- Put **only** Wi-Fi credentials, backend URL, and `DEVICE_TOKEN` in `secrets.h`.
- **Never** put Anthropic, OpenAI, xAI, or Kimi credentials in firmware.

## Libraries

| Library | Notes |
|---------|--------|
| TFT_eSPI | Use `User_Setup.h` from this folder |
| XPT2046_Touchscreen | Touch controller |
| lvgl | v8.x optional (`USE_LVGL` if present) |
| ArduinoJson | Parse usage JSON |

## Pins

| Function | GPIO |
|----------|------|
| TFT MISO | 12 |
| TFT MOSI | 13 |
| TFT SCLK | 14 |
| TFT CS | 15 |
| TFT DC | 2 |
| TFT RST | -1 |
| Backlight | 21 |
| Touch CLK | 25 |
| Touch CS | 33 |
| Touch MOSI | 32 |
| Touch MISO | 39 |
| Touch IRQ | 36 |

## Setup

```bash
cp secrets.h.example secrets.h
cp config.h.example config.h
# edit secrets.h
```

See [../../docs/firmware-upload.md](../../docs/firmware-upload.md) and
[../../docs/touch-calibration.md](../../docs/touch-calibration.md).

For an external button/keycap, see
[../../docs/physical-buttons.md](../../docs/physical-buttons.md). The
recommended first input is GPIO27 to GND using `INPUT_PULLUP`; the current
firmware reserves this wiring plan while touch remains the force-refresh
control.

For battery-powered standalone use, see
[../../docs/portable-use.md](../../docs/portable-use.md). After flashing, the
board can run from a 5V USB power bank without a computer.

## UI

One-page 3×2 layout: **CLAUDE**, **CODEX**, **GROK**, **KIMI**, **GEMINI**, and
a compact **STATUS** tile. Gemini quota is supplied by the host-side
Antigravity bridge when its snapshot is available; otherwise the display shows -- and does not invent values.

Each card shows:

- separate remaining percentages for the rolling `5h` and `week` windows
- reset date and time for both windows, in the configured timezone
- weekly reset text turns red within 1 day and orange within 3 days; the
  frequent 5h reset remains neutral
- live/offline status without the larger token/cost diagnostic fields
- stale quota snapshots keep their last known percentages and reset times, with
  an orange card border instead of being replaced by `--`

The backend still returns token/cost telemetry for diagnostics, but the 320×240
screen prioritizes both subscription windows so you can use the allowance
before either one resets. A provider that does not expose one of the windows
shows `--%` for that window instead of inventing a value.

Header shows **ONLINE** / **OFFLINE**. On backend failure the last successful
numbers remain on screen with OFFLINE status. Refresh every 60 seconds; tap
the screen to force a refresh.
