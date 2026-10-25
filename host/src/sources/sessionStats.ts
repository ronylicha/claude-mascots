import { RECENT_TOOLS_LIMIT, type TokenTotals, type ToolKind, type ToolUse, type TranscriptStats } from "../types.ts";

const MINUTE_MS = 60_000;

/**
 * Classification des appels d'outil, commune aux journaux Claude Code (`Read`, `Bash`, `mcp__…`) et aux
 * rollouts Codex (`exec_command`, `apply_patch`, `spawn_agent`…). Une seule table : les deux fournisseurs
 * partagent les sept catégories visuelles.
 */
const TOOL_PATTERNS: ReadonlyArray<[RegExp, ToolKind]> = [
  [/^(Read|Glob|Grep|LS|NotebookRead|LSP|read_file|list_dir|grep_files|glob|view_image)$/, "read"],
  [/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/, "write"],
  [/^(Bash|BashOutput|KillShell|Monitor|exec_command|shell|shell_command|local_shell|unified_exec|write_stdin|exec|js)$/, "run"],
  [/^(WebSearch|WebFetch|web_search|web__run)$|search|fetch|browser|scrape/i, "search"],
  [/^(Agent|Task|Workflow|SendMessage|spawn_agent|send_message|wait_agent|close_agent|list_agents|followup_task)$/, "delegate"],
];

export function classifyTool(toolName: string): ToolKind {
  return TOOL_PATTERNS.find(([pattern]) => pattern.test(toolName))?.[1] ?? "other";
}

/** `mcp__plugin_playwright_playwright__browser_click` → `browser_click` : seul le dernier segment parle à l'humain. */
export function displayToolName(toolName: string): string {
  return toolName.startsWith("mcp__") ? (toolName.split("__").at(-1) ?? toolName) : toolName;
}

export function emptyToolCounts(): Record<ToolKind, number> {
  return { read: 0, write: 0, run: 0, search: 0, delegate: 0, think: 0, other: 0 };
}

function freshStats(): Omit<TranscriptStats, "perMinute"> {
  return {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    assistantTurns: 0,
    lastTool: null,
    lastToolKind: null,
    lastActivityAt: null,
    model: null,
    toolCounts: emptyToolCounts(),
    recentTools: [],
    usageReliable: true,
  };
}

/**
 * Comptabilité d'une session (tokens, outils, courbe par minute), indépendante du format du journal :
 * le suivi Claude Code et le suivi Codex y versent leurs événements, le collecteur lit le même instantané.
 */
export class SessionStatsLedger {
  private readonly minuteBuckets = new Map<number, number>();
  private readonly stats: Omit<TranscriptStats, "perMinute"> = freshStats();

  /** `at` : epoch en millisecondes, NaN si la ligne n'a pas de date exploitable. */
  recordActivity(at: number): void {
    if (Number.isNaN(at)) return;
    this.stats.lastActivityAt = Math.max(this.stats.lastActivityAt ?? 0, at);
  }

  recordTool(toolName: string, at: number): void {
    const kind = classifyTool(toolName);
    this.stats.lastTool = toolName;
    this.stats.lastToolKind = kind;
    this.stats.toolCounts[kind] += 1;
    // Ligne sans date exploitable : l'appel hérite de la dernière activité connue, l'ordre du journal reste juste.
    const tool: ToolUse = { name: displayToolName(toolName), kind, at: Number.isNaN(at) ? (this.stats.lastActivityAt ?? 0) : at };
    this.stats.recentTools.unshift(tool);
    this.stats.recentTools.length = Math.min(this.stats.recentTools.length, RECENT_TOOLS_LIMIT);
  }

  /** Une réflexion postérieure à l'outil : l'assistant a repris la main et réfléchit. */
  recordThinking(): void {
    this.stats.lastToolKind = "think";
    this.stats.toolCounts.think += 1;
  }

  setModel(model: string): void {
    this.stats.model = model;
  }

  /** Un appel au modèle facturé : `delta` est ce que cet appel a consommé, `at` sa date. */
  recordUsage(delta: TokenTotals, at: number): void {
    this.stats.assistantTurns += 1;
    // Un appel réel lit toujours au moins le prompt : zéro token d'entrée = `usage` non transmis par l'amont.
    if (delta.input + delta.cacheRead + delta.cacheWrite === 0) this.stats.usageReliable = false;
    const totals = this.stats.totals;
    totals.input += delta.input;
    totals.output += delta.output;
    totals.cacheRead += delta.cacheRead;
    totals.cacheWrite += delta.cacheWrite;

    if (!Number.isNaN(at)) {
      // Les lectures de cache sont exclues de la courbe : volumineuses mais ~10x moins chères.
      const minute = Math.floor(at / MINUTE_MS);
      this.minuteBuckets.set(minute, (this.minuteBuckets.get(minute) ?? 0) + delta.input + delta.cacheWrite + delta.output);
    }
  }

  get usageReliable(): boolean {
    return this.stats.usageReliable;
  }

  snapshot(now: number, historyMinutes: number): TranscriptStats {
    const currentMinute = Math.floor(now / MINUTE_MS);
    const perMinute = Array.from(
      { length: historyMinutes },
      (_, index) => this.minuteBuckets.get(currentMinute - historyMinutes + 1 + index) ?? 0,
    );
    this.pruneBuckets(currentMinute - historyMinutes);
    // Copies : l'appelant ne doit pas pouvoir modifier l'état interne du suivi.
    return {
      ...this.stats,
      totals: { ...this.stats.totals },
      toolCounts: { ...this.stats.toolCounts },
      recentTools: this.stats.recentTools.map((tool) => ({ ...tool })),
      perMinute,
    };
  }

  reset(): void {
    this.minuteBuckets.clear();
    Object.assign(this.stats, freshStats());
  }

  private pruneBuckets(oldestKeptMinute: number): void {
    for (const minute of this.minuteBuckets.keys()) {
      if (minute < oldestKeptMinute) this.minuteBuckets.delete(minute);
    }
  }
}
