import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TokenTotals, TranscriptStats } from "../types.ts";
import { JsonlTail } from "./jsonlTail.ts";
import { SessionStatsLedger } from "./sessionStats.ts";

export { classifyTool, displayToolName, emptyToolCounts } from "./sessionStats.ts";

interface UsageLine {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ContentBlock {
  type?: string;
  name?: string;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: UsageLine;
    content?: ContentBlock[];
  };
}

/** Suit un journal `~/.claude/projects/<slug>/<sessionId>.jsonl` de Claude Code en lecture incrémentale. */
export class TranscriptTracker extends JsonlTail {
  private readonly countedMessageIds = new Set<string>();
  private readonly ledger = new SessionStatsLedger();

  snapshot(now: number, historyMinutes: number): TranscriptStats {
    return this.ledger.snapshot(now, historyMinutes);
  }

  protected ingestEntry(raw: Record<string, unknown>): void {
    const entry = raw as TranscriptLine;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (entry.type === "assistant" || entry.type === "user") this.ledger.recordActivity(at);
    if (entry.type !== "assistant" || !entry.message) return;

    this.trackTool(entry.message.content, at);
    if (entry.message.model && !entry.message.model.startsWith("<")) this.ledger.setModel(entry.message.model);
    this.countUsage(entry.message.id, entry.message.usage, at);
  }

  protected onReset(): void {
    this.countedMessageIds.clear();
    this.ledger.reset();
  }

  /**
   * Contrairement aux tokens, les blocs ne sont pas dédoublonnés par message : un message réparti sur
   * plusieurs lignes porte un bloc différent par ligne, et chacun compte.
   */
  private trackTool(content: ContentBlock[] | undefined, at: number): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      // Un `null` dans le tableau est du JSON valide : on l'ignore plutôt que de lever.
      if (typeof block !== "object" || block === null) continue;
      if (block.type === "tool_use" && typeof block.name === "string") this.ledger.recordTool(block.name, at);
      else if (block.type === "thinking") this.ledger.recordThinking();
    }
  }

  /** Chaque bloc de contenu est une ligne qui recopie le même `usage` : on ne compte qu'une fois par message. */
  private countUsage(messageId: string | undefined, usage: UsageLine | undefined, at: number): void {
    if (!usage || !messageId || this.countedMessageIds.has(messageId)) return;
    this.countedMessageIds.add(messageId);
    const delta: TokenTotals = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    };
    this.ledger.recordUsage(delta, at);
  }
}

/** Retrouve le journal d'une session quand la barre d'état ne l'a pas encore signalé. */
export async function findTranscriptPath(projectsDir: string, sessionId: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  const fileName = `${sessionId}.jsonl`;
  const matches = await Promise.all(
    projectDirs.map(async (dir) => {
      const candidate = join(projectsDir, dir, fileName);
      try {
        await stat(candidate);
        return candidate;
      } catch {
        return null;
      }
    }),
  );
  return matches.find((match) => match !== null) ?? null;
}
