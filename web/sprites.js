// Rendu pixel art d'une chambre et de son occupant à partir de shared/sprites.json.
// Référence exacte du portage firmware (firmware/src/scene.cpp) : toute règle changée ici doit l'être là-bas.

export const ROOM_WIDTH = 64;
export const ROOM_HEIGHT = 40;

export async function loadSprites() {
  const response = await fetch("/sprites.json");
  if (!response.ok) throw new Error(`sprites.json : HTTP ${response.status}`);
  return response.json();
}

/** Ciel de la fenêtre selon l'heure locale : la chambre vit au rythme de la journée. */
export function skyPhase(hour) {
  if (hour >= 7 && hour <= 17) return "day";
  if (hour === 6 || hour === 18 || hour === 19) return "dusk";
  return "night";
}

function screenState(activity) {
  if (activity === "sleeping") return "off";
  if (activity === "idle") return "idle";
  return "on";
}

/** Couleurs propres à une session : peau, cheveux, t-shirt et couverture dérivés de son avatar. */
export function colorsFor(sprites, view, hour) {
  const { skin, hair, hue } = view.avatar;
  const [skinMain, skinShade] = sprites.skin_tones[skin] ?? sprites.skin_tones[0];
  const [hairMain, hairShade] = sprites.hair_colors[hair] ?? sprites.hair_colors[0];
  return {
    ...sprites.palette,
    S: skinMain,
    s: skinShade,
    H: hairMain,
    h: hairShade,
    T: `hsl(${hue} 58% 56%)`,
    t: `hsl(${hue} 52% 40%)`,
    Q: `hsl(${hue} 42% 64%)`,
    q: `hsl(${hue} 38% 48%)`,
    A: sprites.sky[skyPhase(hour)],
    M: sprites.screen[screenState(view.activity)],
  };
}

function drawRows(ctx, rows, colors, originX, originY) {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const color = colors[row[x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(originX + x, originY + y, 1, 1);
    }
  });
}

function drawLayers(ctx, sprites, layers, colors) {
  for (const layer of layers) {
    if (layer.sprite) {
      drawRows(ctx, sprites.sprites[layer.sprite], colors, layer.x, layer.y);
      continue;
    }
    ctx.fillStyle = colors[layer.c];
    ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
  }
}

function pixel(ctx, color, x, y, w = 1, h = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function drawWindow(ctx, sprites, colors, hour, frame) {
  const area = sprites.window_area;
  const phase = skyPhase(hour);
  if (phase === "day") {
    pixel(ctx, colors.y, area.x + 9, area.y + 1, 2, 2);
  } else if (phase === "dusk") {
    pixel(ctx, colors.o, area.x + 8, area.y + 3, 3, 2);
  } else {
    pixel(ctx, colors.w, area.x + 1, area.y + 1, 2, 2);
    const stars = [[8, 2], [10, 7], [2, 8], [9, 9]];
    stars.forEach(([x, y], index) => {
      if ((frame + index * 5) % 20 < 16) pixel(ctx, colors.Z, area.x + x, area.y + y);
    });
  }
}

/** L'écran de l'ordinateur montre l'outil en cours, une invite qui clignote, ou un économiseur. */
function drawScreen(ctx, sprites, colors, view, frame) {
  const area = sprites.screen_area;
  if (view.activity === "sleeping") return;
  if (view.activity === "idle") {
    const step = Math.floor(frame / 3) % 12;
    const x = step < 6 ? step : 11 - step;
    pixel(ctx, colors.c, area.x + 1 + x, area.y + 2 + (Math.floor(frame / 5) % 4));
    return;
  }
  if (view.activity === "waiting") {
    if (frame % 8 < 5) {
      pixel(ctx, colors.y, area.x + 3, area.y + 1, 2, 4);
      pixel(ctx, colors.y, area.x + 3, area.y + 6, 2, 1);
    }
    return;
  }
  if (view.tool && sprites.icons[view.tool]) {
    drawRows(ctx, sprites.icons[view.tool], colors, area.x, area.y);
    return;
  }
  // Pas d'outil : des lignes de code qui défilent.
  for (let line = 0; line < 4; line += 1) {
    const length = 2 + ((line * 3 + Math.floor(frame / 2)) % 5);
    pixel(ctx, line % 2 ? colors.c : colors.w, area.x + 1, area.y + 1 + line * 2, length, 1);
  }
}

/** Yeux et bouche des têtes vues de face : un seul dessin de tête suffit pour toutes les humeurs. */
function drawFace(ctx, sprites, colors, view, frame, headX, headY) {
  const asleep = view.activity === "sleeping";
  const blink = !asleep && frame % 40 === 0;
  const [mouthX, mouthY] = sprites.face.mouth;
  for (const [eyeX, eyeY] of sprites.face.eyes) {
    const x = headX + eyeX;
    const y = headY + eyeY;
    pixel(ctx, asleep || blink ? colors.s : colors.E, x, y);
    if (view.mood === "tired" || view.mood === "exhausted") pixel(ctx, colors.s, x, y + 1);
  }
  const mx = headX + mouthX;
  const my = headY + mouthY;
  if (asleep) return;
  if (view.mood === "happy") {
    pixel(ctx, colors.r, mx, my, 2, 1);
  } else if (view.mood === "worried" || view.mood === "exhausted") {
    pixel(ctx, colors.E, mx, my, 2, 1);
  } else {
    pixel(ctx, colors.s, mx, my, 2, 1);
  }
}

function drawSweat(ctx, colors, headX, headY, frame) {
  const drip = Math.floor(frame / 3) % 3;
  pixel(ctx, colors.d, headX + 8, headY + 1 + drip, 1, 2);
  pixel(ctx, colors.d, headX + 9, headY + 2 + drip);
}

function drawSleep(ctx, colors, headX, headY, frame) {
  const rise = Math.floor(frame / 4) % 4;
  const zs = [[headX - 4, headY - 1 - rise], [headX - 8, headY - 3 - ((rise + 2) % 4)]];
  for (const [x, y] of zs) {
    pixel(ctx, colors.Z, x, y, 3, 1);
    pixel(ctx, colors.Z, x + 1, y + 1);
    pixel(ctx, colors.Z, x, y + 2, 3, 1);
  }
}

/** Bulle « ! » au-dessus de la tête : la session attend une réponse de l'utilisateur. */
function drawAlertBubble(ctx, colors, headX, headY, frame) {
  if (frame % 8 >= 6) return;
  const x = headX + 7;
  const y = headY - 9;
  pixel(ctx, colors.k, x, y, 5, 8);
  pixel(ctx, colors.w, x + 1, y + 1, 3, 6);
  pixel(ctx, colors.r, x + 2, y + 2, 1, 2);
  pixel(ctx, colors.r, x + 2, y + 5);
  pixel(ctx, colors.k, x + 1, y + 8);
}

/** Position du personnage selon son activité ; le reste de la scène est fixe. */
export function poseFor(view) {
  if (view.activity === "sleeping") return "sleep";
  if (view.activity === "working") return "sit";
  return "stand";
}

function drawOccupant(ctx, sprites, colors, view, frame) {
  const style = view.avatar.hairStyle;
  const anchors = sprites.anchors;
  const pose = poseFor(view);

  if (pose === "sleep") {
    const [hx, hy] = anchors.sleep.head;
    drawRows(ctx, sprites.heads.front[style] ?? sprites.heads.front[0], colors, hx, hy);
    drawFace(ctx, sprites, colors, view, frame, hx, hy);
    drawLayers(ctx, sprites, sprites.sleep_blanket, colors);
    drawSleep(ctx, colors, hx, hy, frame);
    return;
  }

  if (pose === "sit") {
    const exhausted = view.mood === "exhausted";
    const typingPeriod = view.mood === "tired" ? 8 : 4;
    const typing = !exhausted && frame % typingPeriod >= typingPeriod / 2 ? 1 : 0;
    const [bx, by] = anchors.sit.body;
    const [hx, headBaseY] = anchors.sit.head;
    const hy = headBaseY + (exhausted ? 3 : 0);
    if (view.mood === "tired" || exhausted) drawRows(ctx, sprites.sprites.mug, colors, ...anchors.mug_desk);
    drawRows(ctx, sprites.bodies.sit[typing], colors, bx, by);
    drawRows(ctx, sprites.heads.back[style] ?? sprites.heads.back[0], colors, hx, hy);
    drawLayers(ctx, sprites, sprites.chair, colors);
    if (view.mood === "worried" || exhausted) drawSweat(ctx, colors, hx, hy, frame);
    return;
  }

  const bob = frame % 12 < 6 ? 0 : 1;
  const [bx, by] = anchors.stand.body;
  const [hx, headBaseY] = anchors.stand.head;
  const hy = headBaseY + bob;
  drawLayers(ctx, sprites, sprites.chair, colors);
  drawRows(ctx, sprites.bodies.stand, colors, bx, by);
  drawRows(ctx, sprites.heads.front[style] ?? sprites.heads.front[0], colors, hx, hy);
  drawFace(ctx, sprites, colors, view, frame, hx, hy);
  if (view.activity === "idle") drawRows(ctx, sprites.sprites.mug, colors, ...anchors.mug_hand);
  if (view.activity === "waiting") drawAlertBubble(ctx, colors, hx, hy, frame);
  if (view.mood === "worried" || view.mood === "exhausted") drawSweat(ctx, colors, hx, hy, frame);
}

/**
 * Dessine la chambre complète (64x40 pixels logiques) dans `ctx`, sans mise à l'échelle :
 * le canvas est agrandi en CSS (`image-rendering: pixelated`).
 * `view` : { activity, mood, tool, avatar: { skin, hair, hairStyle, hue } } ; `frame` avance à ~8 images/s.
 */
export function drawRoomScene(ctx, sprites, view, frame, hour) {
  const colors = colorsFor(sprites, view, hour);
  drawLayers(ctx, sprites, sprites.background, colors);
  drawWindow(ctx, sprites, colors, hour, frame);
  drawScreen(ctx, sprites, colors, view, frame);
  drawOccupant(ctx, sprites, colors, view, frame);
}
