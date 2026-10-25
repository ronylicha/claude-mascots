import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const CHUNK_BYTES = 1 << 20;

/**
 * Lecture incrémentale d'un journal `.jsonl` qui ne fait que grandir (journal Claude Code, rollout Codex).
 * Seuls les octets nouveaux sont lus à chaque passage ; la ligne partielle attend le passage suivant.
 * Un fichier remplacé (nouvel inode) ou tronqué est relu depuis le début après `onReset()`.
 */
export abstract class JsonlTail {
  private offset = 0;
  private inode: number | null = null;
  private pendingLine = "";
  // Garde les octets d'un caractère UTF-8 coupé entre deux morceaux (accents, emojis).
  private decoder = new StringDecoder("utf8");

  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async refresh(): Promise<void> {
    const { size, ino } = await stat(this.path);
    if (size < this.offset || (this.inode !== null && ino !== this.inode)) this.reset();
    this.inode = ino;
    if (size === this.offset) return;

    const handle = await open(this.path, "r");
    try {
      const buffer = Buffer.alloc(CHUNK_BYTES);
      while (this.offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.ingestText(this.decoder.write(buffer.subarray(0, bytesRead)));
      }
    } finally {
      await handle.close();
    }
  }

  /** Point d'entrée pur, utilisé aussi par les tests : du texte brut, lignes complètes ou non. */
  ingestText(text: string): void {
    const lines = (this.pendingLine + text).split("\n");
    this.pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) this.ingestLine(line);
    }
  }

  /** Une ligne JSON valide qui est un objet ; les lignes corrompues ou d'un autre type sont ignorées. */
  protected abstract ingestEntry(entry: Record<string, unknown>): void;

  /** L'état dérivé du journal doit repartir de zéro : le fichier a été remplacé ou tronqué. */
  protected abstract onReset(): void;

  private ingestLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    // `null`, nombre ou tableau : JSON valide mais pas une entrée de journal.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    this.ingestEntry(parsed as Record<string, unknown>);
  }

  private reset(): void {
    this.offset = 0;
    this.pendingLine = "";
    this.decoder = new StringDecoder("utf8");
    this.onReset();
  }
}
