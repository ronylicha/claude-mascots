import type { QuotaWindow, TokenTotals, TranscriptStats } from "../types.ts";
import { JsonlTail } from "./jsonlTail.ts";
import { SessionStatsLedger } from "./sessionStats.ts";

export type CodexStatus = "busy" | "idle" | "waiting-for-approval";

export interface CodexRolloutMeta {
  sessionId: string | null;
  cwd: string | null;
  /** Epoch en millisecondes (`session_meta.timestamp`), null tant que l'en-tête n'est pas lu. */
  startedAt: number | null;
  version: string | null;
  /** `codex_cli_rs`, `codex_exec`, `Codex Desktop`… */
  originator: string | null;
  /** Fil lancé par un autre agent Codex (`source.subagent`) : son journal est tenu par le même processus que le parent. */
  isSubagent: boolean;
}

/** Quota du compte OpenAI tel que Codex le reçoit à chaque appel (`token_count.rate_limits`). */
export interface CodexQuota {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  observedAt: number;
}

export interface CodexRolloutSnapshot {
  meta: CodexRolloutMeta;
  stats: TranscriptStats;
  status: CodexStatus;
  statusUpdatedAt: number;
  /** Tokens du dernier appel (hors réflexion) rapportés à la fenêtre annoncée par le modèle, en %. */
  contextPercent: number | null;
  /** Instant où le démon a commencé à suivre ce rollout (repli pour `startedAt` si l'en-tête n'est pas daté). */
  discoveredAt: number;
  contextWindowSize: number | null;
  model: string | null;
  quota: CodexQuota | null;
}

/** Une fenêtre de rate limit OpenAI plus courte que 12 h joue le rôle du « 5 h », plus longue celui du « 7 j ». */
const SHORT_WINDOW_MAX_MINUTES = 12 * 60;
/** Dans les cellules JavaScript de Codex Desktop (`exec`, `js`), les vrais outils sont appelés `tools.<nom>(…)`. */
const INNER_TOOL_CALL = /\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const JS_CELL_TOOLS = new Set(["exec", "js"]);

interface TokenUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function parseRateLimitWindow(raw: unknown): { minutes: number; window: QuotaWindow } | null {
  if (!isRecord(raw)) return null;
  const usedPercent = asNumber(raw.used_percent);
  const minutes = asNumber(raw.window_minutes);
  if (usedPercent === null || minutes === null) return null;
  const resetsAt = asNumber(raw.resets_at);
  return { minutes, window: { usedPercent: Math.min(100, Math.max(0, usedPercent)), resetsAt: resetsAt === null ? null : resetsAt * 1000 } };
}

/**
 * `rate_limits` de Codex : `primary`/`secondary` sans sémantique fixe (un abonnement Pro n'a qu'une fenêtre
 * de 10 080 min ; un Plus a 300 min + 10 080 min). On range chaque fenêtre par sa durée, jamais par sa position.
 */
export function parseCodexRateLimits(raw: unknown, observedAt: number): CodexQuota | null {
  if (!isRecord(raw)) return null;
  const windows = [raw.primary, raw.secondary].map(parseRateLimitWindow).filter((window) => window !== null);
  if (windows.length === 0) return null;
  const short = windows.filter((entry) => entry.minutes <= SHORT_WINDOW_MAX_MINUTES).toSorted((a, b) => a.minutes - b.minutes)[0];
  const long = windows.filter((entry) => entry.minutes > SHORT_WINDOW_MAX_MINUTES).toSorted((a, b) => b.minutes - a.minutes)[0];
  return { fiveHour: short?.window ?? null, sevenDay: long?.window ?? null, observedAt };
}

function parseTokenUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null;
  const total = asNumber(raw.total_tokens);
  const input = asNumber(raw.input_tokens);
  if (total === null || input === null) return null;
  return {
    input,
    cached: asNumber(raw.cached_input_tokens) ?? 0,
    cacheWrite: asNumber(raw.cache_write_input_tokens) ?? 0,
    output: asNumber(raw.output_tokens) ?? 0,
    reasoning: asNumber(raw.reasoning_output_tokens) ?? 0,
    total,
  };
}

/** Noms des outils réellement appelés dans une cellule JavaScript ; vide si la cellule ne fait que calculer. */
export function innerToolNames(cellSource: string): string[] {
  return [...cellSource.matchAll(INNER_TOOL_CALL)].map((match) => match[1] ?? "").filter((name) => name.length > 0);
}

/**
 * Suit un rollout `~/.codex/sessions/AAAA/MM/JJ/rollout-*.jsonl` en lecture incrémentale.
 * Format mesuré le 2026-10-25 (Codex CLI 0.157/0.164 et Codex Desktop 0.162/0.163) : une ligne
 * `{timestamp, type, payload}` par événement ; `session_meta` (identité), `turn_context` (modèle),
 * `event_msg` (`task_started`/`task_complete`, `token_count` avec totaux cumulés, fenêtre et rate limits),
 * `response_item` (appels d'outils, réflexions, messages).
 */
export class CodexRolloutTracker extends JsonlTail {
  private readonly ledger = new SessionStatsLedger();
  private readonly openTurns = new Set<string>();
  private meta: CodexRolloutMeta = emptyMeta();
  private status: CodexStatus = "idle";
  private statusUpdatedAt = 0;
  private model: string | null = null;
  private contextPercent: number | null = null;
  private contextWindowSize: number | null = null;
  private quota: CodexQuota | null = null;
  private lastTotals: TokenUsage | null = null;
  readonly discoveredAt: number;

  constructor(path: string, discoveredAt: number = Date.now()) {
    super(path);
    this.discoveredAt = discoveredAt;
  }

  snapshot(now: number, historyMinutes: number): CodexRolloutSnapshot {
    return {
      meta: { ...this.meta },
      stats: this.ledger.snapshot(now, historyMinutes),
      status: this.status,
      statusUpdatedAt: this.statusUpdatedAt,
      contextPercent: this.contextPercent,
      contextWindowSize: this.contextWindowSize,
      discoveredAt: this.discoveredAt,
      model: this.model,
      quota: this.quota ? { ...this.quota } : null,
    };
  }

  protected ingestEntry(entry: Record<string, unknown>): void {
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    const payload = isRecord(entry.payload) ? entry.payload : {};
    switch (entry.type) {
      case "session_meta":
        this.readSessionMeta(payload, at);
        break;
      case "turn_context":
        this.model = asString(payload.model) ?? this.model;
        this.meta.cwd = asString(payload.cwd) ?? this.meta.cwd;
        break;
      case "event_msg":
        this.readEvent(payload, at);
        break;
      case "response_item":
        this.readResponseItem(payload, at);
        break;
      default:
        break;
    }
  }

  protected onReset(): void {
    this.ledger.reset();
    this.openTurns.clear();
    this.meta = emptyMeta();
    this.status = "idle";
    this.statusUpdatedAt = 0;
    this.model = null;
    this.contextPercent = null;
    this.contextWindowSize = null;
    this.quota = null;
    this.lastTotals = null;
  }

  /** Un rollout de sous-agent recopie aussi l'en-tête de son parent : seule la première entrée identifie le fichier. */
  private readSessionMeta(payload: Record<string, unknown>, at: number): void {
    if (this.meta.sessionId !== null) return;
    const startedAt = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : Number.NaN;
    this.meta = {
      sessionId: asString(payload.id),
      cwd: asString(payload.cwd),
      startedAt: Number.isNaN(startedAt) ? (Number.isNaN(at) ? null : at) : startedAt,
      version: asString(payload.cli_version),
      originator: asString(payload.originator),
      isSubagent: isRecord(payload.source) && "subagent" in payload.source,
    };
  }

  private readEvent(payload: Record<string, unknown>, at: number): void {
    const type = asString(payload.type) ?? "";
    const turnId = asString(payload.turn_id);
    const rootTurnId = asString(payload.root_turn_id);
    // Un tour sans `root_turn_id`, ou égal à lui-même, est un tour racine : les tours enfants ne lui survivent pas.
    const isRootTurn = turnId === null || rootTurnId === null || rootTurnId === turnId;
    switch (type) {
      case "task_started":
        // Un nouveau tour racine clôt tout ce qui restait ouvert (tour précédent jamais terminé : crash, journal tronqué).
        if (isRootTurn) this.openTurns.clear();
        this.openTurns.add(turnId ?? "?");
        this.contextWindowSize = asNumber(payload.model_context_window) ?? this.contextWindowSize;
        this.setStatus("busy", at);
        this.ledger.recordActivity(at);
        break;
      case "task_complete":
      case "turn_aborted":
        if (isRootTurn) this.openTurns.clear();
        else if (turnId !== null) this.openTurns.delete(turnId);
        if (this.openTurns.size === 0) this.setStatus("idle", at);
        this.ledger.recordActivity(at);
        break;
      case "token_count":
        this.readTokenCount(payload, at);
        break;
      case "thread_settings_applied":
        this.model = (isRecord(payload.thread_settings) ? asString(payload.thread_settings.model) : null) ?? this.model;
        break;
      case "user_message":
      case "agent_message":
        this.ledger.recordActivity(at);
        break;
      default:
        // `exec_approval_request`, `apply_patch_approval_request`… : Codex attend l'humain.
        if (/approval_request$|request_user_input/.test(type)) this.setStatus("waiting-for-approval", at);
        break;
    }
  }

  private readResponseItem(payload: Record<string, unknown>, at: number): void {
    this.ledger.recordActivity(at);
    // Le modèle produit de nouveau : une éventuelle attente d'approbation est levée.
    if (this.status === "waiting-for-approval") this.setStatus("busy", at);
    const type = asString(payload.type) ?? "";
    const name = asString(payload.name);
    switch (type) {
      case "function_call":
        if (name === null) break;
        this.ledger.recordTool(name, at);
        if (/request_user_input/.test(name)) this.setStatus("waiting-for-approval", at);
        break;
      case "custom_tool_call": {
        if (name === null) break;
        const inner = JS_CELL_TOOLS.has(name) && typeof payload.input === "string" ? innerToolNames(payload.input) : [];
        if (inner.length === 0) this.ledger.recordTool(name, at);
        for (const innerName of inner) this.ledger.recordTool(innerName, at);
        break;
      }
      case "local_shell_call":
        this.ledger.recordTool("local_shell", at);
        break;
      case "web_search_call":
        this.ledger.recordTool("web_search", at);
        break;
      case "reasoning":
        this.ledger.recordThinking();
        break;
      default:
        break;
    }
  }

  /**
   * `total_token_usage` est cumulé sur tout le fil : on ne compte que l'accroissement depuis l'événement précédent.
   * `last_token_usage` décrit le dernier appel, c'est lui qui mesure le contexte occupé.
   */
  private readTokenCount(payload: Record<string, unknown>, at: number): void {
    // Un quota qu'on ne peut pas dater ne doit pas passer pour frais : on garde le précédent.
    const quota = Number.isNaN(at) ? null : parseCodexRateLimits(payload.rate_limits, at);
    if (quota) this.quota = quota;
    if (!isRecord(payload.info)) return;
    const total = parseTokenUsage(payload.info.total_token_usage);
    const last = parseTokenUsage(payload.info.last_token_usage);
    const window = asNumber(payload.info.model_context_window);

    if (total) {
      const delta = this.consumeTotals(total);
      // En début de session, Codex émet un `token_count` dont `total_tokens` est renseigné mais dont toutes les
      // composantes valent 0 (242 cas sur 649 rollouts réels) : ce n'est pas un appel facturé, on ne compte rien.
      if (delta.input + delta.cached + delta.cacheWrite + delta.output > 0) {
        // `input_tokens` inclut les tokens servis par le cache : l'entrée non cachée est la différence.
        const tokens: TokenTotals = {
          input: Math.max(0, delta.input - delta.cached),
          output: delta.output,
          cacheRead: delta.cached,
          cacheWrite: delta.cacheWrite,
        };
        this.ledger.recordUsage(tokens, at);
      }
    }
    if (window !== null && window > 0) this.contextWindowSize = window;
    if (last && this.contextWindowSize) {
      // La réflexion d'un appel n'est pas renvoyée au suivant : elle n'occupe pas la fenêtre.
      const used = Math.max(0, last.total - last.reasoning);
      this.contextPercent = Math.min(100, Math.max(0, (used / this.contextWindowSize) * 100));
    }
  }

  private consumeTotals(total: TokenUsage): TokenUsage {
    const previous = this.lastTotals;
    this.lastTotals = total;
    // Pas de référence, ou un compteur qui recule (fil repris, journal réécrit) : tout le cumul est nouveau.
    if (!previous || total.total < previous.total || total.input < previous.input) return total;
    return {
      input: total.input - previous.input,
      cached: total.cached - previous.cached,
      cacheWrite: total.cacheWrite - previous.cacheWrite,
      output: total.output - previous.output,
      reasoning: total.reasoning - previous.reasoning,
      total: total.total - previous.total,
    };
  }

  private setStatus(status: CodexStatus, at: number): void {
    this.status = status;
    if (!Number.isNaN(at)) this.statusUpdatedAt = Math.max(this.statusUpdatedAt, at);
  }
}

function emptyMeta(): CodexRolloutMeta {
  return { sessionId: null, cwd: null, startedAt: null, version: null, originator: null, isSubagent: false };
}
