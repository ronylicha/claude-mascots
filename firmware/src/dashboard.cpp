#include "dashboard.h"

#include <stdio.h>
#include <string.h>

#include "format.h"
#include "scene.h"
#include "sprites_gen.h"

namespace {

constexpr int16_t SCREEN_W = 320;
constexpr int16_t SCREEN_H = 240;
constexpr int16_t HEADER_H = 34;
constexpr int16_t BODY_H = SCREEN_H - HEADER_H;

// Vue détaillée : barre du haut, chambre à l'échelle 2 à gauche, fiche d'identité à droite.
constexpr int16_t BAR_H = 33;
constexpr int16_t BACK_W = 64;  // zone de tap de la flèche : 64 x 34, au-delà du minimum de 48 x 30
constexpr int16_t BACK_H = 34;
constexpr int16_t DETAIL_ROOM_X = 4;
constexpr int16_t DETAIL_ROOM_Y = 37;
constexpr uint8_t DETAIL_SCALE = 2;
constexpr int16_t INFO_X = 140;
constexpr int16_t INFO_W = 176;
constexpr int16_t INFO_ROW = 17;
constexpr int16_t CONTEXT_Y = 127;
constexpr int16_t TOKENS_Y = 143;
constexpr int16_t LOWER_Y = 168;
constexpr int16_t CHART_X = 4;
constexpr int16_t CHART_Y = 179;
constexpr int16_t CHART_W = 150;
constexpr int16_t CHART_H = 57;
constexpr int16_t TOOLS_X = 164;
constexpr int16_t TOOLS_CELL_W = 38;
constexpr int16_t TOOLS_CELL_H = 30;
constexpr uint8_t TOOLS_PER_ROW = 4;

// Palette identique au CSS du tableau de bord web.
constexpr uint16_t BG = lgfx::color565(0x12, 0x10, 0x1f);
constexpr uint16_t PANEL = lgfx::color565(0x1f, 0x1b, 0x36);
constexpr uint16_t EDGE = lgfx::color565(0x34, 0x30, 0x5a);
constexpr uint16_t ACCENT = lgfx::color565(0xb4, 0x90, 0xff);
constexpr uint16_t TEXT = lgfx::color565(0xec, 0xe9, 0xff);
constexpr uint16_t MUTED = lgfx::color565(0x9b, 0x95, 0xc4);
constexpr uint16_t TRACK = lgfx::color565(0x2a, 0x26, 0x48);
constexpr uint16_t OK = lgfx::color565(0x53, 0xd1, 0xb6);
constexpr uint16_t WARN = lgfx::color565(0xf7, 0xc9, 0x48);
constexpr uint16_t DANGER = lgfx::color565(0xe5, 0x48, 0x4d);

// Emplacements du cache de champs (voir Dashboard::changed). Un redessin complet les remet à zéro.
enum HeaderSlot : uint8_t {
  SLOT_HEADER_CHROME,
  SLOT_FIVE_BAR,
  SLOT_FIVE_TEXT,
  SLOT_SEVEN_BAR,
  SLOT_SEVEN_TEXT,
  SLOT_TOTAL_COST,
  SLOT_TOTAL_DETAIL,
  SLOT_FIVE_LABEL,
  SLOT_SEVEN_LABEL,
  // layoutFor() remet à zéro les slots à partir de celui-ci : tout slot du bandeau doit venir avant.
  SLOT_EMPTY_MESSAGE,
};
constexpr uint8_t CARD_SLOT_BASE = 10;  // SLOT_EMPTY_MESSAGE + 1
constexpr uint8_t CARD_SLOTS = 7;

enum DetailSlot : uint8_t {
  SLOT_NAME,
  SLOT_COST,
  SLOT_ACTIVITY,
  SLOT_TOOL,
  SLOT_MODEL,
  SLOT_PROJECT,
  SLOT_TIMING,
  SLOT_CONTEXT_BAR,
  SLOT_CONTEXT_TEXT,
  SLOT_TOKENS,  // 6 champs consécutifs
  SLOT_CHART = SLOT_TOKENS + 6,
  SLOT_PEAK,
  SLOT_ACTIVE_TOOL,
  SLOT_COUNTS,  // 7 champs consécutifs
};

constexpr const lgfx::IFont* FONT_SMALL = &fonts::Font0;
constexpr const lgfx::IFont* FONT_MEDIUM = &fonts::Font2;
constexpr const lgfx::IFont* FONT_LARGE = &fonts::Font4;

static_assert(CARD_SLOT_BASE == SLOT_EMPTY_MESSAGE + 1, "CARD_SLOT_BASE doit suivre le dernier slot du bandeau");

// Rotation du bandeau quand les deux fournisseurs sont actifs, en secondes.
constexpr uint32_t PROVIDER_ROTATION_SECONDS = 5;

const char* providerName(uint8_t provider) { return provider == mascots::PROVIDER_CODEX ? "Codex" : "Claude"; }

uint16_t levelColor(int percent) {
  if (percent >= 90) return DANGER;
  if (percent >= 70) return WARN;
  return OK;
}

uint32_t mix(uint32_t hash, uint32_t value) { return (hash ^ value) * 16777619u; }

uint32_t mixString(uint32_t hash, const char* value) {
  for (; *value != '\0'; value++) hash = mix(hash, static_cast<uint8_t>(*value));
  return hash;
}

/** Libellés sans accents : les polices bitmap embarquées sont en ASCII. */
const char* activityShort(const mascots::Session& s) {
  if (s.activity == 'a') return "Attend !";
  if (s.activity == 's') return "Dort";
  if (s.activity != 'w') return "Repos";
  switch (s.tool) {
    case 'r': return "Lit";
    case 'e': return "Code";
    case 'b': return "Terminal";
    case 's': return "Cherche";
    case 'd': return "Agents";
    case 't': return "Pense";
    default: return "Outil";
  }
}

const char* activityLong(const mascots::Session& s) {
  if (s.activity == 'a') return "Attend votre reponse";
  if (s.activity == 's') return "Dort";
  if (s.activity != 'w') return "Au repos";
  switch (s.tool) {
    case 'r': return "Lit des fichiers";
    case 'e': return "Ecrit du code";
    case 'b': return "Lance une commande";
    case 's': return "Cherche sur le web";
    case 'd': return "Delegue a un agent";
    case 't': return "Reflechit";
    default: return "Utilise un outil";
  }
}

uint16_t activityColor(const mascots::Session& s) {
  if (s.activity == 'w') return ACCENT;
  if (s.activity == 'a') return WARN;
  if (s.activity == 's') return MUTED;
  return TEXT;
}

void formatContext(char* out, size_t size, int percent) {
  if (percent < 0) snprintf(out, size, "?");
  else snprintf(out, size, "%d%%", percent);
}

/** Fenêtre de contexte (milliers de tokens) : 200k, 1M, 1.5M. */
void formatWindow(char* out, size_t size, int32_t thousands) {
  if (thousands < 1000) snprintf(out, size, "%ldk", static_cast<long>(thousands));
  else if (thousands % 1000 == 0) snprintf(out, size, "%ldM", static_cast<long>(thousands / 1000));
  else snprintf(out, size, "%ld.%ldM", static_cast<long>(thousands / 1000), static_cast<long>((thousands % 1000) / 100));
}

/** Un fournisseur est pertinent s'il a une fenêtre de quota connue ou une session visible. */
bool isProviderRelevant(const mascots::Frame& frame, uint8_t provider) {
  const mascots::AccountQuota& quota = frame.quota[provider];
  if (quota.fiveHour.percent >= 0 || quota.sevenDay.percent >= 0) return true;
  for (uint8_t i = 0; i < frame.visibleCount; i++) {
    if (frame.sessions[i].provider == provider) return true;
  }
  return false;
}

/** Fournisseur affiché dans le bandeau : alternance toutes les 5 s si les deux sont pertinents, Claude si aucun. */
uint8_t headerProvider(const mascots::Frame& frame) {
  const bool claude = isProviderRelevant(frame, mascots::PROVIDER_CLAUDE);
  const bool codex = isProviderRelevant(frame, mascots::PROVIDER_CODEX);
  if (claude && codex) return (frame.timestamp / PROVIDER_ROTATION_SECONDS) % mascots::PROVIDER_COUNT;
  return codex ? mascots::PROVIDER_CODEX : mascots::PROVIDER_CLAUDE;
}

/** « <Fournisseur> <modèle> » (un espace : 23 caractères max, la carte Pair en affiche 24) ; modèle inconnu : « Codex ? ». */
void formatProviderModel(char* out, size_t size, const mascots::Session& s) {
  snprintf(out, size, "%s %s", providerName(s.provider), s.model[0] != '\0' ? s.model : "?");
}

void formatQuota(char* out, size_t size, const mascots::QuotaWindow& window) {
  if (window.percent < 0) {
    snprintf(out, size, "--");
    return;
  }
  char reset[12];
  format::duration(reset, sizeof(reset), static_cast<int32_t>(window.resetMinutes));
  snprintf(out, size, "%d%% %s", window.percent, reset);
}

const sprites::PaletteEntry* findPaletteEntry(char key) {
  for (uint8_t i = 0; i < sprites::PALETTE_COUNT; i++) {
    if (sprites::PALETTE[i].key == key) return &sprites::PALETTE[i];
  }
  return nullptr;
}

/** Icône d'outil 8x8 de sprites_gen.h agrandie de `scale`. */
void drawIcon(lgfx::LGFXBase& target, const sprites::Icon& icon, int x, int y, int scale) {
  for (int row = 0; row < 8; row++) {
    for (int column = 0; icon.rows[row][column] != '\0'; column++) {
      const sprites::PaletteEntry* entry = findPaletteEntry(icon.rows[row][column]);
      if (entry != nullptr) target.fillRect(x + column * scale, y + row * scale, scale, scale, entry->rgb565);
    }
  }
}

}  // namespace

Dashboard::Dashboard(CydDisplay& display) : display_(display), room_(&display), strip_(&display), chart_(&display) {}

// ---------------------------------------------------------------------------------------------------
// Champs mis en cache

bool Dashboard::changed(uint8_t slot, uint32_t signature) {
  if (signature == 0) signature = 1;  // 0 signifie « jamais dessiné »
  if (signatures_[slot] == signature) return false;
  signatures_[slot] = signature;
  return true;
}

void Dashboard::text(uint8_t slot, int16_t x, int16_t y, int16_t width, const lgfx::IFont* font, uint16_t color, uint16_t background,
                     lgfx::textdatum_t datum, const char* value) {
  uint32_t signature = 2166136261u;
  signature = mix(signature, static_cast<uint32_t>(x) | static_cast<uint32_t>(y) << 16);
  signature = mix(signature, static_cast<uint32_t>(width) | static_cast<uint32_t>(color) << 16);
  signature = mix(signature, static_cast<uint32_t>(background) | static_cast<uint32_t>(datum) << 16);
  signature = mix(signature, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(font)));
  if (!changed(slot, mixString(signature, value))) return;

  display_.setFont(font);
  display_.setTextColor(color, background);
  display_.setTextDatum(datum);
  // Le fond est peint par la police elle-même, avec un remplissage jusqu'à `width` : aucun effacement préalable.
  display_.setTextPadding(width);
  display_.setClipRect(x, y, width, display_.fontHeight());
  int16_t anchor = x;
  if (datum == lgfx::top_center) anchor = x + width / 2;
  else if (datum == lgfx::top_right) anchor = x + width;
  display_.drawString(value, anchor, y);
  display_.clearClipRect();
  display_.setTextPadding(0);
  display_.setTextDatum(lgfx::top_left);
}

void Dashboard::bar(uint8_t slot, int16_t x, int16_t y, int16_t width, int16_t height, int percent, uint16_t background) {
  uint32_t signature = mix(2166136261u, static_cast<uint32_t>(x) | static_cast<uint32_t>(y) << 16);
  signature = mix(signature, static_cast<uint32_t>(width) | static_cast<uint32_t>(height) << 16);
  signature = mix(signature, static_cast<uint32_t>(percent + 2) | static_cast<uint32_t>(background) << 16);
  if (!changed(slot, signature)) return;
  const int level = percent > 100 ? 100 : (percent < 0 ? 0 : percent);
  const int filled = width * level / 100;
  if (filled > 0) display_.fillRect(x, y, filled, height, levelColor(percent));
  display_.fillRect(x + filled, y, width - filled, height, TRACK);
}

// ---------------------------------------------------------------------------------------------------
// Outils communs

int Dashboard::hourOf() const {
  return frame_.localHour >= 0 && frame_.localHour <= 23 ? frame_.localHour : scene::FALLBACK_HOUR;
}

bool Dashboard::ensureStrip(int scale) {
  if (scale <= 1) return true;
  if (stripScale_ == scale) return true;
  stripScale_ = scene::createStrip(strip_, scale) ? static_cast<uint8_t>(scale) : 0;
  return stripScale_ == scale;
}

void Dashboard::drawRoom(const mascots::Session& session, uint32_t frameCounter, int x, int y, int scale, int hour) {
  if (!roomReady_) roomReady_ = scene::createRoom(room_);
  if (!roomReady_ || !ensureStrip(scale)) return;
  scene::draw(room_, session, frameCounter, hour);
  scene::push(room_, strip_, x, y, scale);
}

int8_t Dashboard::findSession(const char* id) const {
  for (uint8_t i = 0; i < frame_.visibleCount; i++) {
    if (strncmp(id, frame_.sessions[i].id, mascots::ID_CAPACITY) == 0) return static_cast<int8_t>(i);
  }
  return -1;
}

void Dashboard::resetScreen() {
  display_.fillScreen(BG);
  memset(signatures_, 0, sizeof(signatures_));
  cardCount_ = 255;
}

const char* Dashboard::viewName() const { return view_ == View::Detail ? "detail" : "grid"; }

void Dashboard::invalidate() {
  resetScreen();
  if (waiting_) {
    drawWaitingText();
  } else if (hasFrame_ && view_ == View::Detail) {
    const int8_t index = findSession(detailId_);
    if (index >= 0) {
      drawDetailChrome();
      drawDetailValues(frame_.sessions[index]);
    } else {
      view_ = View::Grid;
      renderGrid();
    }
  } else if (hasFrame_) {
    renderGrid();
  }
}

// ---------------------------------------------------------------------------------------------------
// Grille

void Dashboard::showFrame(const mascots::Frame& frame) {
  if (waiting_) {
    waiting_ = false;
    resetScreen();
  }
  frame_ = frame;
  hasFrame_ = true;
  if (view_ == View::Detail) {
    const int8_t index = findSession(detailId_);
    if (index >= 0) {
      drawDetailValues(frame_.sessions[index]);
    } else {
      leaveDetail();  // la session a disparu : retour à la grille
    }
    return;
  }
  renderGrid();
}

void Dashboard::renderGrid() {
  drawHeader(frame_);
  layoutFor(frame_.visibleCount);
  if (frame_.visibleCount == 0) {
    text(SLOT_EMPTY_MESSAGE, 0, HEADER_H + BODY_H / 2 - 8, SCREEN_W, FONT_MEDIUM, MUTED, BG, lgfx::top_center, "Aucune session active");
    return;
  }
  for (uint8_t i = 0; i < frame_.visibleCount && i < cardCount_; i++) drawCardValues(i);
}

void Dashboard::layoutFor(uint8_t count) {
  if (count == cardCount_) return;
  // Le cache doit contenir le bandeau et les sept champs de chacune des six cartes.
  static_assert(CARD_SLOT_BASE + mascots::MAX_SESSIONS * CARD_SLOTS <= FIELD_SLOTS, "trop de slots pour le cache de champs");
  cardCount_ = count;
  for (uint8_t slot = SLOT_EMPTY_MESSAGE; slot < FIELD_SLOTS; slot++) signatures_[slot] = 0;
  display_.fillRect(0, HEADER_H, SCREEN_W, BODY_H, BG);

  uint8_t scale = 1;
  if (count == 1) {
    scale = 4;  // 256 x 160, centrée, avec une ligne d'état dessous
    cards_[0] = {0, HEADER_H, SCREEN_W, BODY_H, 32, HEADER_H + 4, scale, Density::Large};
  } else if (count == 2) {
    scale = 2;  // 128 x 80 dans chaque colonne, fiche dessous
    for (uint8_t i = 0; i < 2; i++) {
      const int16_t x = i * 160;
      cards_[i] = {x, HEADER_H, 160, BODY_H, static_cast<int16_t>(x + 16), HEADER_H + 6, scale, Density::Pair};
    }
  } else if (count <= 4) {
    scale = 2;  // 2 x 2 : 128 x 80 et une ligne de texte
    for (uint8_t i = 0; i < count; i++) {
      const int16_t x = (i % 2) * 160;
      const int16_t y = HEADER_H + (i / 2) * 103;
      cards_[i] = {x, y, 160, 103, static_cast<int16_t>(x + 16), static_cast<int16_t>(y + 3), scale, Density::Quad};
    }
  } else {
    scale = 1;  // 3 x 2 : chambre à l'échelle 1, texte minimal
    for (uint8_t i = 0; i < count; i++) {
      const int16_t x = (i % 3) * 107;
      const int16_t y = HEADER_H + (i / 3) * 103;
      const int16_t w = i % 3 == 2 ? 106 : 107;
      cards_[i] = {x, y, w, 103, static_cast<int16_t>(x + (w - scene::WIDTH) / 2), static_cast<int16_t>(y + 6), scale, Density::Compact};
    }
  }
  for (uint8_t i = 0; i < count; i++) {
    const Card& card = cards_[i];
    display_.fillRect(card.x + 2, card.y + 2, card.w - 4, card.h - 4, PANEL);
    display_.drawRect(card.x + 1, card.y + 1, card.w - 2, card.h - 2, EDGE);
  }
  if (count > 0) ensureStrip(scale);
}

void Dashboard::drawHeader(const mascots::Frame& frame) {
  if (changed(SLOT_HEADER_CHROME, 1)) {
    display_.fillRect(0, 0, SCREEN_W, HEADER_H, PANEL);
    display_.drawFastHLine(0, HEADER_H - 2, SCREEN_W, EDGE);
    display_.drawFastHLine(0, HEADER_H - 1, SCREEN_W, EDGE);
  }

  // Un seul fournisseur à la fois : libellé (colonne 6, largeur 54), barre (64, 54), texte (122, 66).
  const uint8_t provider = headerProvider(frame);
  const mascots::AccountQuota& account = frame.quota[provider];
  char label[16];
  char quota[24];
  snprintf(label, sizeof(label), "%s 5h", providerName(provider));
  text(SLOT_FIVE_LABEL, 6, 5, 54, FONT_SMALL, MUTED, PANEL, lgfx::top_left, label);
  bar(SLOT_FIVE_BAR, 64, 4, 54, 10, account.fiveHour.percent, PANEL);
  formatQuota(quota, sizeof(quota), account.fiveHour);
  text(SLOT_FIVE_TEXT, 122, 5, 66, FONT_SMALL, TEXT, PANEL, lgfx::top_left, quota);
  snprintf(label, sizeof(label), "%s 7j", providerName(provider));
  text(SLOT_SEVEN_LABEL, 6, 19, 54, FONT_SMALL, MUTED, PANEL, lgfx::top_left, label);
  bar(SLOT_SEVEN_BAR, 64, 18, 54, 10, account.sevenDay.percent, PANEL);
  formatQuota(quota, sizeof(quota), account.sevenDay);
  text(SLOT_SEVEN_TEXT, 122, 19, 66, FONT_SMALL, TEXT, PANEL, lgfx::top_left, quota);

  char cost[16];
  format::money(cost, sizeof(cost), frame.totalCostCents);
  text(SLOT_TOTAL_COST, 228, 1, 86, FONT_MEDIUM, ACCENT, PANEL, lgfx::top_right, cost);
  char rate[12];
  format::compact(rate, sizeof(rate), frame.totalTokensPerMinute);
  char detail[32];
  snprintf(detail, sizeof(detail), "%s t/min  %u/%u", rate, frame.workingCount, frame.sessionCount);
  text(SLOT_TOTAL_DETAIL, 190, 20, 124, FONT_SMALL, MUTED, PANEL, lgfx::top_right, detail);
}

void Dashboard::drawCardValues(uint8_t index) {
  const Card& card = cards_[index];
  const mascots::Session& s = frame_.sessions[index];
  const uint8_t base = CARD_SLOT_BASE + index * CARD_SLOTS;
  const uint16_t nameColor = s.activity == 'w' ? ACCENT : TEXT;
  const uint16_t stateColor = activityColor(s);

  char context[8];
  formatContext(context, sizeof(context), s.contextPercent);
  char rate[12];
  format::compact(rate, sizeof(rate), s.tokensPerMinute);
  char money[12];
  format::money(money, sizeof(money), s.costCents);
  char line[40];

  switch (card.density) {
    case Density::Large: {
      const int16_t y = card.y + 168;
      text(base, card.x + 8, y, 150, FONT_MEDIUM, nameColor, PANEL, lgfx::top_left, s.name);
      text(base + 1, card.x + card.w - 148, y, 140, FONT_MEDIUM, stateColor, PANEL, lgfx::top_right, activityShort(s));
      bar(base + 2, card.x + 8, y + 22, 120, 8, s.contextPercent, PANEL);
      text(base + 3, card.x + 132, y + 22, 30, FONT_SMALL, MUTED, PANEL, lgfx::top_left, context);
      snprintf(line, sizeof(line), "%s  %s t/min", money, rate);
      text(base + 4, card.x + 166, y + 22, 146, FONT_SMALL, MUTED, PANEL, lgfx::top_right, line);
      break;
    }
    case Density::Pair: {
      text(base, card.x + 8, card.y + 92, 144, FONT_MEDIUM, nameColor, PANEL, lgfx::top_left, s.name);
      text(base + 1, card.x + 8, card.y + 110, 144, FONT_MEDIUM, stateColor, PANEL, lgfx::top_left, activityShort(s));
      bar(base + 2, card.x + 8, card.y + 134, 108, 8, s.contextPercent, PANEL);
      text(base + 3, card.x + 120, card.y + 134, 32, FONT_SMALL, MUTED, PANEL, lgfx::top_left, context);
      snprintf(line, sizeof(line), "%s t/min", rate);
      text(base + 4, card.x + 8, card.y + 150, 144, FONT_SMALL, MUTED, PANEL, lgfx::top_left, line);
      snprintf(line, sizeof(line), "%s  %ld tours", money, static_cast<long>(s.turns));
      text(base + 5, card.x + 8, card.y + 162, 144, FONT_SMALL, MUTED, PANEL, lgfx::top_left, line);
      formatProviderModel(line, sizeof(line), s);
      text(base + 6, card.x + 8, card.y + 174, 144, FONT_SMALL, MUTED, PANEL, lgfx::top_left, line);
      break;
    }
    case Density::Quad:
      text(base, card.x + 8, card.y + 86, 76, FONT_SMALL, nameColor, PANEL, lgfx::top_left, s.name);
      text(base + 1, card.x + 84, card.y + 86, 68, FONT_SMALL, stateColor, PANEL, lgfx::top_right, activityShort(s));
      bar(base + 2, card.x + 8, card.y + 96, 144, 4, s.contextPercent, PANEL);
      break;
    case Density::Compact:
      text(base, card.x + 4, card.y + 52, card.w - 8, FONT_SMALL, nameColor, PANEL, lgfx::top_center, s.name);
      text(base + 1, card.x + 4, card.y + 64, card.w - 8, FONT_SMALL, stateColor, PANEL, lgfx::top_center, activityShort(s));
      bar(base + 2, card.x + 8, card.y + 78, card.w - 16, 5, s.contextPercent, PANEL);
      snprintf(line, sizeof(line), "%s t/min", rate);
      text(base + 3, card.x + 4, card.y + 88, card.w - 8, FONT_SMALL, MUTED, PANEL, lgfx::top_center, line);
      break;
  }
}

void Dashboard::animate(uint32_t frameCounter) {
  if (waiting_ || !hasFrame_) return;
  if (view_ == View::Detail) {
    const int8_t index = findSession(detailId_);
    if (index >= 0) drawRoom(frame_.sessions[index], frameCounter, DETAIL_ROOM_X, DETAIL_ROOM_Y, DETAIL_SCALE, hourOf());
    return;
  }
  for (uint8_t i = 0; i < frame_.visibleCount && i < cardCount_; i++) {
    const Card& card = cards_[i];
    drawRoom(frame_.sessions[i], frameCounter, card.roomX, card.roomY, card.scale, hourOf());
  }
}

void Dashboard::drawWaitingText() {
  display_.setFont(FONT_MEDIUM);
  display_.setTextColor(TEXT, BG);
  display_.setTextDatum(lgfx::top_center);
  display_.drawString("En attente du PC...", SCREEN_W / 2, 186);
  display_.setFont(FONT_SMALL);
  display_.setTextColor(MUTED, BG);
  display_.drawString("Lancez claude-mascots (npm start)", SCREEN_W / 2, 208);
  display_.setTextDatum(lgfx::top_left);
}

void Dashboard::showWaiting(uint32_t frameCounter, bool firstTime) {
  if (firstTime || !waiting_) {
    waiting_ = true;
    view_ = View::Grid;
    chart_.deleteSprite();
    chartReady_ = false;
    resetScreen();
    drawWaitingText();
  }
  // Personnage endormi, de nuit : l'écran d'attente n'a pas de session à montrer.
  mascots::Session sleeper;
  sleeper.hue = 265;
  sleeper.skin = 1;
  sleeper.hair = 1;
  sleeper.hairStyle = 1;
  sleeper.activity = 's';
  drawRoom(sleeper, frameCounter, (SCREEN_W - scene::WIDTH * 4) / 2, 20, 4, 23);
}

// ---------------------------------------------------------------------------------------------------
// Vue détaillée

void Dashboard::handleTap(int16_t x, int16_t y) {
  if (waiting_ || !hasFrame_) return;
  if (view_ == View::Detail) {
    if (x >= 0 && x < BACK_W && y >= 0 && y < BACK_H) leaveDetail();
    return;
  }
  for (uint8_t i = 0; i < frame_.visibleCount && i < cardCount_; i++) {
    const Card& card = cards_[i];
    if (x >= card.x && x < card.x + card.w && y >= card.y && y < card.y + card.h) {
      enterDetail(i);
      return;
    }
  }
}

void Dashboard::enterDetail(uint8_t index) {
  const mascots::Session& session = frame_.sessions[index];
  memcpy(detailId_, session.id, sizeof(detailId_));
  view_ = View::Detail;
  resetScreen();
  chart_.deleteSprite();
  chart_.setColorDepth(16);
  chartReady_ = chart_.createSprite(CHART_W, CHART_H) != nullptr;
  drawDetailChrome();
  drawDetailValues(session);
}

void Dashboard::leaveDetail() {
  view_ = View::Grid;
  detailId_[0] = '\0';
  chart_.deleteSprite();
  chartReady_ = false;
  resetScreen();
  renderGrid();
}

/** Éléments fixes de la vue détaillée, dessinés une fois à l'ouverture. */
void Dashboard::drawDetailChrome() {
  display_.fillRect(0, 0, SCREEN_W, BAR_H, PANEL);
  display_.drawFastHLine(0, BAR_H - 1, SCREEN_W, EDGE);

  // Bouton retour : chevron « < » épais dans un cadre.
  display_.fillRoundRect(4, 3, 52, 26, 5, TRACK);
  display_.drawRoundRect(4, 3, 52, 26, 5, EDGE);
  for (int d = -1; d <= 1; d++) {
    display_.drawLine(37 + d, 8, 25 + d, 16, ACCENT);
    display_.drawLine(25 + d, 16, 37 + d, 24, ACCENT);
  }

  display_.drawRect(DETAIL_ROOM_X - 1, DETAIL_ROOM_Y - 1, scene::WIDTH * DETAIL_SCALE + 2, scene::HEIGHT * DETAIL_SCALE + 2, EDGE);

  display_.setFont(FONT_SMALL);
  display_.setTextColor(MUTED, BG);
  display_.drawString("Contexte", 4, CONTEXT_Y + 2);
  display_.drawString("Tokens/min", CHART_X, LOWER_Y);
  display_.drawString("Appels d'outils", TOOLS_X, LOWER_Y);

  for (uint8_t i = 0; i < sprites::ICON_COUNT; i++) {
    const int16_t cellX = TOOLS_X + (i % TOOLS_PER_ROW) * TOOLS_CELL_W;
    const int16_t cellY = CHART_Y + (i / TOOLS_PER_ROW) * TOOLS_CELL_H;
    drawIcon(display_, sprites::ICONS[i], cellX + 11, cellY, 2);
  }
}

void Dashboard::drawDetailValues(const mascots::Session& s) {
  char line[48];
  char first[16];
  char second[16];

  text(SLOT_NAME, 66, 3, 170, FONT_LARGE, TEXT, PANEL, lgfx::top_left, s.name);
  format::money(first, sizeof(first), s.costCents);
  text(SLOT_COST, 240, 8, 74, FONT_MEDIUM, ACCENT, PANEL, lgfx::top_right, first);

  text(SLOT_ACTIVITY, INFO_X, DETAIL_ROOM_Y, INFO_W, FONT_MEDIUM, activityColor(s), BG, lgfx::top_left, activityLong(s));
  text(SLOT_TOOL, INFO_X, DETAIL_ROOM_Y + INFO_ROW, INFO_W, FONT_MEDIUM, TEXT, BG, lgfx::top_left, s.toolName[0] != '\0' ? s.toolName : "-");
  formatProviderModel(line, sizeof(line), s);
  text(SLOT_MODEL, INFO_X, DETAIL_ROOM_Y + INFO_ROW * 2, INFO_W, FONT_MEDIUM, TEXT, BG, lgfx::top_left, line);
  text(SLOT_PROJECT, INFO_X, DETAIL_ROOM_Y + INFO_ROW * 3, INFO_W, FONT_MEDIUM, MUTED, BG, lgfx::top_left, s.project[0] != '\0' ? s.project : "?");
  format::duration(first, sizeof(first), s.uptimeMinutes);
  format::elapsed(second, sizeof(second), s.idleSeconds);
  if (s.idleSeconds < 0) snprintf(line, sizeof(line), "%s", first);
  else snprintf(line, sizeof(line), "%s | il y a %s", first, second);
  text(SLOT_TIMING, INFO_X, DETAIL_ROOM_Y + INFO_ROW * 4, INFO_W, FONT_MEDIUM, MUTED, BG, lgfx::top_left, line);

  // Jauge de contexte avec la taille de la fenêtre.
  bar(SLOT_CONTEXT_BAR, 60, CONTEXT_Y, 196, 10, s.contextPercent, BG);
  formatContext(first, sizeof(first), s.contextPercent);
  if (s.contextWindowK > 0 && s.contextPercent >= 0) {
    formatWindow(second, sizeof(second), s.contextWindowK);
    snprintf(line, sizeof(line), "%s/%s", first, second);
  } else {
    snprintf(line, sizeof(line), "%s", first);
  }
  text(SLOT_CONTEXT_TEXT, 258, CONTEXT_Y + 2, 58, FONT_SMALL, MUTED, BG, lgfx::top_right, line);

  // Tokens en format court, sur deux lignes de trois colonnes.
  struct Column {
    int16_t x, width;
  };
  static constexpr Column COLUMNS[3] = {{4, 92}, {100, 100}, {206, 110}};
  static constexpr const char* LABELS[6] = {"Entree", "Sortie", "Tours", "Cache lu", "Cache ecr", "t/min"};
  const int64_t counters[6] = {s.tokensInput, s.tokensOutput, s.turns, s.tokensCacheRead, s.tokensCacheWrite, s.tokensPerMinute};
  char value[12];
  for (uint8_t i = 0; i < 6; i++) {
    format::compact(value, sizeof(value), counters[i]);
    snprintf(line, sizeof(line), "%s %s", LABELS[i], value);
    text(SLOT_TOKENS + i, COLUMNS[i % 3].x, TOKENS_Y + (i / 3) * 11, COLUMNS[i % 3].width, FONT_SMALL, TEXT, BG, lgfx::top_left, line);
  }

  drawChart(s);

  // Appels d'outils par catégorie ; la catégorie en cours est encadrée.
  uint32_t activeSignature = mix(2166136261u, static_cast<uint8_t>(s.activity == 'w' ? s.tool : '-'));
  const bool activeChanged = changed(SLOT_ACTIVE_TOOL, activeSignature);
  for (uint8_t i = 0; i < sprites::ICON_COUNT; i++) {
    const int16_t cellX = TOOLS_X + (i % TOOLS_PER_ROW) * TOOLS_CELL_W;
    const int16_t cellY = CHART_Y + (i / TOOLS_PER_ROW) * TOOLS_CELL_H;
    if (activeChanged) {
      const bool active = s.activity == 'w' && s.tool == sprites::ICONS[i].code;
      display_.drawRoundRect(cellX + 8, cellY - 3, 22, 22, 3, active ? ACCENT : BG);
    }
    format::compact(value, sizeof(value), s.toolCounts[i]);
    text(SLOT_COUNTS + i, cellX, cellY + 19, TOOLS_CELL_W, FONT_SMALL, TEXT, BG, lgfx::top_center, value);
  }
}

/** Courbe des tokens/min sur 30 minutes : aire et trait, composés hors écran puis envoyés d'un bloc. */
void Dashboard::drawChart(const mascots::Session& s) {
  constexpr int N = mascots::HISTORY_POINTS;
  int32_t peak = 0;
  uint32_t signature = mix(2166136261u, s.hue);
  for (int i = 0; i < N; i++) {
    const int32_t value = s.history[i] > 0 ? s.history[i] : 0;
    if (value > peak) peak = value;
    signature = mix(signature, static_cast<uint32_t>(value));
  }
  char label[16];
  char peakText[12];
  format::compact(peakText, sizeof(peakText), peak);
  snprintf(label, sizeof(label), "max %s", peakText);
  text(SLOT_PEAK, CHART_X + 70, LOWER_Y, CHART_W - 70, FONT_SMALL, MUTED, BG, lgfx::top_right, label);
  if (!chartReady_ || !changed(SLOT_CHART, signature)) return;

  const int32_t scaleMax = peak > 0 ? peak : 1;
  const uint16_t lineColor = scene::hsl565(s.hue, 62, 62);
  const uint16_t areaColor = scene::hsl565(s.hue, 40, 26);
  int16_t px[N];
  int16_t py[N];
  for (int i = 0; i < N; i++) {
    const int32_t value = s.history[i] > 0 ? s.history[i] : 0;
    px[i] = 5 + i * (CHART_W - 10) / (N - 1);
    py[i] = (CHART_H - 4) - static_cast<int16_t>(static_cast<int64_t>(value) * (CHART_H - 10) / scaleMax);
  }

  chart_.fillScreen(PANEL);
  chart_.drawRect(0, 0, CHART_W, CHART_H, EDGE);
  for (int i = 0; i < N - 1; i++) {
    const int span = px[i + 1] - px[i];
    for (int x = px[i]; x <= px[i + 1]; x++) {
      const int y = py[i] + (py[i + 1] - py[i]) * (x - px[i]) / span;
      chart_.drawFastVLine(x, y, (CHART_H - 3) - y, areaColor);
    }
  }
  for (int i = 0; i < N - 1; i++) {
    chart_.drawLine(px[i], py[i], px[i + 1], py[i + 1], lineColor);
    chart_.drawLine(px[i], py[i] + 1, px[i + 1], py[i + 1] + 1, lineColor);
  }
  chart_.fillRect(px[N - 1] - 2, py[N - 1] - 1, 5, 5, TEXT);
  chart_.pushSprite(CHART_X, CHART_Y);
}
