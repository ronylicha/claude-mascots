#include "touch_calibration.h"

#include <Arduino.h>

namespace touch_calibration {

namespace {

constexpr char STORAGE_KEY[] = "tcal";
constexpr size_t PARAMETER_COUNT = 8;  // 4 coins x (x brut, y brut), ordre imposé par LovyanGFX
constexpr uint32_t CORNER_TIMEOUT_MS = 30000;
constexpr int SAMPLE_PAIRS = 8;        // 16 mesures moyennées par croix, comme calibrateTouch
constexpr int MAX_PAIR_DELTA = 20;     // deux mesures consécutives doivent concorder
constexpr int RAW_MAX = 4095;          // le XPT2046 numérise sur 12 bits
constexpr int MIN_RAW_SPAN = 800;      // écart minimal entre coins : en dessous, la saisie est dégénérée
constexpr int CROSS_RADIUS = 10;
constexpr uint16_t BACKGROUND = 0x0000;
constexpr uint16_t FOREGROUND = 0xFFFF;
constexpr uint16_t HIGHLIGHT = 0xFEA0;

uint16_t active[PARAMETER_COUNT];
bool hasActive = false;

/** Rejette une saisie hors plage ou dont les quatre coins ne s'écartent pas d'au moins MIN_RAW_SPAN. */
bool plausible(const uint16_t* raw) {
  int minX = RAW_MAX, maxX = 0, minY = RAW_MAX, maxY = 0;
  for (size_t corner = 0; corner < PARAMETER_COUNT / 2; corner++) {
    const int x = raw[corner * 2];
    const int y = raw[corner * 2 + 1];
    if (x > RAW_MAX || y > RAW_MAX) return false;
    minX = min(minX, x);
    maxX = max(maxX, x);
    minY = min(minY, y);
    maxY = max(maxY, y);
  }
  return maxX - minX >= MIN_RAW_SPAN && maxY - minY >= MIN_RAW_SPAN;
}

void restoreActive(CydDisplay& display) {
  if (hasActive) {
    display.setTouchCalibrate(active);
    return;
  }
  // Calibration par défaut de la configuration (bornes brutes x_min…y_max), identique à celle du démarrage.
  const auto config = display.touch()->config();
  uint16_t fallback[PARAMETER_COUNT] = {config.x_min, config.y_min, config.x_min, config.y_max,
                                        config.x_max, config.y_min, config.x_max, config.y_max};
  display.setTouchCalibrate(fallback);
}

void drawTarget(CydDisplay& display, int x, int y, uint16_t color) {
  display.drawFastHLine(x - CROSS_RADIUS, y, CROSS_RADIUS * 2 + 1, color);
  display.drawFastVLine(x, y - CROSS_RADIUS, CROSS_RADIUS * 2 + 1, color);
  display.drawCircle(x, y, CROSS_RADIUS / 2, color);
}

void drawMessage(CydDisplay& display, const char* title, const char* detail) {
  display.setFont(&fonts::Font2);
  display.setTextColor(FOREGROUND, BACKGROUND);
  display.setTextDatum(lgfx::middle_center);
  display.setTextPadding(220);
  display.drawString(title, display.width() / 2, display.height() / 2 - 12);
  display.setTextColor(HIGHLIGHT, BACKGROUND);
  display.drawString(detail, display.width() / 2, display.height() / 2 + 12);
  display.setTextPadding(0);
  display.setTextDatum(lgfx::top_left);
}

/** Moyenne de 16 mesures brutes stables ; false si personne ne touche la croix avant le délai. */
bool sampleCorner(CydDisplay& display, uint16_t& rawX, uint16_t& rawY) {
  const uint32_t deadline = millis() + CORNER_TIMEOUT_MS;
  int32_t sumX = 0;
  int32_t sumY = 0;
  int pairs = 0;
  while (pairs < SAMPLE_PAIRS) {
    if (millis() > deadline) return false;
    lgfx::touch_point_t first;
    lgfx::touch_point_t second;
    if (!display.getTouchRaw(&first)) {
      delay(2);
      continue;
    }
    delay(10);
    if (!display.getTouchRaw(&second)) continue;
    if (abs(first.x - second.x) > MAX_PAIR_DELTA || abs(first.y - second.y) > MAX_PAIR_DELTA) continue;
    sumX += first.x + second.x;
    sumY += first.y + second.y;
    pairs++;
  }
  rawX = static_cast<uint16_t>(sumX / (SAMPLE_PAIRS * 2));
  rawY = static_cast<uint16_t>(sumY / (SAMPLE_PAIRS * 2));
  return true;
}

void waitForRelease(CydDisplay& display) {
  const uint32_t deadline = millis() + 3000;
  lgfx::touch_point_t point;
  while (display.getTouchRaw(&point) && millis() < deadline) delay(5);
  delay(200);
}

/** Une passe sur les quatre coins ; remplit `raw`. false : abandon (délai dépassé). */
bool collectCorners(CydDisplay& display, uint16_t* raw) {
  const int32_t lastX = CydDisplay::NATIVE_WIDTH - 1;
  const int32_t lastY = CydDisplay::NATIVE_HEIGHT - 1;
  // Calibration « identité » : convertRawXY traduit alors un coin du panneau (rotation 0) en position
  // d'écran pour la rotation courante, avec les formules mêmes de la bibliothèque.
  uint16_t identity[PARAMETER_COUNT] = {0, 0, 0, static_cast<uint16_t>(lastY), static_cast<uint16_t>(lastX), 0,
                                        static_cast<uint16_t>(lastX), static_cast<uint16_t>(lastY)};
  display.setTouchCalibrate(identity);
  display.fillScreen(BACKGROUND);

  for (int corner = 0; corner < 4; corner++) {
    int32_t x = (corner & 2) ? lastX : 0;  // même ordre que calibrateTouch : (0,0) (0,H) (W,0) (W,H)
    int32_t y = (corner & 1) ? lastY : 0;
    display.convertRawXY(&x, &y);

    char detail[24];
    snprintf(detail, sizeof(detail), "Touchez la croix %d/4", corner + 1);
    drawMessage(display, "Calibration tactile", detail);
    drawTarget(display, x, y, FOREGROUND);
    if (!sampleCorner(display, raw[corner * 2], raw[corner * 2 + 1])) return false;
    display.fillRect(x - CROSS_RADIUS - 1, y - CROSS_RADIUS - 1, CROSS_RADIUS * 2 + 3, CROSS_RADIUS * 2 + 3, BACKGROUND);
    waitForRelease(display);
  }
  return true;
}

}  // namespace

bool load(CydDisplay& display, Preferences& preferences) {
  uint16_t stored[PARAMETER_COUNT];
  if (preferences.getBytesLength(STORAGE_KEY) != sizeof(stored)) return false;
  preferences.getBytes(STORAGE_KEY, stored, sizeof(stored));
  if (!plausible(stored)) return false;
  display.setTouchCalibrate(stored);
  memcpy(active, stored, sizeof(active));
  hasActive = true;
  return true;
}

bool run(CydDisplay& display, Preferences& preferences) {
  uint16_t raw[PARAMETER_COUNT];
  for (int attempt = 0; attempt < 2; attempt++) {
    if (!collectCorners(display, raw)) {
      restoreActive(display);
      display.fillScreen(BACKGROUND);
      drawMessage(display, "Calibration annulee", "Aucun appui sur la croix");
      delay(1500);
      return false;
    }
    if (plausible(raw)) {
      display.setTouchCalibrate(raw);
      memcpy(active, raw, sizeof(active));
      hasActive = true;
      preferences.putBytes(STORAGE_KEY, raw, sizeof(raw));
      display.fillScreen(BACKGROUND);
      drawMessage(display, "Calibration enregistree", "Le tactile est pret");
      delay(900);
      return true;
    }
    display.fillScreen(BACKGROUND);
    drawMessage(display, "Saisie invalide", "Recommencez");
    delay(1200);
  }
  restoreActive(display);
  return false;
}

}  // namespace touch_calibration
