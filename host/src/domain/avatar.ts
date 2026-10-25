import type { Avatar } from "../types.ts";

/**
 * Chaque session est incarnée par un humain dont l'apparence dérive de son identifiant.
 * Ces nombres doivent correspondre aux listes de shared/sprites.json (vérifié par host/test/sprites.test.ts).
 */
export const SKIN_TONE_COUNT = 4;
export const HAIR_COLOR_COUNT = 6;
export const HAIR_STYLE_COUNT = 3;

/** FNV-1a 32 bits : stable entre redémarrages, donc une session garde toujours la même apparence. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function avatarFor(sessionId: string): Avatar {
  const hash = hashString(sessionId);
  // Tranches de bits distinctes : peau, cheveux, coiffure et teinte varient indépendamment.
  return {
    skin: (hash & 0xf) % SKIN_TONE_COUNT,
    hair: ((hash >>> 4) & 0xff) % HAIR_COLOR_COUNT,
    hairStyle: ((hash >>> 12) & 0xf) % HAIR_STYLE_COUNT,
    hue: (hash >>> 16) % 360,
  };
}
