/**
 * AI Usage Display — ESP32-2432S028 (ILI9341 320x240 + XPT2046)
 *
 * Pulls aggregated usage JSON from the local backend only.
 * NEVER store provider API keys on the device.
 *
 * Libraries (Arduino Library Manager):
 *   - TFT_eSPI (configure User_Setup.h from this folder)
 *   - XPT2046_Touchscreen
 *   - lvgl (v8.x recommended)
 *   - ArduinoJson
 *   - WiFi (built-in ESP32)
 *   - HTTPClient (built-in ESP32)
 *
 * Board: ESP32 Dev Module
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>
#include <ArduinoJson.h>

// Optional LVGL — if missing at compile time, a TFT_eSPI fallback UI is used.
#if __has_include(<lvgl.h>)
#include <lvgl.h>
#define USE_LVGL 1
#else
#define USE_LVGL 0
#endif

#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "secrets.h missing — copy secrets.h.example to secrets.h"
#define WIFI_SSID "changeme"
#define WIFI_PASSWORD "changeme"
#define BACKEND_BASE_URL "http://192.168.1.50:8787"
#define DEVICE_TOKEN "changeme"
#endif

#if __has_include("config.h")
#include "config.h"
#else
// Defaults when config.h is not present (copy config.h.example → config.h)
#define USAGE_REFRESH_MS          60000UL
#define HTTP_TIMEOUT_MS           12000
#define SCREEN_WIDTH              320
#define SCREEN_HEIGHT             240
#define LVGL_TICK_PERIOD_MS       5
#define DEBUG_SERIAL              1
#define TOUCH_MAP_X1              200
#define TOUCH_MAP_X2              3700
#define TOUCH_MAP_Y1              240
#define TOUCH_MAP_Y2              3800
#define TOUCH_SWAP_XY             0
#define TOUCH_INVERT_X            0
#define TOUCH_INVERT_Y            0
#define TIMEZONE_OFFSET_MINUTES   420
#endif

#ifndef TIMEZONE_OFFSET_MINUTES
#define TIMEZONE_OFFSET_MINUTES   420
#endif

#ifndef WEEKLY_RESET_WARNING_DAYS
#define WEEKLY_RESET_WARNING_DAYS 1
#endif

#ifndef WEEKLY_RESET_NOTICE_DAYS
#define WEEKLY_RESET_NOTICE_DAYS   3
#endif

// ---- Pins (project spec) ----
// TFT: MISO 12, MOSI 13, SCLK 14, CS 15, DC 2, RST -1, BL 21  (User_Setup.h)
// Touch: CLK 25, CS 33, MOSI 32, MISO 39, IRQ 36
static const int TOUCH_CLK = 25;
static const int TOUCH_CS = 33;
static const int TOUCH_MOSI = 32;
static const int TOUCH_MISO = 39;
static const int TOUCH_IRQ = 36;

TFT_eSPI tft = TFT_eSPI();
// Keep touch on a separate hardware bus. The TFT uses the default SPI bus
// on GPIO 12/13/14; remapping that same bus to GPIO 25/32/39 breaks the LCD.
SPIClass touchSpi = SPIClass(HSPI);
XPT2046_Touchscreen touch(TOUCH_CS, TOUCH_IRQ);

struct ProviderCard {
  const char *title;
  const char *provider_key;
  int requests;
  long input_tokens;
  long output_tokens;
  long total_tokens;
  float cost_usd;
  char status[16];
  char updated_at[32];
  bool has_data;
  float five_hour_remaining_percent;
  char five_hour_resets_at[32];
  bool has_five_hour;
  float weekly_remaining_percent;
  char weekly_resets_at[32];
  bool has_weekly;
  char quota_status[16];
  char plan[20];
  bool has_quota;
};

static const int PROVIDER_COUNT = 5;

ProviderCard cards[PROVIDER_COUNT] = {
  {"CLAUDE", "claude", 0, 0, 0, 0, 0.0f, "---", "-", false, 0.0f, "-", false, 0.0f, "-", false, "unavailable", "-", false},
  {"CODEX", "codex", 0, 0, 0, 0, 0.0f, "---", "-", false, 0.0f, "-", false, 0.0f, "-", false, "unavailable", "-", false},
  {"GROK", "grok", 0, 0, 0, 0, 0.0f, "---", "-", false, 0.0f, "-", false, 0.0f, "-", false, "unavailable", "-", false},
  {"KIMI", "kimi", 0, 0, 0, 0, 0.0f, "---", "-", false, 0.0f, "-", false, 0.0f, "-", false, "unavailable", "-", false},
  {"GEMINI", "gemini", 0, 0, 0, 0, 0.0f, "---", "-", false, 0.0f, "-", false, 0.0f, "-", false, "unavailable", "-", false},
};

bool g_online = false;
bool g_wifi_ok = false;
unsigned long g_last_fetch_ms = 0;
int64_t g_server_now_epoch = 0;
char g_last_error[64] = "";

// ---------- helpers ----------
static bool isLeapYear(int year) {
  return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

static int daysInMonth(int year, int month) {
  static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (month == 2 && isLeapYear(year)) return 29;
  if (month < 1 || month > 12) return 31;
  return days[month - 1];
}

static void formatResetLocal(
  const char *iso,
  char *dateOut,
  size_t dateLen,
  char *timeOut,
  size_t timeLen
) {
  int year = 0, month = 0, day = 0, hour = 0, minute = 0;
  if (!iso || sscanf(iso, "%d-%d-%dT%d:%d", &year, &month, &day, &hour, &minute) != 5) {
    snprintf(dateOut, dateLen, "--/--");
    snprintf(timeOut, timeLen, "--:--");
    return;
  }

  int localMinutes = hour * 60 + minute + TIMEZONE_OFFSET_MINUTES;
  while (localMinutes >= 1440) {
    localMinutes -= 1440;
    day++;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }
  }
  while (localMinutes < 0) {
    localMinutes += 1440;
    day--;
    if (day < 1) {
      month--;
      if (month < 1) {
        month = 12;
        year--;
      }
      day = daysInMonth(year, month);
    }
  }

  snprintf(dateOut, dateLen, "%02d/%02d", day, month);
  snprintf(timeOut, timeLen, "%02d:%02d", localMinutes / 60, localMinutes % 60);
}

// Parse the backend's UTC ISO timestamp without depending on the ESP32 local
// timezone or NTP state. This lets the display compare reset dates reliably.
static int64_t daysFromCivil(int year, unsigned month, unsigned day) {
  year -= month <= 2;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yearOfEra = static_cast<unsigned>(year - era * 400);
  const unsigned monthPrime = static_cast<unsigned>(
    static_cast<int>(month) + (month > 2 ? -3 : 9)
  );
  const unsigned dayOfYear = (153 * monthPrime + 2) / 5 + day - 1;
  const unsigned dayOfEra =
    yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear;
  return static_cast<int64_t>(era) * 146097 +
    static_cast<int64_t>(dayOfEra) - 719468;
}

static bool parseIsoUtcEpoch(const char *iso, int64_t &epochOut) {
  int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
  const int fields = sscanf(
    iso ? iso : "",
    "%d-%d-%dT%d:%d:%d",
    &year,
    &month,
    &day,
    &hour,
    &minute,
    &second
  );
  if (fields < 5 ||
      month < 1 || month > 12 ||
      day < 1 || day > daysInMonth(year, month) ||
      hour < 0 || hour > 23 ||
      minute < 0 || minute > 59 ||
      second < 0 || second > 59) {
    return false;
  }
  epochOut = daysFromCivil(year, static_cast<unsigned>(month), static_cast<unsigned>(day)) *
    86400 + hour * 3600 + minute * 60 + second;
  return true;
}

static uint16_t weeklyResetTextColor(const char *iso) {
  if (g_server_now_epoch <= 0) return TFT_LIGHTGREY;
  int64_t resetEpoch = 0;
  if (!parseIsoUtcEpoch(iso, resetEpoch)) return TFT_LIGHTGREY;

  const int64_t secondsUntilReset = resetEpoch - g_server_now_epoch;
  const int daysUntilReset = secondsUntilReset <= 0
    ? 0
    : static_cast<int>((secondsUntilReset + 86399) / 86400);
  if (daysUntilReset <= WEEKLY_RESET_WARNING_DAYS) return TFT_RED;
  if (daysUntilReset <= WEEKLY_RESET_NOTICE_DAYS) return TFT_ORANGE;
  return TFT_LIGHTGREY;
}

// ---------- networking ----------
static bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    g_wifi_ok = true;
#if DEBUG_SERIAL
    Serial.print("WiFi already connected IP=");
    Serial.println(WiFi.localIP());
#endif
    return true;
  }
#if DEBUG_SERIAL
  Serial.println("WiFi connecting...");
#endif
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
  }
  g_wifi_ok = WiFi.status() == WL_CONNECTED;
#if DEBUG_SERIAL
  if (g_wifi_ok) {
    Serial.print("WiFi connected IP=");
    Serial.println(WiFi.localIP());
  } else {
    Serial.print("WiFi failed status=");
    Serial.println(static_cast<int>(WiFi.status()));
  }
#endif
  return g_wifi_ok;
}

static bool fetchUsage() {
  if (!ensureWifi()) {
    g_online = false;
    snprintf(g_last_error, sizeof(g_last_error), "WiFi down");
#if DEBUG_SERIAL
    Serial.println("Usage fetch skipped: WiFi down");
#endif
    return false;
  }

  HTTPClient http;
  String url = String(BACKEND_BASE_URL) + "/api/ai-usage?window=today";
#if DEBUG_SERIAL
  Serial.print("Usage GET ");
  Serial.println(url);
#endif
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(url);
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("Accept", "application/json");

  int code = http.GET();
  if (code != 200) {
    g_online = false;
    snprintf(g_last_error, sizeof(g_last_error), "HTTP %d", code);
#if DEBUG_SERIAL
    Serial.print("Usage HTTP status=");
    Serial.println(code);
#endif
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();

#if DEBUG_SERIAL
  Serial.println(payload);
#endif

  // Four providers plus quota windows can exceed 4 KB. Keep the document on
  // heap so the network task stack remains safe.
  DynamicJsonDocument doc(8192);
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    g_online = false;
    snprintf(g_last_error, sizeof(g_last_error), "JSON err");
    return false;
  }

  int64_t generatedEpoch = 0;
  const char *generatedAt = doc["generated_at"] | "";
  if (parseIsoUtcEpoch(generatedAt, generatedEpoch)) {
    g_server_now_epoch = generatedEpoch;
  }

  JsonArray providers = doc["providers"].as<JsonArray>();
  if (providers.isNull()) {
    g_online = false;
    snprintf(g_last_error, sizeof(g_last_error), "no providers");
    return false;
  }

  for (JsonObject p : providers) {
    const char *name = p["provider"] | "";
    for (int i = 0; i < PROVIDER_COUNT; i++) {
      if (strcmp(name, cards[i].provider_key) == 0) {
        cards[i].requests = p["requests"] | 0;
        cards[i].input_tokens = p["input_tokens"] | 0;
        cards[i].output_tokens = p["output_tokens"] | 0;
        cards[i].total_tokens = p["total_tokens"] | 0;
        cards[i].cost_usd = p["cost_usd"] | 0.0f;
        const char *st = p["status"] | "unknown";
        strncpy(cards[i].status, st, sizeof(cards[i].status) - 1);
        cards[i].status[sizeof(cards[i].status) - 1] = '\0';
        const char *upd = p["updated_at"] | "-";
        strncpy(cards[i].updated_at, upd, sizeof(cards[i].updated_at) - 1);
        cards[i].updated_at[sizeof(cards[i].updated_at) - 1] = '\0';
        cards[i].has_data = strcmp(st, "no_data") != 0;

        JsonObject quota = p["quota"].as<JsonObject>();
        cards[i].has_quota = false;
        cards[i].has_five_hour = false;
        cards[i].has_weekly = false;
        cards[i].five_hour_remaining_percent = 0.0f;
        cards[i].weekly_remaining_percent = 0.0f;
        strncpy(cards[i].five_hour_resets_at, "-", sizeof(cards[i].five_hour_resets_at) - 1);
        cards[i].five_hour_resets_at[sizeof(cards[i].five_hour_resets_at) - 1] = '\0';
        strncpy(cards[i].weekly_resets_at, "-", sizeof(cards[i].weekly_resets_at) - 1);
        cards[i].weekly_resets_at[sizeof(cards[i].weekly_resets_at) - 1] = '\0';
        strncpy(cards[i].quota_status, "unavailable", sizeof(cards[i].quota_status) - 1);
        cards[i].quota_status[sizeof(cards[i].quota_status) - 1] = '\0';
        strncpy(cards[i].plan, "-", sizeof(cards[i].plan) - 1);
        cards[i].plan[sizeof(cards[i].plan) - 1] = '\0';
        if (!quota.isNull()) {
          const char *quotaStatus = quota["status"] | "unavailable";
          strncpy(cards[i].quota_status, quotaStatus, sizeof(cards[i].quota_status) - 1);
          cards[i].quota_status[sizeof(cards[i].quota_status) - 1] = '\0';

          const char *plan = quota["plan"] | "-";
          strncpy(cards[i].plan, plan, sizeof(cards[i].plan) - 1);
          cards[i].plan[sizeof(cards[i].plan) - 1] = '\0';

          if (strcmp(quotaStatus, "ok") == 0 || strcmp(quotaStatus, "stale") == 0) {
            JsonArray windows = quota["windows"].as<JsonArray>();
            for (JsonObject window : windows) {
              if (window["remaining_percent"].isNull()) continue;
              const float remaining = window["remaining_percent"].as<float>();
              const int duration = window["duration_minutes"] | 0;
              const char *label = window["label"] | "";
              const char *reset = window["resets_at"] | "-";

              const bool isFiveHour = duration == 300 || strcmp(label, "5h") == 0;
              const bool isWeekly = duration >= 10080 || strcmp(label, "week") == 0;

              if (isFiveHour &&
                  (!cards[i].has_five_hour ||
                   remaining < cards[i].five_hour_remaining_percent)) {
                cards[i].five_hour_remaining_percent = remaining;
                strncpy(
                  cards[i].five_hour_resets_at,
                  reset,
                  sizeof(cards[i].five_hour_resets_at) - 1
                );
                cards[i].five_hour_resets_at[sizeof(cards[i].five_hour_resets_at) - 1] = '\0';
                cards[i].has_five_hour = true;
              }

              if (isWeekly &&
                  (!cards[i].has_weekly ||
                   remaining < cards[i].weekly_remaining_percent)) {
                cards[i].weekly_remaining_percent = remaining;
                strncpy(
                  cards[i].weekly_resets_at,
                  reset,
                  sizeof(cards[i].weekly_resets_at) - 1
                );
                cards[i].weekly_resets_at[sizeof(cards[i].weekly_resets_at) - 1] = '\0';
                cards[i].has_weekly = true;
              }
            }
            cards[i].has_quota = cards[i].has_five_hour || cards[i].has_weekly;
          }
        }
#if DEBUG_SERIAL
        Serial.printf(
          "Quota %s: 5h=%s %.0f%% week=%s %.0f%%\n",
          cards[i].provider_key,
          cards[i].has_five_hour ? "yes" : "no",
          cards[i].five_hour_remaining_percent,
          cards[i].has_weekly ? "yes" : "no",
          cards[i].weekly_remaining_percent
        );
#endif
      }
    }
  }

  g_online = true;
  g_last_error[0] = '\0';
  g_last_fetch_ms = millis();
  return true;
}

// ---------- TFT fallback UI (also used if LVGL not linked) ----------
static uint16_t statusColor(const char *status) {
  if (!status) return TFT_DARKGREY;
  if (strcmp(status, "ok") == 0) return TFT_GREEN;
  if (strcmp(status, "no_data") == 0) return TFT_DARKGREY;
  if (strcmp(status, "stale") == 0) return TFT_ORANGE;
  if (strcmp(status, "unavailable") == 0) return TFT_DARKGREY;
  if (strcmp(status, "error") == 0) return TFT_RED;
  return TFT_YELLOW;
}

static uint16_t cardColor(const ProviderCard &card) {
  if (card.has_quota) {
    float tightest = 101.0f;
    if (card.has_five_hour) tightest = card.five_hour_remaining_percent;
    if (card.has_weekly && card.weekly_remaining_percent < tightest) {
      tightest = card.weekly_remaining_percent;
    }
    if (tightest <= 10.0f) return TFT_RED;
    if (tightest <= 30.0f) return TFT_ORANGE;
    if (strcmp(card.quota_status, "stale") == 0) return TFT_ORANGE;
    return TFT_GREEN;
  }
  return statusColor(card.quota_status);
}

static void drawProviderTile(const ProviderCard &c, int x, int y, int w, int h) {
  const uint16_t border = cardColor(c);
  tft.drawRoundRect(x, y, w, h, 6, border);
  tft.fillRoundRect(x + 1, y + 1, w - 2, 19, 5, border);

  tft.setTextDatum(TC_DATUM);
  tft.setTextColor(TFT_BLACK, border);
  tft.drawString(c.title, x + w / 2, y + 3, 2);

  char line[24];
  char fiveDate[8];
  char fiveTime[8];
  char weekDate[8];
  char weekTime[8];
  formatResetLocal(
    c.has_five_hour ? c.five_hour_resets_at : "-",
    fiveDate,
    sizeof(fiveDate),
    fiveTime,
    sizeof(fiveTime)
  );
  formatResetLocal(
    c.has_weekly ? c.weekly_resets_at : "-",
    weekDate,
    sizeof(weekDate),
    weekTime,
    sizeof(weekTime)
  );

  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  snprintf(
    line,
    sizeof(line),
    c.has_five_hour ? "5H %.0f%%" : "5H --%%",
    c.five_hour_remaining_percent
  );
  tft.drawString(line, x + w / 2, y + 24, 2);

  // The rolling 5h reset is intentionally neutral: it happens every day and
  // should not look like a warning. The weekly reset gets day-level alerts.
  tft.setTextColor(c.has_five_hour ? TFT_LIGHTGREY : TFT_DARKGREY, TFT_BLACK);
  snprintf(
    line,
    sizeof(line),
    c.has_five_hour ? "R %s %s" : "R --/-- --:--",
    fiveDate,
    fiveTime
  );
  tft.drawString(line, x + w / 2, y + 41, 1);

  tft.drawFastHLine(x + 7, y + 52, w - 14, TFT_DARKGREY);

  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  snprintf(
    line,
    sizeof(line),
    c.has_weekly ? "WK %.0f%%" : "WK --%%",
    c.weekly_remaining_percent
  );
  tft.drawString(line, x + w / 2, y + 57, 2);

  tft.setTextColor(
    c.has_weekly ? weeklyResetTextColor(c.weekly_resets_at) : TFT_DARKGREY,
    TFT_BLACK
  );
  snprintf(
    line,
    sizeof(line),
    c.has_weekly ? "R %s %s" : "R --/-- --:--",
    weekDate,
    weekTime
  );
  tft.drawString(line, x + w / 2, y + 74, 1);

  const char *statusLabel = c.has_quota ? (g_online ? "LIVE" : "OFFLINE") : "--";
  tft.setTextColor(c.has_quota ? border : TFT_DARKGREY, TFT_BLACK);
  tft.drawString(statusLabel, x + w / 2, y + 91, 1);
}

static void drawStatusTile(int x, int y, int w, int h) {
  const uint16_t border = g_online ? TFT_GREEN : TFT_RED;
  tft.drawRoundRect(x, y, w, h, 6, border);
  tft.fillRoundRect(x + 1, y + 1, w - 2, 19, 5, border);

  tft.setTextDatum(TC_DATUM);
  tft.setTextColor(TFT_BLACK, border);
  tft.drawString("STATUS", x + w / 2, y + 3, 2);
  tft.setTextColor(g_online ? TFT_GREEN : TFT_RED, TFT_BLACK);
  tft.drawString(g_online ? "ONLINE" : "OFFLINE", x + w / 2, y + 27, 2);
  tft.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  tft.drawString("5 AI", x + w / 2, y + 49, 2);
  tft.drawString("SYNC 60s", x + w / 2, y + 68, 1);
  tft.setTextColor(TFT_DARKGREY, TFT_BLACK);
  tft.drawString(g_last_error[0] ? "RETRY" : "TAP REFRESH", x + w / 2, y + 88, 1);
}

static void drawUi() {
  tft.fillScreen(TFT_BLACK);

  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.drawString("AI QUOTA", 5, 3, 2);
  tft.setTextDatum(TR_DATUM);
  tft.setTextColor(g_online ? TFT_GREEN : TFT_RED, TFT_BLACK);
  tft.drawString(g_online ? "ONLINE" : "OFFLINE", SCREEN_WIDTH - 5, 3, 2);

  // One-page 3x2 grid: five providers plus a compact backend status tile.
  const int columns = 3;
  const int top = 25;
  const int w = 102;
  const int h = 101;
  const int gap = 4;
  const int x0 = 3;
  const int y0 = top;

  for (int i = 0; i < PROVIDER_COUNT; i++) {
    const int column = i % columns;
    const int row = i / columns;
    drawProviderTile(
      cards[i],
      x0 + column * (w + gap),
      y0 + row * (h + gap),
      w,
      h
    );
  }

  drawStatusTile(
    x0 + 2 * (w + gap),
    y0 + (h + gap),
    w,
    h
  );
}

#if USE_LVGL
// Minimal LVGL flush + tick — cards still drawn via TFT for clarity on 320x240.
// Full LVGL widget tree can replace drawUi later; tick keeps library alive.
static lv_disp_draw_buf_t draw_buf;
static lv_color_t buf1[SCREEN_WIDTH * 20];

static void lvgl_flush(lv_disp_drv_t *disp, const lv_area_t *area, lv_color_t *color_p) {
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;
  tft.startWrite();
  tft.setAddrWindow(area->x1, area->y1, w, h);
  tft.pushColors((uint16_t *)&color_p->full, w * h, true);
  tft.endWrite();
  lv_disp_flush_ready(disp);
}

static void lvgl_touch_read(lv_indev_drv_t *drv, lv_indev_data_t *data) {
  (void)drv;
  if (touch.tirqTouched() && touch.touched()) {
    TS_Point p = touch.getPoint();
    int16_t x = map(p.x, TOUCH_MAP_X1, TOUCH_MAP_X2, 0, SCREEN_WIDTH - 1);
    int16_t y = map(p.y, TOUCH_MAP_Y1, TOUCH_MAP_Y2, 0, SCREEN_HEIGHT - 1);
#if TOUCH_SWAP_XY
    int16_t t = x; x = y; y = t;
#endif
#if TOUCH_INVERT_X
    x = SCREEN_WIDTH - 1 - x;
#endif
#if TOUCH_INVERT_Y
    y = SCREEN_HEIGHT - 1 - y;
#endif
    data->state = LV_INDEV_STATE_PR;
    data->point.x = constrain(x, 0, SCREEN_WIDTH - 1);
    data->point.y = constrain(y, 0, SCREEN_HEIGHT - 1);
  } else {
    data->state = LV_INDEV_STATE_REL;
  }
}

static void initLvgl() {
  lv_init();
  lv_disp_draw_buf_init(&draw_buf, buf1, NULL, SCREEN_WIDTH * 20);

  static lv_disp_drv_t disp_drv;
  lv_disp_drv_init(&disp_drv);
  disp_drv.hor_res = SCREEN_WIDTH;
  disp_drv.ver_res = SCREEN_HEIGHT;
  disp_drv.flush_cb = lvgl_flush;
  disp_drv.draw_buf = &draw_buf;
  lv_disp_drv_register(&disp_drv);

  static lv_indev_drv_t indev_drv;
  lv_indev_drv_init(&indev_drv);
  indev_drv.type = LV_INDEV_TYPE_POINTER;
  indev_drv.read_cb = lvgl_touch_read;
  lv_indev_drv_register(&indev_drv);
}
#endif

// ---------- setup / loop ----------
void setup() {
#if DEBUG_SERIAL
  Serial.begin(115200);
  delay(200);
  Serial.println("AI Usage Display boot");
#endif

  pinMode(21, OUTPUT); // backlight
  digitalWrite(21, HIGH);

  tft.init();
  tft.setRotation(1); // landscape 320x240
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.drawString("Connecting WiFi...", 10, 100, 2);

  touchSpi.begin(TOUCH_CLK, TOUCH_MISO, TOUCH_MOSI, TOUCH_CS);
  touch.begin(touchSpi);
  touch.setRotation(1);

#if USE_LVGL
  initLvgl();
#endif

  ensureWifi();
  bool ok = fetchUsage();
  if (!ok) {
    // Keep last zeros; draw OFFLINE
  }
  drawUi();
}

void loop() {
#if USE_LVGL
  lv_timer_handler();
  lv_tick_inc(LVGL_TICK_PERIOD_MS);
#endif

  // Tap anywhere to force refresh
  if (touch.tirqTouched() && touch.touched()) {
    delay(50);
    if (touch.touched()) {
      fetchUsage();
      drawUi();
      delay(300);
    }
  }

  if (millis() - g_last_fetch_ms >= USAGE_REFRESH_MS) {
    bool ok = fetchUsage();
    // On failure keep previous card numbers and show OFFLINE
    if (!ok) {
      g_online = false;
    }
    drawUi();
  }

  delay(LVGL_TICK_PERIOD_MS);
}
