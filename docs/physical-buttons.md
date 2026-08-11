# Physical buttons / keycaps

The ESP32-2432S028 can use an external push button or mechanical keycap to
switch display pages. The touch screen remains available for force refresh.

## Recommended parts

For the smallest prototype, buy:

- `Kailh Choc V1 / PG1350` momentary mechanical switch
- `Choc V1 1U` keycap
- one-key switch breakout board, or two short jumper wires
- the supplied 4-pin expansion cable

Use a keycap designed for the same switch family. Choc V1 keycaps are not the
same as standard Cherry-MX keycaps. See the [Choc V1 keycap compatibility
guide](https://docs.slicemk.com/keyboard/ergodox/keycap/choc-v1/) or this
[low-profile Choc keycap example on Shopee](https://shopee.co.th/50pcs-Low-Profile-Choc-Keycaps-PBT-Keycaps-for-Kailh-1350-Choc-Switches-Mechanical-Keyboard-Ultra-Thin-Black-White-Trans-i.1055836268.25438750006).

If appearance is not important, a `3.3V momentary push-button module` is the
easiest first test. Do not buy a latching `push-on/push-off` power button for
page switching.

## Recommended wiring

Use the second expansion connector, IO2:

```text
ESP32 expansion IO2

GPIO27  ───────── one electrical contact on the switch
GND     ───────── the other electrical contact on the switch
```

The firmware uses the internal pull-up, so the button is active-low:

```cpp
pinMode(27, INPUT_PULLUP);
// pressed = digitalRead(27) == LOW
```

Do not connect 5V to GPIO27. A bare mechanical switch only needs the two
electrical contacts; any additional legs on a 3/5-pin switch are mechanical
support legs or optional LED contacts.

The board's supplied expansion cable uses the board's small 1.25mm connector.
Do not force a normal 2.54mm Dupont housing directly into the board socket.

## Other exposed pins

The board diagram labels the expansion headers as:

| Header | Pin | Notes |
|--------|-----|-------|
| IO2 | GPIO27 | Recommended first button input |
| IO2 | GND | Button return |
| IO2 | 3.3V | Power for a compatible button module only |
| IO1 | GPIO35 | Input-only; needs an external pull-up resistor |
| IO1/IO2 | GPIO22 | I2C SCL; reserve for future expansion |
| IO1 | GPIO21 | TFT backlight in this project; do not reuse |

GPIO35 is not a good first choice because ESP32 GPIO34–39 are input-only and
do not have internal pull-up/pull-down circuitry. If a second button is added
there, use an external 10kΩ pull-up to 3.3V and connect the button to GND.
See [Espressif's ESP32 pin reference](https://www.espressif.com/sites/default/files/1a-esp32_pin_list_en-v0.1.pdf).

Avoid GPIO21, GPIO22, the TFT pins, and the XPT2046 touch pins because they are
already assigned in [the firmware sketch](../firmware/esp32-lvgl/esp32-lvgl.ino).

## Planned page behavior

The intended button behavior is:

1. short press: cycle `Quota` → `Usage` → `Cost/Reset`
2. touch: force refresh the current page
3. backend failure: keep the last successful page data and show `OFFLINE`

The current flashed firmware already supports touch-to-refresh. The physical
button page-cycle behavior should be enabled in the next firmware change after
the switch wiring is confirmed.
