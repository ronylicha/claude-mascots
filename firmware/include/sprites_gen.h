// AUTO-GÉNÉRÉ — NE PAS MODIFIER. Source : shared/sprites.json
// Regénérer : node tools/gen-sprites-header.ts
// Rendu de référence : web/sprites.js (drawRoomScene) ; portage : firmware/src/scene.cpp.
#pragma once
#include <stdint.h>

namespace sprites {

constexpr int ROOM_WIDTH = 64;
constexpr int ROOM_HEIGHT = 40;

struct PaletteEntry {
  char key;
  uint16_t rgb565;
};

struct ColorPair {
  uint16_t main;
  uint16_t shade;
};

struct Sprite {
  uint8_t width;
  uint8_t height;
  const char* const* rows;
};

/** Rectangle plein de couleur `key` (sprite = -1) ou sprite `sprite` posé en (x, y). */
struct Layer {
  int8_t x;
  int8_t y;
  uint8_t width;
  uint8_t height;
  char key;
  int8_t sprite;
};

struct Area {
  int8_t x;
  int8_t y;
  uint8_t width;
  uint8_t height;
};

struct Icon {
  char code;  // code d'outil du protocole série (champ `k`)
  const char* rows[8];
};

// Couleurs fixes ; S/s, H/h, T/t, Q/q, A et M sont calculées par le code (voir web/sprites.js).
static const PaletteEntry PALETTE[] = {
  {'k', 0x18C5},
  {'w', 0xF7BE},
  {'p', 0xEF18},
  {'P', 0xCDF3},
  {'y', 0xF649},
  {'r', 0xE249},
  {'g', 0x5B0E},
  {'c', 0x5696},
  {'b', 0x4C7E},
  {'o', 0xF4E8},
  {'n', 0x8AC7},
  {'W', 0x4A6F},
  {'V', 0x424E},
  {'D', 0x2969},
  {'F', 0x9B28},
  {'f', 0x7A66},
  {'m', 0xB3C9},
  {'N', 0x6A05},
  {'G', 0x2967},
  {'x', 0x39EA},
  {'u', 0xAA0B},
  {'U', 0xD3CD},
  {'l', 0x558D},
  {'L', 0x2BE9},
  {'a', 0xCB67},
  {'j', 0x3943},
  {'J', 0x320D},
  {'E', 0x1083},
  {'Z', 0xCE9F},
  {'d', 0x7E3F}
};
static const uint8_t PALETTE_COUNT = 30;

static const ColorPair SKIN_TONES[] = {{0xF696, 0xDD50}, {0xE570, 0xC44B}, {0xBBCA, 0x92E7}, {0x7A66, 0x61C4}};
static const uint8_t SKIN_TONES_COUNT = 4;
static const ColorPair HAIR_COLORS[] = {{0x28E2, 0x1881}, {0x69E4, 0x4962}, {0xCC47, 0xA345}, {0xE671, 0xBD4C}, {0xA1C5, 0x7943}, {0x9CF6, 0x73D1}};
static const uint8_t HAIR_COLORS_COUNT = 6;

constexpr uint16_t SKY_DAY = 0x8E3F;
constexpr uint16_t SKY_DUSK = 0xF52D;
constexpr uint16_t SKY_NIGHT = 0x1908;
constexpr uint16_t SCREEN_ON = 0x19AA;
constexpr uint16_t SCREEN_IDLE = 0x1905;
constexpr uint16_t SCREEN_OFF = 0x0862;

static const char* const SPRITE_POSTER_ROWS[] = {"NNNNNNN", "NbbbbyN", "NbbbbbN", "NbblbbN", "NblllbN", "NllLllN", "NlLLLlN", "NNNNNNN"};
static const char* const SPRITE_BOOKS_ROWS[] = {"r.g..o...", "rbg.co...", "rbgycon..", "rbgyconw.", "rbgyconw."};
static const char* const SPRITE_CLOCK_ROWS[] = {".kkkkk.", "kwwkwwk", "kwwkwwk", "kwwkkwk", "kwwwwwk", "kwwwwwk", ".kkkkk."};
static const char* const SPRITE_PLANT_ROWS[] = {".l.L.", "lLlLl", ".lLl.", "LlLlL", ".lLl.", "..L..", ".aaa.", "aaaaa", ".aaa.", ".aaa."};
static const char* const SPRITE_MUG_ROWS[] = {"..w.", ".w..", "kkk.", "kokk", "kok.", "kkk."};

enum SpriteId : uint8_t {
  SPRITE_POSTER = 0,
  SPRITE_BOOKS = 1,
  SPRITE_CLOCK = 2,
  SPRITE_PLANT = 3,
  SPRITE_MUG = 4
};

static const Sprite SPRITES[] = {
  {7, 8, SPRITE_POSTER_ROWS},
  {9, 5, SPRITE_BOOKS_ROWS},
  {7, 7, SPRITE_CLOCK_ROWS},
  {5, 10, SPRITE_PLANT_ROWS},
  {4, 6, SPRITE_MUG_ROWS}
};

static const Layer BACKGROUND[] = {
  {0, 0, 64, 25, 'W', -1},
  {1, 0, 1, 25, 'V', -1},
  {9, 0, 1, 25, 'V', -1},
  {17, 0, 1, 25, 'V', -1},
  {25, 0, 1, 25, 'V', -1},
  {33, 0, 1, 25, 'V', -1},
  {41, 0, 1, 25, 'V', -1},
  {49, 0, 1, 25, 'V', -1},
  {57, 0, 1, 25, 'V', -1},
  {0, 25, 64, 2, 'D', -1},
  {0, 27, 64, 13, 'F', -1},
  {0, 31, 64, 1, 'f', -1},
  {0, 35, 64, 1, 'f', -1},
  {14, 27, 1, 4, 'f', -1},
  {44, 27, 1, 4, 'f', -1},
  {28, 32, 1, 3, 'f', -1},
  {56, 32, 1, 3, 'f', -1},
  {7, 36, 1, 4, 'f', -1},
  {37, 36, 1, 4, 'f', -1},
  {6, 32, 26, 5, 'u', -1},
  {6, 32, 26, 1, 'U', -1},
  {6, 36, 26, 1, 'U', -1},
  {10, 34, 1, 1, 'U', -1},
  {16, 34, 1, 1, 'U', -1},
  {22, 34, 1, 1, 'U', -1},
  {28, 34, 1, 1, 'U', -1},
  {2, 2, 21, 1, 'N', -1},
  {5, 3, 14, 13, 'm', -1},
  {6, 4, 12, 11, 'A', -1},
  {11, 4, 2, 11, 'm', -1},
  {6, 9, 12, 1, 'm', -1},
  {4, 16, 16, 1, 'N', -1},
  {3, 3, 3, 15, 'u', -1},
  {4, 3, 1, 15, 'U', -1},
  {18, 3, 3, 15, 'u', -1},
  {19, 3, 1, 15, 'U', -1},
  {23, 4, 0, 0, 0, 0},
  {31, 1, 0, 0, 0, 1},
  {30, 6, 11, 1, 'N', -1},
  {49, 4, 0, 0, 0, 2},
  {0, 27, 0, 0, 0, 3},
  {17, 21, 24, 2, 'm', -1},
  {17, 23, 24, 1, 'N', -1},
  {18, 24, 2, 8, 'N', -1},
  {38, 24, 2, 8, 'N', -1},
  {31, 24, 6, 4, 'm', -1},
  {33, 25, 2, 1, 'N', -1},
  {30, 10, 10, 10, 'G', -1},
  {31, 11, 8, 8, 'M', -1},
  {34, 20, 2, 1, 'G', -1},
  {40, 32, 23, 1, 'j', -1},
  {59, 14, 4, 17, 'm', -1},
  {58, 14, 6, 1, 'N', -1},
  {41, 20, 3, 11, 'm', -1},
  {40, 20, 5, 1, 'N', -1},
  {44, 27, 15, 3, 'm', -1},
  {44, 30, 15, 1, 'N', -1},
  {44, 24, 15, 3, 'p', -1},
  {53, 21, 6, 3, 'p', -1},
  {53, 23, 6, 1, 'P', -1},
  {44, 22, 9, 5, 'Q', -1},
  {44, 26, 9, 1, 'q', -1},
  {41, 31, 2, 1, 'N', -1},
  {60, 31, 2, 1, 'N', -1}
};
static const uint8_t BACKGROUND_COUNT = 64;

static const Layer CHAIR[] = {
  {22, 23, 8, 4, 'x', -1},
  {22, 23, 8, 1, 'g', -1},
  {25, 27, 2, 3, 'x', -1},
  {22, 30, 8, 1, 'x', -1},
  {22, 31, 1, 1, 'k', -1},
  {29, 31, 1, 1, 'k', -1}
};
static const uint8_t CHAIR_COUNT = 6;

static const Layer SLEEP_BLANKET[] = {
  {44, 23, 13, 4, 'Q', -1},
  {46, 22, 7, 1, 'Q', -1},
  {44, 26, 13, 1, 'q', -1},
  {53, 23, 4, 1, 'w', -1}
};
static const uint8_t SLEEP_BLANKET_COUNT = 4;

// Têtes 8x8 indexées par coiffure (champ `hs`).
static const char* const HEADS_FRONT[][8] = {
  {"..kkkk..", ".kHHHHk.", "kHHHHHHk", "kHSSSSHk", "kSSSSSSk", "kSSSSSSk", ".kSSSSk.", "..kkkk.."},
  {"..kkkk..", ".kHHHHk.", "kHHHHHHk", "kHSSSSHk", "kHSSSSHk", "kHSSSSHk", "kHkSSkHk", ".k.kk.k."},
  {"..kHHk..", ".kkHHkk.", "kHHHHHHk", "kHSSSSHk", "kSSSSSSk", "kSSSSSSk", ".kSSSSk.", "..kkkk.."}
};
static const char* const HEADS_BACK[][8] = {
  {"..kkkk..", ".kHHHHk.", "kHHHHHHk", "kHHHHHHk", "kHHHHHHk", "kShhhhSk", ".kSSSSk.", "..kSSk.."},
  {"..kkkk..", ".kHHHHk.", "kHHHHHHk", "kHHHHHHk", "kHHHHHHk", "kHHHHHHk", "kHHHHHHk", ".khhhhk."},
  {"..kHHk..", ".kkhhkk.", "kHHHHHHk", "kHHHHHHk", "kHHHHHHk", "kShhhhSk", ".kSSSSk.", "..kSSk.."}
};
static const uint8_t HAIR_STYLE_COUNT = 3;

constexpr int8_t EYE_LEFT_X = 2;
constexpr int8_t EYE_LEFT_Y = 4;
constexpr int8_t EYE_RIGHT_X = 5;
constexpr int8_t EYE_RIGHT_Y = 4;
constexpr int8_t MOUTH_X = 3;
constexpr int8_t MOUTH_Y = 6;

static const char* const BODY_SIT[][7] = {
  {"..kkTTkk..", ".kTTTTTTk.", "kTTTTTTTTk", "ktTTTTTTtk", "ktkTTTTktk", "kkTTTTTTkk", ".kTTTTTTk."},
  {"..kkTTkk..", ".kTTTTTTk.", "ktTTTTTTtk", "ktkTTTTktk", "kkTTTTTTkk", ".kTTTTTTk.", ".kTTTTTTk."}
};
constexpr uint8_t BODY_SIT_WIDTH = 10;
constexpr uint8_t BODY_SIT_HEIGHT = 7;
static const char* const BODY_STAND[] = {"..kTTk..", ".kTTTTk.", "kTTTTTTk", "kTtTTtTk", "kTtTTtTk", "kSkttkSk", ".kJJJJk.", ".kJJJJk.", ".kJkkJk.", ".kJ..Jk.", ".kk..kk."};
constexpr uint8_t BODY_STAND_WIDTH = 8;
constexpr uint8_t BODY_STAND_HEIGHT = 11;

constexpr int8_t SIT_HEAD_X = 22;
constexpr int8_t SIT_HEAD_Y = 10;
constexpr int8_t SIT_BODY_X = 21;
constexpr int8_t SIT_BODY_Y = 18;
constexpr int8_t STAND_HEAD_X = 10;
constexpr int8_t STAND_HEAD_Y = 18;
constexpr int8_t STAND_BODY_X = 10;
constexpr int8_t STAND_BODY_Y = 26;
constexpr int8_t SLEEP_HEAD_X = 51;
constexpr int8_t SLEEP_HEAD_Y = 17;
constexpr int8_t MUG_DESK_X = 17;
constexpr int8_t MUG_DESK_Y = 15;
constexpr int8_t MUG_HAND_X = 17;
constexpr int8_t MUG_HAND_Y = 27;

constexpr Area SCREEN_AREA = {31, 11, 8, 8};
constexpr Area WINDOW_AREA = {6, 4, 12, 11};

static const Icon ICONS[] = {
  {'r', {"........", ".kk..kk.", "kppkkppk", "kppkkppk", "kppkkppk", "kppkkppk", ".kkkkkk.", "........"}},
  {'e', {"......kk", ".....kyk", "....kyyk", "...kyyk.", "..kyyk..", ".kpyk...", ".kpk....", "kk......"}},
  {'b', {"kkkkkkkk", "kggggggk", "kgcggggk", "kggcgggk", "kgcggggk", "kgggccck", "kggggggk", "kkkkkkkk"}},
  {'s', {".kkkk...", "kcwcck..", "kcccck..", "kcccck..", ".kkkk...", "....nn..", ".....nn.", "......nn"}},
  {'d', {"........", ".kk..kk.", "kbbkkook", "kwbkkwok", "kbbkkook", ".kk..kk.", "........", "........"}},
  {'t', {".kkkkk..", "kwwwwwk.", "kwkwkwk.", "kwwwwwk.", ".kkkkk..", "..kk....", ".kk.....", "........"}},
  {'o', {"...kk...", ".kkggkk.", ".kggggk.", "kggkkggk", "kggkkggk", ".kggggk.", ".kkggkk.", "...kk..."}}
};
static const uint8_t ICON_COUNT = 7;

}  // namespace sprites
