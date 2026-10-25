/** Outil qui fait vivre une session : Claude Code (registre + journal) ou Codex (rollout tenu ouvert). */
export type Provider = "claude" | "codex";

/** Ordre canonique des fournisseurs (quotas, trame série, interface). */
export const PROVIDERS: readonly Provider[] = ["claude", "codex"];

/** Entrée du registre `~/.claude/sessions/<pid>.json` tenu par Claude Code. */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: "busy" | "idle" | string;
  version: string;
  startedAt: number;
  statusUpdatedAt: number;
  /** Instant de démarrage du processus (champ 22 de /proc/<pid>/stat), null si absent. */
  procStart: string | null;
}

/**
 * Fenêtre de quota du compte : 5 heures glissantes ou 7 jours chez Anthropic ; chez OpenAI, les fenêtres
 * `primary`/`secondary` sont rangées ici d'après leur durée (≤ 12 h → « 5 h », au-delà → « 7 j »).
 */
export interface QuotaWindow {
  usedPercent: number;
  /** Epoch en millisecondes, null si inconnu. */
  resetsAt: number | null;
}

export interface AccountQuota {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  /** `statusline`/`cache` : barre d'état Claude Code ; `rollout` : événements `token_count` des journaux Codex. */
  source: "statusline" | "cache" | "rollout" | "none";
  observedAt: number | null;
}

/** Ce que Claude Code transmet à la barre d'état pour une session donnée. */
export interface StatuslineSnapshot {
  sessionId: string;
  transcriptPath: string | null;
  modelName: string | null;
  costUsd: number | null;
  contextUsedPercent: number | null;
  contextWindowSize: number | null;
  quota: Pick<AccountQuota, "fiveHour" | "sevenDay">;
  observedAt: number;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Catégorie visuelle de l'outil en cours : chaque catégorie a son accessoire. */
export type ToolKind = "read" | "write" | "run" | "search" | "delegate" | "think" | "other";

/** Ordre canonique des catégories (compteurs, protocole série, graphiques). */
export const TOOL_KINDS: readonly ToolKind[] = ["read", "write", "run", "search", "delegate", "think", "other"];

/** Un appel d'outil tel qu'écrit dans le journal de la session. */
export interface ToolUse {
  /** Nom affichable (préfixe MCP retiré : `mcp__serveur__outil` devient `outil`). */
  name: string;
  kind: ToolKind;
  /** Epoch en millisecondes. */
  at: number;
}

/** Nombre maximal d'appels récents conservés et publiés par session. */
export const RECENT_TOOLS_LIMIT = 8;

export interface TranscriptStats {
  totals: TokenTotals;
  /** Tokens (entrée non cachée + sortie) par minute, du plus ancien au plus récent. */
  perMinute: number[];
  assistantTurns: number;
  lastTool: string | null;
  lastToolKind: ToolKind | null;
  lastActivityAt: number | null;
  model: string | null;
  /** Appels d'outil depuis le début de la session, par catégorie (« think » compte les blocs de réflexion). */
  toolCounts: Record<ToolKind, number>;
  /** Derniers appels d'outil, du plus récent au plus ancien (au plus RECENT_TOOLS_LIMIT). */
  recentTools: ToolUse[];
  /**
   * Faux dès qu'un message a été facturé sans aucun token d'entrée (ni direct ni cache) : impossible pour
   * un vrai appel, c'est la signature d'un proxy qui ne transmet pas `usage` (vu sur ghostcli.cloud).
   * Les totaux, le coût et le contexte dérivés de ces chiffres ne sont alors pas des mesures.
   */
  usageReliable: boolean;
}

export type Activity = "working" | "waiting" | "idle" | "sleeping";

export type Mood = "happy" | "focused" | "tired" | "worried" | "exhausted";

/** Ce qui a déclenché une humeur négative : quota 5 h, quota 7 j ou contexte de la session. */
export type MoodCause = "quota5h" | "quota7d" | "context";

/** Apparence de l'humain qui incarne la session (indices dans shared/sprites.json). */
export interface Avatar {
  skin: number;
  hair: number;
  hairStyle: number;
  /** Teinte (0-359) du t-shirt et de la couverture. */
  hue: number;
}

/** Vue consolidée d'une session, prête à dessiner. */
export interface SessionView {
  provider: Provider;
  sessionId: string;
  pid: number;
  name: string;
  /** Nom du dossier de travail. */
  project: string;
  /** Chemin complet du dossier de travail. */
  cwd: string;
  version: string;
  model: string | null;
  /** Statut brut : registre de Claude Code (`busy`, `idle`, `waiting-for-permission`…) ou dérivé des tours Codex. */
  status: string;
  activity: Activity;
  mood: Mood;
  /** Cause de l'humeur négative ; null pour « content » et « concentré ». */
  moodCause: MoodCause | null;
  tool: ToolKind | null;
  toolName: string | null;
  costUsd: number | null;
  contextPercent: number | null;
  /** Taille de la fenêtre de contexte en tokens, null si inconnue. */
  contextWindowSize: number | null;
  tokens: TokenTotals;
  /** Faux quand les compteurs viennent d'un amont qui ne les renseigne pas : `tokens` est alors à prendre pour ce qu'il est. */
  usageReliable: boolean;
  tokensPerMinute: number;
  history: number[];
  /** Réponses de l'assistant depuis le début de la session. */
  turns: number;
  toolCounts: Record<ToolKind, number>;
  recentTools: ToolUse[];
  avatar: Avatar;
  startedAt: number;
  lastActivityAt: number | null;
}

/** Seuils (en %) qui font basculer l'humeur ; publiés pour que l'interface explique les humeurs sans les recopier. */
export interface MoodThresholds {
  fiveHourExhausted: number;
  fiveHourWorried: number;
  sevenDayWorried: number;
  contextExhausted: number;
  contextTired: number;
}

export interface DashboardState {
  generatedAt: number;
  /** Un quota par compte : celui d'Anthropic ne dit rien de celui d'OpenAI, et réciproquement. */
  quotas: Record<Provider, AccountQuota>;
  sessions: SessionView[];
  totals: { costUsd: number; tokensPerMinute: number; sessions: number; working: number };
  device: { connected: boolean; path: string | null };
  moodThresholds: MoodThresholds;
}
