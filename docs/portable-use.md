# Standalone and portable use

After the firmware has been uploaded, the ESP32-2432S028 does not need to stay
connected to a computer. A computer is only needed later when changing or
re-uploading firmware.

## Recommended portable power

For the first portable build, use a normal power bank rather than assembling a
Li-ion battery circuit:

- 10,000mAh power bank for a compact build; 20,000mAh for longer runtime
- regulated USB output at 5V, rated for at least 1A; 2A gives useful headroom
- USB-C output, or USB-A output with a USB-A-to-USB-C cable
- low-current mode or always-on mode if available
- short 25–50cm USB-C cable
- optional inline USB 5V on/off switch

The board's product specification states 5V operation and about 115mA
consumption. As a rough estimate, a 10,000mAh power bank may run the display
for approximately 30–50 hours; Wi-Fi activity, brightness, battery quality,
and conversion losses change the actual result.

Some power banks disconnect small loads automatically. Xiaomi documents a
low-current mode for devices such as earbuds and other low-power electronics;
use that mode if the power bank turns off while the display is running. See
the [Xiaomi low-current mode documentation](https://www.mi.com/uk/product/xiaomi-power-bank-10000mah-22w-lite/overview/).

## First standalone test

1. Upload and verify the firmware while connected to the computer.
2. Disconnect the USB cable from the computer.
3. Connect the board's USB-C port to the power bank.
4. Wait for the display to connect to Wi-Fi and show `ONLINE`.
5. Confirm that the backend is reachable before putting the board in a case.

The board can be powered through its USB-C port. The ESP32 development-kit
documentation also describes USB power and 5V/GND power headers; do not feed
raw battery voltage into the board's 5V input. See
[Espressif's development-kit power documentation](https://documentation.espressif.com/api/resource/path/docs/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html).

## DIY battery option

Only use a DIY battery pack when a fixed enclosure is needed. The circuit must
include:

- a protected single-cell Li-ion/LiPo battery
- a charger with overcharge and over-discharge protection
- a regulated 5V boost converter rated for at least 1A
- a power switch and insulated wiring

Do not connect a 3.7–4.2V cell directly to the board's USB-C port or 5V pin.
A TP4056 charging board by itself is not a 5V boost converter. Buy a module
that explicitly combines charging/protection with a regulated 5V output, and
verify its output with a multimeter before connecting the board.

## Adding buttons and other modules

For page switching, use the wiring in
[physical-buttons.md](physical-buttons.md): the first recommended button is
`GPIO27` to `GND` using `INPUT_PULLUP`.

For experiments, also keep a Dupont jumper kit, a 400-point breadboard, and
10kΩ resistors. Use the supplied small expansion cable with the board; a
standard 2.54mm Dupont housing should not be forced directly into the board's
small 1.25mm connector.

For a permanent portable unit, use a 3D-printed or acrylic enclosure made for
the exact ESP32-2432S028 variant. Measure the board and connector position
first because similar-looking CYD enclosures are not always interchangeable.

## Wi-Fi and backend limits

Powering the board away from a computer does not make the backend portable.
The current firmware connects to the configured Wi-Fi network and requests the
backend URL from `secrets.h`.

- At home: connect the board to the same LAN as the Docker backend.
- On a phone hotspot: the board can connect to the hotspot, but the backend at
  the home LAN address will normally be unreachable.
- Outside the home: use a private VPN or deploy the backend to a secured host;
  do not expose port 3000 directly to the public internet.

If the backend cannot be reached, the firmware keeps the last successful values
and displays `OFFLINE`; this is expected behavior.
