// Génère firmware/include/sprites_gen.h depuis shared/sprites.json (source unique navigateur + ESP32).
// Usage : node tools/gen-sprites-header.ts [--check]
//   --check : sort en 1 si l'en-tête versionné n'est plus à jour (CI).

import { readFile, writeFile } from "node:fs/promises";
import { TOOL_CODE } from "../host/src/transport/deviceFrame.ts";

const SOURCE = new URL("../shared/sprites.json", import.meta.url);
const TARGET = new URL("../firmware/include/sprites_gen.h", import.meta.url);

interface RectLayer {
  x: number;
  y: number;
  w: number;
  h: number;
  c: string;
}
interface SpriteLayer {
  sprite: string;
  x: number;
  y: number;
}
type Layer = RectLayer | SpriteLayer;
type Point = [number, number];
interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpriteFile {
  room: { width: number; height: number };
  palette: Record<string, string>;
  skin_tones: [string, string][];
  hair_colors: [string, string][];
  sky: { day: string; dusk: string; night: string };
  screen: { on: string; idle: string; off: string };
  background: Layer[];
  chair: Layer[];
  sleep_blanket: Layer[];
  sprites: Record<string, string[]>;
  heads: { front: string[][]; back: string[][] };
  face: { eyes: [Point, Point]; mouth: Point };
  bodies: { sit: string[][]; stand: string[] };
  anchors: {
    sit: { head: Point; body: Point };
    stand: { head: Point; body: Point };
    sleep: { head: Point };
    mug_desk: Point;
    mug_hand: Point;
  };
  screen_area: Area;
  window_area: Area;
  icons: Record<string, string[]>;
}

export function toRgb565(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  const packed = ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
  return `0x${packed.toString(16).padStart(4, "0").toUpperCase()}`;
}

const quote = (row: string): string => `"${row}"`;
const rowsLiteral = (rows: string[]): string => `{${rows.map(quote).join(", ")}}`;
const constantName = (key: string): string => key.toUpperCase().replace(/[^A-Z0-9]/g, "_");

function layersLiteral(name: string, layers: Layer[], spriteIds: string[]): string {
  const entries = layers.map((layer) => {
    if ("sprite" in layer) {
      const index = spriteIds.indexOf(layer.sprite);
      if (index < 0) throw new Error(`${name} : sprite « ${layer.sprite} » inconnu`);
      return `  {${layer.x}, ${layer.y}, 0, 0, 0, ${index}}`;
    }
    return `  {${layer.x}, ${layer.y}, ${layer.w}, ${layer.h}, '${layer.c}', -1}`;
  });
  return `static const Layer ${name}[] = {\n${entries.join(",\n")}\n};\nstatic const uint8_t ${name}_COUNT = ${layers.length};`;
}

function pairsLiteral(name: string, pairs: [string, string][]): string {
  const entries = pairs.map(([main, shade]) => `{${toRgb565(main)}, ${toRgb565(shade)}}`);
  return `static const ColorPair ${name}[] = {${entries.join(", ")}};\nstatic const uint8_t ${name}_COUNT = ${pairs.length};`;
}

function headsLiteral(name: string, heads: string[][]): string {
  return `static const char* const ${name}[][8] = {\n  ${heads.map(rowsLiteral).join(",\n  ")}\n};`;
}

const point = (name: string, [x, y]: Point): string => `constexpr int8_t ${name}_X = ${x};\nconstexpr int8_t ${name}_Y = ${y};`;
const area = (name: string, value: Area): string => `constexpr Area ${name} = {${value.x}, ${value.y}, ${value.w}, ${value.h}};`;

export function renderHeader(sprites: SpriteFile): string {
  const spriteIds = Object.keys(sprites.sprites);
  const spriteRows = spriteIds.map((id) => `static const char* const SPRITE_${constantName(id)}_ROWS[] = ${rowsLiteral(sprites.sprites[id] ?? [])};`);
  const spriteTable = spriteIds.map((id) => {
    const rows = sprites.sprites[id] ?? [];
    return `  {${rows[0]?.length ?? 0}, ${rows.length}, SPRITE_${constantName(id)}_ROWS}`;
  });
  const spriteEnum = spriteIds.map((id, index) => `  SPRITE_${constantName(id)} = ${index}`);
  const palette = Object.entries(sprites.palette).map(([key, hex]) => `  {'${key}', ${toRgb565(hex)}}`);
  const icons = Object.entries(TOOL_CODE).map(([kind, code]) => {
    const rows = sprites.icons[kind];
    if (!rows) throw new Error(`icône « ${kind} » absente de sprites.json`);
    return `  {'${code}', ${rowsLiteral(rows)}}`;
  });
  const { anchors, face } = sprites;

  return `// AUTO-GÉNÉRÉ — NE PAS MODIFIER. Source : shared/sprites.json
// Regénérer : node tools/gen-sprites-header.ts
// Rendu de référence : web/sprites.js (drawRoomScene) ; portage : firmware/src/scene.cpp.
#pragma once
#include <stdint.h>

namespace sprites {

constexpr int ROOM_WIDTH = ${sprites.room.width};
constexpr int ROOM_HEIGHT = ${sprites.room.height};

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

/** Rectangle plein de couleur \`key\` (sprite = -1) ou sprite \`sprite\` posé en (x, y). */
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
  char code;  // code d'outil du protocole série (champ \`k\`)
  const char* rows[8];
};

// Couleurs fixes ; S/s, H/h, T/t, Q/q, A et M sont calculées par le code (voir web/sprites.js).
static const PaletteEntry PALETTE[] = {
${palette.join(",\n")}
};
static const uint8_t PALETTE_COUNT = ${palette.length};

${pairsLiteral("SKIN_TONES", sprites.skin_tones)}
${pairsLiteral("HAIR_COLORS", sprites.hair_colors)}

constexpr uint16_t SKY_DAY = ${toRgb565(sprites.sky.day)};
constexpr uint16_t SKY_DUSK = ${toRgb565(sprites.sky.dusk)};
constexpr uint16_t SKY_NIGHT = ${toRgb565(sprites.sky.night)};
constexpr uint16_t SCREEN_ON = ${toRgb565(sprites.screen.on)};
constexpr uint16_t SCREEN_IDLE = ${toRgb565(sprites.screen.idle)};
constexpr uint16_t SCREEN_OFF = ${toRgb565(sprites.screen.off)};

${spriteRows.join("\n")}

enum SpriteId : uint8_t {
${spriteEnum.join(",\n")}
};

static const Sprite SPRITES[] = {
${spriteTable.join(",\n")}
};

${layersLiteral("BACKGROUND", sprites.background, spriteIds)}

${layersLiteral("CHAIR", sprites.chair, spriteIds)}

${layersLiteral("SLEEP_BLANKET", sprites.sleep_blanket, spriteIds)}

// Têtes 8x8 indexées par coiffure (champ \`hs\`).
${headsLiteral("HEADS_FRONT", sprites.heads.front)}
${headsLiteral("HEADS_BACK", sprites.heads.back)}
static const uint8_t HAIR_STYLE_COUNT = ${sprites.heads.front.length};

${point("EYE_LEFT", face.eyes[0])}
${point("EYE_RIGHT", face.eyes[1])}
${point("MOUTH", face.mouth)}

static const char* const BODY_SIT[][${sprites.bodies.sit[0]?.length ?? 0}] = {
  ${sprites.bodies.sit.map(rowsLiteral).join(",\n  ")}
};
constexpr uint8_t BODY_SIT_WIDTH = ${sprites.bodies.sit[0]?.[0]?.length ?? 0};
constexpr uint8_t BODY_SIT_HEIGHT = ${sprites.bodies.sit[0]?.length ?? 0};
static const char* const BODY_STAND[] = ${rowsLiteral(sprites.bodies.stand)};
constexpr uint8_t BODY_STAND_WIDTH = ${sprites.bodies.stand[0]?.length ?? 0};
constexpr uint8_t BODY_STAND_HEIGHT = ${sprites.bodies.stand.length};

${point("SIT_HEAD", anchors.sit.head)}
${point("SIT_BODY", anchors.sit.body)}
${point("STAND_HEAD", anchors.stand.head)}
${point("STAND_BODY", anchors.stand.body)}
${point("SLEEP_HEAD", anchors.sleep.head)}
${point("MUG_DESK", anchors.mug_desk)}
${point("MUG_HAND", anchors.mug_hand)}

${area("SCREEN_AREA", sprites.screen_area)}
${area("WINDOW_AREA", sprites.window_area)}

static const Icon ICONS[] = {
${icons.join(",\n")}
};
static const uint8_t ICON_COUNT = ${icons.length};

}  // namespace sprites
`;
}

const header = renderHeader(JSON.parse(await readFile(SOURCE, "utf8")) as SpriteFile);

if (process.argv.includes("--check")) {
  const current = await readFile(TARGET, "utf8").catch(() => "");
  if (current !== header) {
    console.error("firmware/include/sprites_gen.h n'est plus à jour : lancer `node tools/gen-sprites-header.ts`.");
    process.exit(1);
  }
  console.log("sprites_gen.h à jour.");
} else {
  await writeFile(TARGET, header);
  console.log("firmware/include/sprites_gen.h régénéré.");
}
