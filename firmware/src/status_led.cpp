#include "status_led.h"

#include <Arduino.h>

namespace status_led {

namespace {

constexpr uint8_t PIN_RED = 4;
constexpr uint8_t PIN_GREEN = 16;
constexpr uint8_t PIN_BLUE = 17;
constexpr uint8_t MAX_BRIGHTNESS = 40;  // la LED est très lumineuse ; 40/255 suffit.

void write(uint8_t red, uint8_t green, uint8_t blue) {
  // Câblage en anode commune : 255 = éteint.
  analogWrite(PIN_RED, 255 - red);
  analogWrite(PIN_GREEN, 255 - green);
  analogWrite(PIN_BLUE, 255 - blue);
}

bool anyMood(const mascots::Frame& frame, char mood) {
  for (uint8_t i = 0; i < frame.visibleCount; i++) {
    if (frame.sessions[i].mood == mood) return true;
  }
  return false;
}

// Quota 5 h critique chez l'un des fournisseurs.
bool anyFiveHourCritical(const mascots::Frame& frame) {
  for (uint8_t provider = 0; provider < mascots::PROVIDER_COUNT; provider++) {
    if (frame.quota[provider].fiveHour.percent >= 95) return true;
  }
  return false;
}

}  // namespace

void begin() {
  pinMode(PIN_RED, OUTPUT);
  pinMode(PIN_GREEN, OUTPUT);
  pinMode(PIN_BLUE, OUTPUT);
  write(0, 0, 0);
}

void update(const mascots::Frame* frame, uint32_t nowMs) {
  if (frame == nullptr) {
    write(0, 0, 0);
    return;
  }
  if (anyMood(*frame, 'x') || anyFiveHourCritical(*frame)) {
    write(MAX_BRIGHTNESS, 0, 0);
  } else if (anyMood(*frame, 'w')) {
    write(MAX_BRIGHTNESS, MAX_BRIGHTNESS / 2, 0);
  } else if (frame->workingCount > 0) {
    // Respiration lente (période 2 s) pendant que Claude travaille.
    const uint32_t phase = nowMs % 2000;
    const uint32_t level = phase < 1000 ? phase : 2000 - phase;
    write(0, 0, static_cast<uint8_t>(4 + (MAX_BRIGHTNESS - 4) * level / 1000));
  } else {
    write(0, MAX_BRIGHTNESS / 3, 0);
  }
}

}  // namespace status_led
