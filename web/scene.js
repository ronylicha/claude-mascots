// Peinture des chambres (moteur : sprites.js) et des icônes d'outils sur des canvas.
import { ROOM_HEIGHT, ROOM_WIDTH, colorsFor, drawRoomScene } from "./sprites.js";

/**
 * Un canvas de 64x40 pixels logiques, agrandi en CSS. Ne repeint que si la vue, l'image d'animation
 * ou l'heure ont changé : le rendu tourne à 8 images/s, pas à 60.
 */
export class RoomPainter {
  constructor(canvas, sprites) {
    canvas.width = ROOM_WIDTH;
    canvas.height = ROOM_HEIGHT;
    this.context = canvas.getContext("2d");
    this.context.imageSmoothingEnabled = false;
    this.sprites = sprites;
    this.drawn = null;
  }

  paint(view, frame, hour) {
    const last = this.drawn;
    if (last && last.view === view && last.frame === frame && last.hour === hour) return;
    this.context.clearRect(0, 0, ROOM_WIDTH, ROOM_HEIGHT);
    drawRoomScene(this.context, this.sprites, view, frame, hour);
    this.drawn = { view, frame, hour };
  }
}

/** Vue neutre : seule la palette sert ici, pas l'avatar. */
const ICON_VIEW = { activity: "working", avatar: { skin: 0, hair: 0, hairStyle: 0, hue: 260 } };

/** Dessine l'icône 8x8 d'une catégorie d'outil, sur le fond sombre du moniteur de la chambre. */
export function drawToolIcon(canvas, sprites, kind) {
  const rows = sprites.icons[kind] ?? sprites.icons.other;
  canvas.width = rows[0].length;
  canvas.height = rows.length;
  const context = canvas.getContext("2d");
  const colors = colorsFor(sprites, ICON_VIEW, 12);
  context.fillStyle = sprites.screen.on;
  context.fillRect(0, 0, canvas.width, canvas.height);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const color = colors[row[x]];
      if (!color) continue;
      context.fillStyle = color;
      context.fillRect(x, y, 1, 1);
    }
  });
}
