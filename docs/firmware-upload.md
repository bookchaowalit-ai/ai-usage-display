# Firmware upload (Arduino)

## Hardware

- **Board:** ESP32-2432S028 (ESP32 + 2.8" ILI9341 320×240 + XPT2046)
- **Arduino board profile:** *ESP32 Dev Module*

## Install Arduino tooling

1. Install [Arduino IDE 2.x](https://www.arduino.cc/en/software)
2. Boards Manager → install **esp32** by Espressif (`esp32` package)
3. Library Manager → install:
   - **TFT_eSPI** (Bodmer)
   - **XPT2046_Touchscreen** (Paul Stoffregen)
   - **lvgl** (optional, v8.x)
   - **ArduinoJson** (Benoit Blanchon)

CLI alternative (verified with Arduino CLI 1.5.1 and ESP32 core 3.3.11):

```bash
arduino-cli core update-index
arduino-cli core install esp32:esp32@3.3.11
arduino-cli lib install \
  'TFT_eSPI@2.5.43' \
  'XPT2046_Touchscreen@1.4.0' \
  'ArduinoJson@6.21.4' \
  'lvgl@8.3.11'
```

## Configure TFT_eSPI

Copy `firmware/esp32-lvgl/User_Setup.h` over the library's `User_Setup.h`,
typically:

```
~/Arduino/libraries/TFT_eSPI/User_Setup.h
```

Or keep the project copy and replace the library file after each TFT_eSPI update.

Recommended IDE settings:

- Board: **ESP32 Dev Module**
- Upload Speed: **921600** (or 115200 if unstable)
- Flash Size: **4MB**
- PSRAM: disabled unless your module has it

## Local secrets

```bash
cd firmware/esp32-lvgl
cp secrets.h.example secrets.h
cp config.h.example config.h
```

Edit `secrets.h`:

```cpp
#define WIFI_SSID       "home-wifi"
#define WIFI_PASSWORD   "..."
#define BACKEND_BASE_URL  "http://192.168.1.50:8787"
#define DEVICE_TOKEN      "same-as-backend-DEVICE_TOKEN"
```

## Upload

1. Connect USB-C / micro-USB to the ESP32
2. Select the correct serial port
3. Open `esp32-lvgl.ino`
4. **Sketch → Upload**

Open Serial Monitor at **115200** baud for Wi-Fi / HTTP debug lines.

With Arduino CLI, the project folder and sketch filename must match
(`firmware/esp32-lvgl/esp32-lvgl.ino`):

```bash
arduino-cli compile \
  --fqbn esp32:esp32:esp32 \
  firmware/esp32-lvgl

arduino-cli upload \
  --fqbn esp32:esp32:esp32 \
  --port /dev/ttyUSB0 \
  firmware/esp32-lvgl
```

Replace `/dev/ttyUSB0` with the port reported by `arduino-cli board list`.

## Verify

1. Backend running on the LAN IP in `BACKEND_BASE_URL`
2. Screen shows a 3×2 page: CODEX SPARK / CODEX / GROK / KIMI / GEMINI / STATUS
3. Each provider card shows separate `5H` and `WEEK` percentages plus reset date/time
4. Header **ONLINE** when fetch succeeds
5. Disconnect backend → numbers freeze, header **OFFLINE**
6. Tap screen → force refresh

If the ESP32 connects to Wi-Fi but reports `HTTP status=-1`, allow the backend
port through the host firewall for the board's current LAN IP. Keep this rule
limited to the board rather than opening the port to the whole network:

```bash
sudo ufw allow from <esp32-lan-ip> to any port 3000 proto tcp \
  comment 'ai-usage-display ESP32'
```

Use the actual `PORT` from `backend/.env` when it is not `3000`.

## Common issues

| Symptom | Fix |
|---------|-----|
| White / blank screen | Check TFT pins in `User_Setup.h`, backlight GPIO 21 |
| Colors wrong / inverted | Try `tft.setRotation(1)` or `3` |
| Wi-Fi fails | 2.4 GHz SSID only; check password |
| HTTP 401 | `DEVICE_TOKEN` mismatch |
| HTTP connection failed | Backend host/firewall; use LAN IP not `localhost` |
