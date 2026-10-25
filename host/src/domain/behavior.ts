import type { AccountQuota, Activity, Mood, MoodCause, MoodThresholds } from "../types.ts";

export interface ActivityInput {
  registryStatus: string;
  statusUpdatedAt: number;
  lastActivityAt: number | null;
  now: number;
  sleepAfterMs: number;
}

/** Que fait le personnage ? Dérivé du statut que Claude Code publie dans son registre. */
export function deriveActivity(input: ActivityInput): Activity {
  const status = input.registryStatus.toLowerCase();
  if (/wait|permission|input|approval/.test(status)) return "waiting";
  if (status === "busy") return "working";
  const lastSeen = Math.max(input.statusUpdatedAt, input.lastActivityAt ?? 0);
  return input.now - lastSeen > input.sleepAfterMs ? "sleeping" : "idle";
}

export interface MoodInput {
  activity: Activity;
  contextPercent: number | null;
  quota: AccountQuota;
}

/** Source unique des seuils : publiée telle quelle dans DashboardState pour l'interface web. */
export const MOOD_THRESHOLDS: Readonly<MoodThresholds> = Object.freeze({
  /** Fenêtre de 5 h presque vide : Claude Code va bientôt refuser de répondre. */
  fiveHourExhausted: 95,
  fiveHourWorried: 80,
  sevenDayWorried: 85,
  /** Au-delà, l'auto-compaction approche et la qualité des réponses baisse. */
  contextExhausted: 90,
  contextTired: 70,
});

export interface MoodState {
  mood: Mood;
  /** Ce qui a déclenché l'humeur ; null pour « content » et « concentré ». */
  cause: MoodCause | null;
}

/**
 * Comment se sent le personnage, et pourquoi ? Le quota est partagé par toutes les sessions du compte :
 * quand il s'épuise, toute la troupe s'inquiète ; le contexte, lui, ne fatigue que sa session.
 * Humeur et cause sortent du même arbre de décision : les seuils ne sont écrits qu'une fois.
 * Si deux causes jouent au même niveau, le quota (partagé, plus urgent) l'emporte sur le contexte.
 */
export function deriveMoodState({ activity, contextPercent, quota }: MoodInput): MoodState {
  const fiveHour = quota.fiveHour?.usedPercent ?? 0;
  const sevenDay = quota.sevenDay?.usedPercent ?? 0;
  const context = contextPercent ?? 0;

  if (fiveHour >= MOOD_THRESHOLDS.fiveHourExhausted) return { mood: "exhausted", cause: "quota5h" };
  if (context >= MOOD_THRESHOLDS.contextExhausted) return { mood: "exhausted", cause: "context" };
  if (fiveHour >= MOOD_THRESHOLDS.fiveHourWorried) return { mood: "worried", cause: "quota5h" };
  if (sevenDay >= MOOD_THRESHOLDS.sevenDayWorried) return { mood: "worried", cause: "quota7d" };
  if (context >= MOOD_THRESHOLDS.contextTired) return { mood: "tired", cause: "context" };
  return { mood: activity === "working" ? "focused" : "happy", cause: null };
}

export function deriveMood(input: MoodInput): Mood {
  return deriveMoodState(input).mood;
}
