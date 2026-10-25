#pragma once
// Calibration du tactile résistif XPT2046, mémorisée en flash (Preferences, clé « tcal »).
//
// LovyanGFX ramène les mesures brutes aux coordonnées du panneau en rotation 0 (calibration affine, qui
// absorbe aussi les axes échangés ou inversés), puis applique la rotation courante dans convertRawXY.
// La calibration est donc indépendante de la rotation : une seule suffit pour les rotations 1 et 3.
#include <Preferences.h>

#include "display.h"

namespace touch_calibration {

/** Applique la calibration mémorisée. false : aucune valeur valide en flash (la calibration par défaut reste active). */
bool load(CydDisplay& display, Preferences& preferences);

/**
 * Calibration interactive : quatre croix à toucher, dans la rotation courante de l'écran.
 * Bloquante, avec un délai par croix ; en cas d'abandon l'ancienne calibration est rétablie.
 * true : nouvelle calibration appliquée et enregistrée.
 */
bool run(CydDisplay& display, Preferences& preferences);

}  // namespace touch_calibration
