import {
  TOOL_KINDS,
  type Activity,
  type DashboardState,
  type Mood,
  type MoodCause,
  type Provider,
  type QuotaWindow,
  type SessionView,
  type ToolKind,
} from "../types.ts";

/**
 * Protocole série v2 : une ligne JSON par trame, terminée par "\n", ASCII uniquement.
 * Clés courtes et codes d'un caractère pour tenir dans le tampon de la carte
 * (< 4 000 octets pour 6 sessions). Spécification complète : docs/serial-protocol.md.
 */
export const PROTOCOL_VERSION = 2;
const NAME_LENGTH = 12;
const LABEL_LENGTH = 16;
const ID_LENGTH = 8;
export const HISTORY_POINTS = 15;
const HISTORY_MINUTES = HISTORY_POINTS * 2;

export const ACTIVITY_CODE: Record<Activity, string> = { working: "w", waiting: "a", idle: "i", sleeping: "s" };
export const MOOD_CODE: Record<Mood, string> = { happy: "h", focused: "f", tired: "t", worried: "w", exhausted: "x" };
export const MOOD_CAUSE_CODE: Record<MoodCause, string> = { quota5h: "q", quota7d: "w", context: "x" };
export const TOOL_CODE: Record<ToolKind, string> = { read: "r", write: "e", run: "b", search: "s", delegate: "d", think: "t", other: "o" };
export const PROVIDER_CODE: Record<Provider, string> = { claude: "c", codex: "x" };

export interface DeviceSession {
  id: string;
  /** Fournisseur : `c` Claude Code, `x` Codex. */
  pv: string;
  n: string;
  h: number;
  sk: number;
  hc: number;
  hs: number;
  a: string;
  m: string;
  mc: string;
  k: string;
  tn: string;
  x: number;
  cw: number;
  r: number;
  c: number;
  md: string;
  p: string;
  u: number;
  up: number;
  ld: number;
  ti: number;
  to: number;
  tr: number;
  tw: number;
  tc: number[];
  hh: number[];
}

export interface DeviceFrame {
  v: number;
  t: number;
  /** Heure et minute locales du PC. */
  lt: [number, number];
  /** Quota du compte Anthropic : [5h %, minutes avant reset 5h, 7j %, minutes avant reset 7j] ; -1 = inconnu. */
  q: [number, number, number, number];
  /** Quota du compte OpenAI (sessions Codex), même forme que `q`. */
  q2: [number, number, number, number];
  tot: { c: number; r: number; n: number; w: number };
  s: DeviceSession[];
}

/**
 * Les petites polices bitmap n'ont que l'ASCII : on retire accents et emojis.
 * Guillemets et antislash sont retirés aussi : JSON les double (`\"`), ce qui ferait dépasser
 * la trame pire cas des 4 000 octets (4 073 mesurés avec des libellés pleins de guillemets).
 */
export function toAsciiLabel(value: string, maxLength = NAME_LENGTH): string {
  return value.normalize("NFD").replace(/[^\x20-\x7e]|["\\]/g, "").slice(0, maxLength);
}

function quotaFields(window: QuotaWindow | null, now: number): [number, number] {
  if (!window) return [-1, -1];
  const minutes = window.resetsAt === null ? -1 : Math.max(0, Math.round((window.resetsAt - now) / 60_000));
  return [Math.round(window.usedPercent), minutes];
}

function accountQuotaFields(quota: DashboardState["quotas"][Provider], now: number): [number, number, number, number] {
  return [...quotaFields(quota.fiveHour, now), ...quotaFields(quota.sevenDay, now)];
}

/** 30 minutes réduites à 15 points (moyenne par paire) : assez pour une courbe sur 320 pixels. */
export function compactHistory(history: number[]): number[] {
  const recent = history.slice(-HISTORY_MINUTES);
  const padded = [...Array.from({ length: HISTORY_MINUTES - recent.length }, () => 0), ...recent];
  return Array.from({ length: HISTORY_POINTS }, (_, index) => Math.round(((padded[index * 2] ?? 0) + (padded[index * 2 + 1] ?? 0)) / 2));
}

function toDeviceSession(session: SessionView, now: number): DeviceSession {
  return {
    // Fin de l'identifiant, pas le début : le préfixe d'un UUIDv7 (Codex) est un horodatage partagé par deux
    // sessions lancées à moins de 65 s d'écart. Même filtre ASCII que les autres textes.
    id: toAsciiLabel(session.sessionId.slice(-ID_LENGTH), ID_LENGTH),
    pv: PROVIDER_CODE[session.provider],
    n: toAsciiLabel(session.name),
    h: session.avatar.hue,
    sk: session.avatar.skin,
    hc: session.avatar.hair,
    hs: session.avatar.hairStyle,
    a: ACTIVITY_CODE[session.activity],
    m: MOOD_CODE[session.mood],
    mc: session.moodCause ? MOOD_CAUSE_CODE[session.moodCause] : "-",
    k: session.tool ? TOOL_CODE[session.tool] : "-",
    tn: toAsciiLabel(session.toolName ?? "", LABEL_LENGTH),
    x: session.contextPercent === null ? -1 : Math.round(session.contextPercent),
    cw: session.contextWindowSize === null ? -1 : Math.round(session.contextWindowSize / 1000),
    r: session.tokensPerMinute,
    c: session.costUsd === null ? -1 : Math.round(session.costUsd * 100),
    md: toAsciiLabel(session.model ?? "", LABEL_LENGTH),
    p: toAsciiLabel(session.project, LABEL_LENGTH),
    u: session.turns,
    up: Math.max(0, Math.floor((now - session.startedAt) / 60_000)),
    ld: session.lastActivityAt === null ? -1 : Math.max(0, Math.floor((now - session.lastActivityAt) / 1000)),
    ti: session.tokens.input,
    to: session.tokens.output,
    tr: session.tokens.cacheRead,
    tw: session.tokens.cacheWrite,
    tc: TOOL_KINDS.map((kind) => session.toolCounts[kind]),
    hh: compactHistory(session.history),
  };
}

export function buildDeviceFrame(state: DashboardState, maxSessions: number): DeviceFrame {
  const now = state.generatedAt;
  const local = new Date(now);
  // Priorité aux personnages qui travaillent quand l'écran ne peut pas tous les montrer.
  const visible = state.sessions
    .toSorted((a, b) => Number(b.activity === "working") - Number(a.activity === "working"))
    .slice(0, maxSessions);

  return {
    v: PROTOCOL_VERSION,
    t: Math.floor(now / 1000),
    lt: [local.getHours(), local.getMinutes()],
    q: accountQuotaFields(state.quotas.claude, now),
    q2: accountQuotaFields(state.quotas.codex, now),
    tot: {
      c: Math.round(state.totals.costUsd * 100),
      r: state.totals.tokensPerMinute,
      n: state.totals.sessions,
      w: state.totals.working,
    },
    s: visible.map((session) => toDeviceSession(session, now)),
  };
}

export function encodeDeviceFrame(frame: DeviceFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
