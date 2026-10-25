import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { HAIR_COLOR_COUNT, HAIR_STYLE_COUNT, SKIN_TONE_COUNT } from "../src/domain/avatar.ts";

type Point = [number, number];
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  c: string;
}
interface Placed {
  sprite: string;
  x: number;
  y: number;
}
interface SpriteFile {
  room: { width: number; height: number };
  palette: Record<string, string>;
  skin_tones: string[][];
  hair_colors: string[][];
  background: (Rect | Placed)[];
  chair: (Rect | Placed)[];
  sleep_blanket: (Rect | Placed)[];
  sprites: Record<string, string[]>;
  heads: { front: string[][]; back: string[][] };
  face: { eyes: Point[]; mouth: Point };
  bodies: { sit: string[][]; stand: string[] };
  anchors: Record<string, unknown>;
  icons: Record<string, string[]>;
}

const sprites = JSON.parse(await readFile(new URL("../../shared/sprites.json", import.meta.url), "utf8")) as SpriteFile;
const TOOL_KINDS = ["read", "write", "run", "search", "delegate", "think", "other"];
// Clés dont la couleur est calculée par le code (voir web/sprites.js colorsFor).
const DYNAMIC_KEYS = ["S", "s", "H", "h", "T", "t", "Q", "q", "A", "M"];
const allowedKeys = new Set([".", ...Object.keys(sprites.palette), ...DYNAMIC_KEYS]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function assertGrid(label: string, rows: string[], width: number, height: number): void {
  assert.equal(rows.length, height, `${label} : ${rows.length} lignes au lieu de ${height}`);
  for (const row of rows) {
    assert.equal(row.length, width, `${label} : ligne « ${row} »`);
    for (const key of row) assert.ok(allowedKeys.has(key), `${label} : couleur « ${key} » inconnue`);
  }
}

function assertLayersInRoom(label: string, layers: (Rect | Placed)[]): void {
  for (const layer of layers) {
    if ("sprite" in layer) {
      const rows = sprites.sprites[layer.sprite];
      assert.ok(rows, `${label} : sprite « ${layer.sprite} » inconnu`);
      assert.ok(layer.x + (rows[0]?.length ?? 0) <= sprites.room.width && layer.y + rows.length <= sprites.room.height, `${label} : ${layer.sprite} déborde`);
      continue;
    }
    assert.ok(allowedKeys.has(layer.c) && layer.c !== ".", `${label} : couleur « ${layer.c} » inconnue`);
    assert.ok(layer.x >= 0 && layer.y >= 0 && layer.w > 0 && layer.h > 0, `${label} : rectangle invalide`);
    assert.ok(layer.x + layer.w <= sprites.room.width && layer.y + layer.h <= sprites.room.height, `${label} : rectangle hors de la pièce`);
  }
}

describe("shared sprites", () => {
  it("keeps palette keys to one character and colors to #rrggbb", () => {
    for (const [key, hex] of Object.entries(sprites.palette)) {
      assert.equal(key.length, 1, key);
      assert.match(hex, HEX_COLOR, key);
      assert.ok(!DYNAMIC_KEYS.includes(key), `« ${key} » est réservée aux couleurs calculées`);
    }
  });

  it("offers exactly the skin tones, hair colors and hair styles the host can assign", () => {
    assert.equal(sprites.skin_tones.length, SKIN_TONE_COUNT);
    assert.equal(sprites.hair_colors.length, HAIR_COLOR_COUNT);
    assert.equal(sprites.heads.front.length, HAIR_STYLE_COUNT);
    assert.equal(sprites.heads.back.length, HAIR_STYLE_COUNT);
    for (const pair of [...sprites.skin_tones, ...sprites.hair_colors]) {
      assert.equal(pair.length, 2);
      for (const hex of pair) assert.match(hex, HEX_COLOR);
    }
  });

  it("keeps every layer inside the 64x40 room", () => {
    assert.deepEqual(sprites.room, { width: 64, height: 40 });
    assertLayersInRoom("background", sprites.background);
    assertLayersInRoom("chair", sprites.chair);
    assertLayersInRoom("sleep_blanket", sprites.sleep_blanket);
  });

  it("draws 8x8 heads with the eyes and mouth on skin for front views", () => {
    for (const [index, head] of sprites.heads.front.entries()) {
      assertGrid(`tête de face ${index}`, head, 8, 8);
      for (const [x, y] of [...sprites.face.eyes, sprites.face.mouth, [sprites.face.mouth[0] + 1, sprites.face.mouth[1]] as Point]) {
        assert.equal(head[y]?.[x], "S", `tête de face ${index} : (${x},${y}) n'est pas de la peau`);
      }
    }
    for (const [index, head] of sprites.heads.back.entries()) assertGrid(`tête de dos ${index}`, head, 8, 8);
  });

  it("gives the seated pose two typing frames of the same size", () => {
    assert.equal(sprites.bodies.sit.length, 2);
    for (const frame of sprites.bodies.sit) assertGrid("assis", frame, 10, 7);
    assertGrid("debout", sprites.bodies.stand, 8, 11);
  });

  it("validates the decorative sprites", () => {
    for (const [name, rows] of Object.entries(sprites.sprites)) assertGrid(name, rows, rows[0]?.length ?? 0, rows.length);
  });

  it("has one 8x8 icon per tool kind with known colors", () => {
    assert.deepEqual(Object.keys(sprites.icons).toSorted(), TOOL_KINDS.toSorted());
    for (const [name, rows] of Object.entries(sprites.icons)) assertGrid(`icône ${name}`, rows, 8, 8);
  });
});
