#pragma once
// LED RGB de la carte (GPIO 4/16/17, active à l'état bas) : humeur globale visible du coin de l'œil.
#include <stdint.h>

#include "model.h"

namespace status_led {

void begin();
/** Vert = calme, bleu pulsé = au travail, jaune = quota sous tension, rouge = quota/contexte épuisé, éteint = pas de PC. */
void update(const mascots::Frame* frame, uint32_t nowMs);

}  // namespace status_led
