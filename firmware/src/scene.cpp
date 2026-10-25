#include "scene.h"

#include <math.h>
#include <string.h>

#include "sprites_gen.h"

namespace scene {

namespace {

enum class Sky : uint8_t { Day, Dusk, Night };

Sky skyPhase(int hour) {
  if (hour >= 7 && hour <= 17) return Sky::Day;
  if (hour == 6 || hour == 18 || hour == 19) return Sky::Dusk;
  return Sky::Night;
}

uint16_t skyColor(Sky sky) {
  if (sky == Sky::Day) return sprites::SKY_DAY;
  if (sky == Sky::Dusk) return sprites::SKY_DUSK;
  return sprites::SKY_NIGHT;
}

uint16_t screenColor(char activity) {
  if (activity == 's') return sprites::SCREEN_OFF;
  if (activity == 'i') return sprites::SCREEN_IDLE;
  return sprites::SCREEN_ON;
}

/** Table clé → couleur d'une session : palette fixe plus couleurs calculées (colorsFor dans web/sprites.js). */
class Colors {
 public:
  Colors(const mascots::Session& session, int hour) {
    memset(known_, 0, sizeof(known_));
    for (uint8_t i = 0; i < sprites::PALETTE_COUNT; i++) set(sprites::PALETTE[i].key, sprites::PALETTE[i].rgb565);

    const sprites::ColorPair& skin = sprites::SKIN_TONES[session.skin < sprites::SKIN_TONES_COUNT ? session.skin : 0];
    const sprites::ColorPair& hair = sprites::HAIR_COLORS[session.hair < sprites::HAIR_COLORS_COUNT ? session.hair : 0];
    set('S', skin.main);
    set('s', skin.shade);
    set('H', hair.main);
    set('h', hair.shade);
    set('T', hsl565(session.hue, 58, 56));
    set('t', hsl565(session.hue, 52, 40));
    set('Q', hsl565(session.hue, 42, 64));
    set('q', hsl565(session.hue, 38, 48));
    set('A', skyColor(skyPhase(hour)));
    set('M', screenColor(session.activity));
  }

  bool find(char key, uint16_t& color) const {
    const uint8_t index = static_cast<uint8_t>(key);
    if (index >= SIZE || !known_[index]) return false;
    color = color_[index];
    return true;
  }

  uint16_t get(char key) const {
    uint16_t color = 0;
    find(key, color);
    return color;
  }

 private:
  static constexpr uint8_t SIZE = 128;

  void set(char key, uint16_t color) {
    const uint8_t index = static_cast<uint8_t>(key);
    if (index >= SIZE) return;
    color_[index] = color;
    known_[index] = true;
  }

  uint16_t color_[SIZE];
  bool known_[SIZE];
};

/** Pose des pixels logiques dans le sprite de la chambre (échelle 1). */
class Painter {
 public:
  Painter(lgfx::LGFX_Sprite& canvas, const Colors& colors) : canvas_(canvas), colors_(colors) {}

  void rect(uint16_t color, int x, int y, int w = 1, int h = 1) { canvas_.fillRect(x, y, w, h, color); }

  void key(char key, int x, int y, int w = 1, int h = 1) {
    uint16_t color;
    if (colors_.find(key, color)) rect(color, x, y, w, h);
  }

  /** Sprite en lignes de caractères ; '.' et toute clé inconnue sont transparents. */
  void rows(const char* const* rows, int count, int originX, int originY) {
    for (int y = 0; y < count; y++) {
      for (int x = 0; rows[y][x] != '\0'; x++) key(rows[y][x], originX + x, originY + y);
    }
  }

  void layers(const sprites::Layer* layers, uint8_t count) {
    for (uint8_t i = 0; i < count; i++) {
      const sprites::Layer& layer = layers[i];
      if (layer.sprite >= 0) {
        const sprites::Sprite& sprite = sprites::SPRITES[layer.sprite];
        rows(sprite.rows, sprite.height, layer.x, layer.y);
      } else {
        key(layer.key, layer.x, layer.y, layer.width, layer.height);
      }
    }
  }

  uint16_t color(char key) const { return colors_.get(key); }

 private:
  lgfx::LGFX_Sprite& canvas_;
  const Colors& colors_;
};

void drawWindow(Painter& p, Sky sky, uint32_t frame) {
  const sprites::Area& area = sprites::WINDOW_AREA;
  if (sky == Sky::Day) {
    p.key('y', area.x + 9, area.y + 1, 2, 2);
  } else if (sky == Sky::Dusk) {
    p.key('o', area.x + 8, area.y + 3, 3, 2);
  } else {
    p.key('w', area.x + 1, area.y + 1, 2, 2);
    static constexpr int8_t STARS[4][2] = {{8, 2}, {10, 7}, {2, 8}, {9, 9}};
    for (int i = 0; i < 4; i++) {
      if ((frame + i * 5) % 20 < 16) p.key('Z', area.x + STARS[i][0], area.y + STARS[i][1]);
    }
  }
}

const sprites::Icon* findIcon(char code) {
  for (uint8_t i = 0; i < sprites::ICON_COUNT; i++) {
    if (sprites::ICONS[i].code == code) return &sprites::ICONS[i];
  }
  return nullptr;
}

/** L'écran montre l'outil en cours, une invite qui clignote, un économiseur, ou du code qui défile. */
void drawScreen(Painter& p, const mascots::Session& s, uint32_t frame) {
  const sprites::Area& area = sprites::SCREEN_AREA;
  if (s.activity == 's') return;
  if (s.activity == 'i') {
    const int step = (frame / 3) % 12;
    const int x = step < 6 ? step : 11 - step;
    p.key('c', area.x + 1 + x, area.y + 2 + (frame / 5) % 4);
    return;
  }
  if (s.activity == 'a') {
    if (frame % 8 < 5) {
      p.key('y', area.x + 3, area.y + 1, 2, 4);
      p.key('y', area.x + 3, area.y + 6, 2, 1);
    }
    return;
  }
  const sprites::Icon* icon = s.tool != '-' ? findIcon(s.tool) : nullptr;
  if (icon != nullptr) {
    p.rows(icon->rows, 8, area.x, area.y);
    return;
  }
  for (int line = 0; line < 4; line++) {
    const int length = 2 + (line * 3 + static_cast<int>(frame / 2)) % 5;
    p.key(line % 2 ? 'c' : 'w', area.x + 1, area.y + 1 + line * 2, length, 1);
  }
}

/** Yeux et bouche des têtes de face : un seul dessin de tête sert toutes les humeurs. */
void drawFace(Painter& p, const mascots::Session& s, uint32_t frame, int headX, int headY) {
  const bool asleep = s.activity == 's';
  const bool blink = !asleep && frame % 40 == 0;
  const int eyes[2][2] = {{sprites::EYE_LEFT_X, sprites::EYE_LEFT_Y}, {sprites::EYE_RIGHT_X, sprites::EYE_RIGHT_Y}};
  for (const auto& eye : eyes) {
    const int x = headX + eye[0];
    const int y = headY + eye[1];
    p.key(asleep || blink ? 's' : 'E', x, y);
    if (s.mood == 't' || s.mood == 'x') p.key('s', x, y + 1);
  }
  if (asleep) return;
  const int mx = headX + sprites::MOUTH_X;
  const int my = headY + sprites::MOUTH_Y;
  if (s.mood == 'h') {
    p.key('r', mx, my, 2, 1);
  } else if (s.mood == 'w' || s.mood == 'x') {
    p.key('E', mx, my, 2, 1);
  } else {
    p.key('s', mx, my, 2, 1);
  }
}

void drawSweat(Painter& p, int headX, int headY, uint32_t frame) {
  const int drip = (frame / 3) % 3;
  p.key('d', headX + 8, headY + 1 + drip, 1, 2);
  p.key('d', headX + 9, headY + 2 + drip);
}

void drawSleepingZ(Painter& p, int headX, int headY, uint32_t frame) {
  const int rise = (frame / 4) % 4;
  const int zs[2][2] = {{headX - 4, headY - 1 - rise}, {headX - 8, headY - 3 - (rise + 2) % 4}};
  for (const auto& z : zs) {
    p.key('Z', z[0], z[1], 3, 1);
    p.key('Z', z[0] + 1, z[1] + 1);
    p.key('Z', z[0], z[1] + 2, 3, 1);
  }
}

/** Bulle « ! » au-dessus de la tête : la session attend une réponse de l'utilisateur. */
void drawAlertBubble(Painter& p, int headX, int headY, uint32_t frame) {
  if (frame % 8 >= 6) return;
  const int x = headX + 7;
  const int y = headY - 9;
  p.key('k', x, y, 5, 8);
  p.key('w', x + 1, y + 1, 3, 6);
  p.key('r', x + 2, y + 2, 1, 2);
  p.key('r', x + 2, y + 5);
  p.key('k', x + 1, y + 8);
}

const char* const* headRows(bool front, uint8_t style) {
  const uint8_t index = style < sprites::HAIR_STYLE_COUNT ? style : 0;
  return front ? sprites::HEADS_FRONT[index] : sprites::HEADS_BACK[index];
}

void drawSleeper(Painter& p, const mascots::Session& s, uint32_t frame) {
  const int hx = sprites::SLEEP_HEAD_X;
  const int hy = sprites::SLEEP_HEAD_Y;
  p.rows(headRows(true, s.hairStyle), 8, hx, hy);
  drawFace(p, s, frame, hx, hy);
  p.layers(sprites::SLEEP_BLANKET, sprites::SLEEP_BLANKET_COUNT);
  drawSleepingZ(p, hx, hy, frame);
}

void drawSeated(Painter& p, const mascots::Session& s, uint32_t frame) {
  const bool exhausted = s.mood == 'x';
  const int typingPeriod = s.mood == 't' ? 8 : 4;
  const int typing = !exhausted && static_cast<int>(frame % typingPeriod) >= typingPeriod / 2 ? 1 : 0;
  const int hy = sprites::SIT_HEAD_Y + (exhausted ? 3 : 0);
  if (s.mood == 't' || exhausted) {
    p.rows(sprites::SPRITES[sprites::SPRITE_MUG].rows, sprites::SPRITES[sprites::SPRITE_MUG].height, sprites::MUG_DESK_X, sprites::MUG_DESK_Y);
  }
  p.rows(sprites::BODY_SIT[typing], sprites::BODY_SIT_HEIGHT, sprites::SIT_BODY_X, sprites::SIT_BODY_Y);
  p.rows(headRows(false, s.hairStyle), 8, sprites::SIT_HEAD_X, hy);
  p.layers(sprites::CHAIR, sprites::CHAIR_COUNT);
  if (s.mood == 'w' || exhausted) drawSweat(p, sprites::SIT_HEAD_X, hy, frame);
}

void drawStanding(Painter& p, const mascots::Session& s, uint32_t frame) {
  const int hx = sprites::STAND_HEAD_X;
  const int hy = sprites::STAND_HEAD_Y + (frame % 12 < 6 ? 0 : 1);
  p.layers(sprites::CHAIR, sprites::CHAIR_COUNT);
  p.rows(sprites::BODY_STAND, sprites::BODY_STAND_HEIGHT, sprites::STAND_BODY_X, sprites::STAND_BODY_Y);
  p.rows(headRows(true, s.hairStyle), 8, hx, hy);
  drawFace(p, s, frame, hx, hy);
  if (s.activity == 'i') {
    p.rows(sprites::SPRITES[sprites::SPRITE_MUG].rows, sprites::SPRITES[sprites::SPRITE_MUG].height, sprites::MUG_HAND_X, sprites::MUG_HAND_Y);
  }
  if (s.activity == 'a') drawAlertBubble(p, hx, hy, frame);
  if (s.mood == 'w' || s.mood == 'x') drawSweat(p, hx, hy, frame);
}

/** Pose selon l'activité : dort (couché), travaille (assis au bureau), sinon debout. */
void drawOccupant(Painter& p, const mascots::Session& s, uint32_t frame) {
  if (s.activity == 's') {
    drawSleeper(p, s, frame);
  } else if (s.activity == 'w') {
    drawSeated(p, s, frame);
  } else {
    drawStanding(p, s, frame);
  }
}

bool allocate(lgfx::LGFX_Sprite& sprite, int width, int height) {
  sprite.deleteSprite();
  sprite.setColorDepth(16);
  return sprite.createSprite(width, height) != nullptr;
}

}  // namespace

uint16_t hsl565(int hue, int saturation, int lightness) {
  const float s = saturation / 100.0f;
  const float l = lightness / 100.0f;
  const float chroma = (1.0f - fabsf(2.0f * l - 1.0f)) * s;
  const float h = (((hue % 360) + 360) % 360) / 60.0f;
  const float x = chroma * (1.0f - fabsf(fmodf(h, 2.0f) - 1.0f));
  float r = 0, g = 0, b = 0;
  if (h < 1) { r = chroma; g = x; }
  else if (h < 2) { r = x; g = chroma; }
  else if (h < 3) { g = chroma; b = x; }
  else if (h < 4) { g = x; b = chroma; }
  else if (h < 5) { r = x; b = chroma; }
  else { r = chroma; b = x; }
  const float m = l - chroma / 2.0f;
  // Arrondi à l'octet comme le navigateur, puis troncature RGB565 par color565.
  const auto channel = [m](float v) { return static_cast<uint8_t>(roundf((v + m) * 255.0f)); };
  return lgfx::color565(channel(r), channel(g), channel(b));
}

bool createRoom(lgfx::LGFX_Sprite& room) { return allocate(room, WIDTH, HEIGHT); }

bool createStrip(lgfx::LGFX_Sprite& strip, int scale) { return allocate(strip, WIDTH * scale, STRIP_ROWS * scale); }

void draw(lgfx::LGFX_Sprite& room, const mascots::Session& session, uint32_t frame, int hour) {
  const Colors colors(session, hour);
  Painter painter(room, colors);
  painter.layers(sprites::BACKGROUND, sprites::BACKGROUND_COUNT);
  drawWindow(painter, skyPhase(hour), frame);
  drawScreen(painter, session, frame);
  drawOccupant(painter, session, frame);
}

void push(lgfx::LGFX_Sprite& room, lgfx::LGFX_Sprite& strip, int x, int y, int scale) {
  if (scale <= 1) {
    room.pushSprite(x, y);
    return;
  }
  // Les deux sprites sont en 16 bits au même format interne : on recopie les mots bruts sans conversion.
  const uint16_t* source = static_cast<const uint16_t*>(room.getBuffer());
  uint16_t* target = static_cast<uint16_t*>(strip.getBuffer());
  if (source == nullptr || target == nullptr) return;
  const int stripWidth = WIDTH * scale;
  for (int firstRow = 0; firstRow < HEIGHT; firstRow += STRIP_ROWS) {
    for (int row = 0; row < STRIP_ROWS; row++) {
      uint16_t* line = target + row * scale * stripWidth;
      const uint16_t* pixels = source + (firstRow + row) * WIDTH;
      for (int column = 0; column < WIDTH; column++) {
        for (int k = 0; k < scale; k++) line[column * scale + k] = pixels[column];
      }
      for (int k = 1; k < scale; k++) memcpy(line + k * stripWidth, line, stripWidth * sizeof(uint16_t));
    }
    strip.pushSprite(x, y + firstRow * scale);
  }
}

}  // namespace scene
