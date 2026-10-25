#pragma once
// Mise en page de l'écran 320x240 : une grille de chambres sous le bandeau quota, et une vue détaillée
// d'une session ouverte par un tap (flèche « < » pour revenir).
#include "display.h"
#include "model.h"

class Dashboard {
 public:
  explicit Dashboard(CydDisplay& display);

  /** À appeler quand une nouvelle trame arrive : met à jour les textes et jauges qui ont changé. */
  void showFrame(const mascots::Frame& frame);
  /** À appeler ~8 fois par seconde : anime uniquement les chambres. */
  void animate(uint32_t frameCounter);
  /** Écran d'attente quand le PC ne parle plus (referme la vue détaillée). */
  void showWaiting(uint32_t frameCounter, bool firstTime);
  /** Force un redessin complet (rotation, inversion, calibration). */
  void invalidate();
  /** Traite un tap aux coordonnées écran : ouvre la session touchée, ou revient à la grille. */
  void handleTap(int16_t x, int16_t y);
  /** Vue affichée : "grid" ou "detail". */
  const char* viewName() const;

 private:
  enum class View : uint8_t { Grid, Detail };
  enum class Density : uint8_t { Large, Pair, Quad, Compact };

  struct Card {
    int16_t x, y, w, h;          // zone de la carte à l'écran
    int16_t roomX, roomY;        // coin haut-gauche de la chambre
    uint8_t scale;               // échelle entière de la chambre
    Density density;
  };

  // Rendu
  void resetScreen();
  void renderGrid();
  void layoutFor(uint8_t count);
  void drawHeader(const mascots::Frame& frame);
  void drawCardValues(uint8_t index);
  void drawWaitingText();
  void drawRoom(const mascots::Session& session, uint32_t frameCounter, int x, int y, int scale, int hour);
  bool ensureStrip(int scale);
  int hourOf() const;

  // Vue détaillée
  void enterDetail(uint8_t index);
  void leaveDetail();
  void drawDetailChrome();
  void drawDetailValues(const mascots::Session& session);
  void drawChart(const mascots::Session& session);
  int8_t findSession(const char* id) const;

  // Champs mis en cache : un texte ou une jauge identique à la dernière image n'est pas redessiné.
  void text(uint8_t slot, int16_t x, int16_t y, int16_t width, const lgfx::IFont* font, uint16_t color, uint16_t background,
            lgfx::textdatum_t datum, const char* value);
  void bar(uint8_t slot, int16_t x, int16_t y, int16_t width, int16_t height, int percent, uint16_t background);
  bool changed(uint8_t slot, uint32_t signature);

  CydDisplay& display_;
  lgfx::LGFX_Sprite room_;
  lgfx::LGFX_Sprite strip_;
  lgfx::LGFX_Sprite chart_;
  uint8_t stripScale_ = 0;
  bool roomReady_ = false;

  mascots::Frame frame_;
  bool hasFrame_ = false;
  bool waiting_ = false;

  View view_ = View::Grid;
  char detailId_[mascots::ID_CAPACITY] = {0};
  bool chartReady_ = false;

  Card cards_[mascots::MAX_SESSIONS];
  uint8_t cardCount_ = 255;

  static constexpr uint8_t FIELD_SLOTS = 64;
  uint32_t signatures_[FIELD_SLOTS] = {0};
};
