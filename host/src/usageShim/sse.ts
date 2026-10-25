/**
 * Découpage incrémental d'un flux Server-Sent Events (format utilisé par l'API Anthropic en streaming).
 * Un bloc = les lignes jusqu'à une ligne vide. Le texte brut est conservé pour réémettre tel quel
 * ce qui n'est pas modifié : les octets d'origine passent, pas une re-sérialisation.
 */
export interface SseBlock {
  /** Texte d'origine du bloc, séparateur de fin compris. */
  raw: string;
  event: string | null;
  /** Lignes `data:` jointes par "\n" ; null si le bloc n'en a pas (commentaire, ping brut…). */
  data: string | null;
}

const BLOCK_SEPARATOR = /\r?\n\r?\n/;

export function parseSseBlock(raw: string): SseBlock {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
  }
  return { raw, event, data: data.length > 0 ? data.join("\n") : null };
}

export function serializeSseBlock(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Garde la fin de flux incomplète d'un morceau à l'autre ; `flush()` rend ce qui reste à la fermeture. */
export class SseSplitter {
  private pending = "";

  push(chunk: string): SseBlock[] {
    this.pending += chunk;
    const blocks: SseBlock[] = [];
    let match: RegExpExecArray | null;
    while ((match = BLOCK_SEPARATOR.exec(this.pending)) !== null) {
      const end = match.index + match[0].length;
      blocks.push(parseSseBlock(this.pending.slice(0, end)));
      this.pending = this.pending.slice(end);
    }
    return blocks;
  }

  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}
