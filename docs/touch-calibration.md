# Touch calibration (XPT2046)

The ESP32-2432S028 uses a resistive **XPT2046** touch controller on a separate SPI bus.

## Pins

| Signal | GPIO |
|--------|------|
| CLK | 25 |
| CS | 33 |
| MOSI | 32 |
| MISO | 39 |
| IRQ | 36 |

## Defaults

`config.h` maps raw ADC points to screen coordinates:

```cpp
#define TOUCH_MAP_X1  200
#define TOUCH_MAP_X2  3700
#define TOUCH_MAP_Y1  240
#define TOUCH_MAP_Y2  3800
#define TOUCH_SWAP_XY 0
#define TOUCH_INVERT_X 0
#define TOUCH_INVERT_Y 0
```

## Calibration procedure

1. Temporarily add a sketch loop that prints raw points:

   ```cpp
   if (touch.touched()) {
     TS_Point p = touch.getPoint();
     Serial.printf("raw x=%d y=%d\n", p.x, p.y);
     delay(200);
   }
   ```

2. Touch each screen corner and record min/max raw X and Y.
3. Update `TOUCH_MAP_X1/X2` and `TOUCH_MAP_Y1/Y2` in `config.h`.
4. If axes are swapped relative to the display rotation, set `TOUCH_SWAP_XY 1`.
5. If a single axis is mirrored, set `TOUCH_INVERT_X` or `TOUCH_INVERT_Y` to `1`.
6. Re-flash and verify that a tap still triggers a usage refresh.

## Rotation

Firmware uses landscape (`setRotation(1)`). Recalibrate after changing rotation.

## Note

Touch is optional for the core product loop (auto-refresh every 60s). Calibration
only affects manual refresh-on-tap.
