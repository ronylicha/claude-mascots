// claude-mascots — firmware ESP32-2432S028 (« Cheap Yellow Display »).
// Reçoit du PC une trame JSON par ligne (115200 bauds) et anime un personnage par session Claude Code.

#include <Arduino.h>
#include <Preferences.h>

#include "dashboard.h"
#include "display.h"
#include "protocol.h"
#include "status_led.h"
#include "touch_calibration.h"

#ifndef MASCOTS_DEFAULT_INVERT
#define MASCOTS_DEFAULT_INVERT 0
#endif

namespace {

constexpr uint32_t BAUD_RATE = 115200;
// Une trame complète (6 sessions) fait ~4 000 octets : la ligne et le tampon de réception en acceptent 4 095.
constexpr size_t LINE_CAPACITY = 4096;
constexpr uint32_t FRAME_INTERVAL_MS = 125;  // ~8 images/s, rythme « rétro »
constexpr uint32_t SIGNAL_TIMEOUT_MS = 10000;
constexpr uint8_t PIN_BOOT_BUTTON = 0;
constexpr uint32_t LONG_PRESS_MS = 800;
constexpr uint32_t CALIBRATION_PRESS_MS = 3000;

// Tactile : un tap est reconnu quand le doigt se relève.
constexpr uint32_t TOUCH_POLL_MS = 15;
constexpr uint32_t TOUCH_RELEASE_MS = 45;  // absence de contact qui vaut relevé (le XPT2046 saute parfois une mesure)
constexpr uint16_t TOUCH_MIN_SAMPLES = 2;  // écarte les contacts parasites d'une seule mesure
constexpr uint32_t TOUCH_MAX_TAP_MS = 1000;
constexpr int32_t TOUCH_MAX_DRIFT_PX = 30;  // au-delà, c'est un glissement et non un tap

CydDisplay display;
Dashboard dashboard(display);
Preferences preferences;

char lineBuffer[LINE_CAPACITY];
size_t lineLength = 0;
bool lineOverflow = false;

mascots::Frame currentFrame;
bool hasFrame = false;
uint32_t lastFrameAt = 0;
uint32_t lastAnimationAt = 0;

bool inverted = MASCOTS_DEFAULT_INVERT;
uint8_t rotation = 1;
bool touchCalibrated = false;
uint32_t buttonPressedAt = 0;
bool buttonActionDone = false;  // l'appui en cours a déjà déclenché la calibration : son relevé ne fait rien

struct TouchTracker {
  bool down = false;
  uint32_t startedAt = 0;
  uint32_t lastSeenAt = 0;
  int32_t sumX = 0;
  int32_t sumY = 0;
  int16_t firstX = 0;
  int16_t firstY = 0;
  int16_t lastX = 0;
  int16_t lastY = 0;
  uint16_t samples = 0;
};

TouchTracker touch;
uint32_t lastTouchPollAt = 0;

void applyDisplaySettings() {
  display.setRotation(rotation);
  display.invertDisplay(inverted);
  dashboard.invalidate();
}

void saveDisplaySettings() {
  preferences.putBool("invert", inverted);
  preferences.putUChar("rotation", rotation);
}

void discardPendingSerial() {
  while (Serial.available() > 0) Serial.read();
  lineLength = 0;
  lineOverflow = false;
}

/** Calibration interactive : bloquante, donc les lignes reçues pendant ce temps sont abandonnées. */
void calibrateTouch() {
  touchCalibrated = touch_calibration::run(display, preferences) || touchCalibrated;
  touch = TouchTracker{};
  discardPendingSerial();
  dashboard.invalidate();
}

/**
 * BOOT : appui court = inverser les couleurs (variante deux ports), appui long (>= 800 ms) = retourner l'écran,
 * appui très long (>= 3 s) = recalibrer le tactile dès que le seuil est atteint, bouton encore enfoncé.
 */
void handleBootButton(uint32_t now) {
  const bool pressed = digitalRead(PIN_BOOT_BUTTON) == LOW;
  if (pressed) {
    if (buttonPressedAt == 0) {
      buttonPressedAt = now;
      buttonActionDone = false;
    } else if (!buttonActionDone && now - buttonPressedAt >= CALIBRATION_PRESS_MS) {
      buttonActionDone = true;
      calibrateTouch();
    }
    return;
  }
  if (buttonPressedAt == 0) return;
  const uint32_t heldFor = now - buttonPressedAt;
  buttonPressedAt = 0;
  if (buttonActionDone) {
    buttonActionDone = false;
    return;
  }
  if (heldFor < 30) return;  // rebond
  if (heldFor >= LONG_PRESS_MS) {
    rotation = rotation == 1 ? 3 : 1;
  } else {
    inverted = !inverted;
  }
  saveDisplaySettings();
  applyDisplaySettings();
}

void handleTap(int16_t x, int16_t y) {
  // La vue annoncée est celle où le tap a eu lieu, avant que le tableau de bord n'en change.
  Serial.printf("TOUCH %d %d %s\n", x, y, dashboard.viewName());
  dashboard.handleTap(x, y);
}

/** Lit le tactile ; un tap est émis au relevé du doigt, à la position moyenne du contact. */
void pollTouch(uint32_t now) {
  if (now - lastTouchPollAt < TOUCH_POLL_MS) return;
  lastTouchPollAt = now;

  int16_t x = 0;
  int16_t y = 0;
  if (display.getTouch(&x, &y) > 0) {
    if (!touch.down) {
      touch = TouchTracker{};
      touch.down = true;
      touch.startedAt = now;
      touch.firstX = x;
      touch.firstY = y;
    }
    touch.lastSeenAt = now;
    touch.lastX = x;
    touch.lastY = y;
    touch.sumX += x;
    touch.sumY += y;
    touch.samples++;
    return;
  }

  if (!touch.down || now - touch.lastSeenAt < TOUCH_RELEASE_MS) return;
  const TouchTracker released = touch;
  touch = TouchTracker{};
  const bool brief = released.lastSeenAt - released.startedAt <= TOUCH_MAX_TAP_MS;
  const bool still = abs(released.lastX - released.firstX) <= TOUCH_MAX_DRIFT_PX && abs(released.lastY - released.firstY) <= TOUCH_MAX_DRIFT_PX;
  if (released.samples < TOUCH_MIN_SAMPLES || !brief || !still) return;
  const int32_t tapX = constrain(released.sumX / released.samples, 0, display.width() - 1);
  const int32_t tapY = constrain(released.sumY / released.samples, 0, display.height() - 1);
  handleTap(static_cast<int16_t>(tapX), static_cast<int16_t>(tapY));
}

void handleLine(uint32_t now) {
  if (lineLength == 0) return;
  if (lineBuffer[0] == '{') {
    mascots::Frame frame;
    const mascots::ParseResult result = mascots::parseFrame(lineBuffer, lineLength, frame);
    if (result != mascots::ParseResult::Ok) {
      Serial.printf("ERR trame rejetee : %s\n", mascots::describe(result));
      return;
    }
    currentFrame = frame;
    hasFrame = true;
    lastFrameAt = now;
    dashboard.showFrame(currentFrame);
  } else if (strncmp(lineBuffer, "PING", 4) == 0) {
    Serial.println("PONG");
  }
}

void readSerial(uint32_t now) {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      if (!lineOverflow) {
        lineBuffer[lineLength] = '\0';
        handleLine(now);
      } else {
        Serial.println("ERR ligne trop longue");
      }
      lineLength = 0;
      lineOverflow = false;
    } else if (lineLength < LINE_CAPACITY - 1) {
      lineBuffer[lineLength++] = c;
    } else {
      lineOverflow = true;
    }
  }
}

}  // namespace

void setup() {
  Serial.setRxBufferSize(LINE_CAPACITY);
  Serial.begin(BAUD_RATE);
  pinMode(PIN_BOOT_BUTTON, INPUT_PULLUP);
  status_led::begin();

  preferences.begin("mascots", false);
  inverted = preferences.getBool("invert", MASCOTS_DEFAULT_INVERT);
  rotation = preferences.getUChar("rotation", 1);

  display.init();
  display.setBrightness(200);
  applyDisplaySettings();

  // Calibration mémorisée si elle existe, sinon la calibration par défaut de display.h (mesurée sur cette
  // carte) : le tactile marche dès le démarrage. La calibration manuelle reste disponible (BOOT 3 s) ;
  // l'imposer au démarrage bloquait l'écran 30 s chaque fois que personne ne touchait les croix.
  touchCalibrated = touch_calibration::load(display, preferences);
  dashboard.showWaiting(0, true);

  // Annonce au PC (journalisée par le démon) : modèle, résolution, protocole, état du tactile, et identifiants
  // bruts du contrôleur (RDDID 0x04 et 0xD3) pour reconnaître les variantes ILI9341 / ST7789 du CYD.
  const uint32_t panelId04 = display.getPanel()->readCommand(0x04, 0, 4);
  const uint32_t panelIdD3 = display.getPanel()->readCommand(0xD3, 0, 4);
  Serial.printf("HELLO mascots v%u esp32-2432s028 320x240 invert=%d rotation=%u touch=%s panel=%08lx/%08lx\n",
                mascots::PROTOCOL_VERSION, inverted, rotation, touchCalibrated ? "calibrated" : "default",
                static_cast<unsigned long>(panelId04), static_cast<unsigned long>(panelIdD3));
}

void loop() {
  const uint32_t now = millis();
  readSerial(now);
  handleBootButton(now);
  pollTouch(now);

  const bool signalLost = !hasFrame || now - lastFrameAt > SIGNAL_TIMEOUT_MS;
  if (now - lastAnimationAt >= FRAME_INTERVAL_MS) {
    lastAnimationAt = now;
    const uint32_t frameCounter = now / FRAME_INTERVAL_MS;
    if (signalLost) {
      dashboard.showWaiting(frameCounter, false);
    } else {
      dashboard.animate(frameCounter);
    }
    status_led::update(signalLost ? nullptr : &currentFrame, now);
  }
}
