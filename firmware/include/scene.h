#pragma once
// Rendu de la chambre d'une session (scène logique 64x40), fidèle à drawRoomScene de web/sprites.js.
//
// La scène est dessinée à l'échelle 1 dans un petit sprite (5 Ko), puis agrandie à l'échelle entière voulue
// par bandes : la RAM de l'ESP32 (sans PSRAM, plus gros bloc ~110 Ko) interdit un sprite pleine taille.
#include "display.h"
#include "model.h"

namespace scene {

constexpr int WIDTH = 64;
constexpr int HEIGHT = 40;
/** Lignes logiques agrandies et envoyées à l'écran en une fois (40 est un multiple de 8). */
constexpr int STRIP_ROWS = 8;
/** Heure retenue quand le PC n'a pas fourni la sienne : la chambre est alors de jour. */
constexpr int FALLBACK_HOUR = 12;

/** Couleur RGB565 depuis teinte/saturation/luminosité (mêmes formules que le navigateur). */
uint16_t hsl565(int hue, int saturation, int lightness);

/** (Re)crée le sprite de la chambre, 64x40 en 16 bits. */
bool createRoom(lgfx::LGFX_Sprite& room);

/** (Re)crée le sprite d'une bande agrandie à `scale` (inutile à l'échelle 1). */
bool createStrip(lgfx::LGFX_Sprite& strip, int scale);

/** Dessine la chambre à l'échelle 1 : décor, ciel de `hour`, écran de l'ordinateur et occupant. */
void draw(lgfx::LGFX_Sprite& room, const mascots::Session& session, uint32_t frame, int hour);

/** Envoie la chambre à l'écran en (x, y), agrandie de `scale` ; `strip` doit venir de createStrip(scale). */
void push(lgfx::LGFX_Sprite& room, lgfx::LGFX_Sprite& strip, int x, int y, int scale);

}  // namespace scene
