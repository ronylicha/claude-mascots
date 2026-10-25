// Libellés français des activités, humeurs et outils, et explication en clair de l'humeur.
import { formatPercent } from "./format.js";

/** Ordre canonique des catégories d'outils (identique à TOOL_KINDS dans host/src/types.ts). */
export const TOOL_KINDS = ["read", "write", "run", "search", "delegate", "think", "other"];

/** Ce que fait le personnage pendant qu'il travaille, selon la catégorie de l'outil en cours. */
const TOOL_ACTIVITY = {
  read: "Lit des fichiers",
  write: "Écrit du code",
  run: "Lance une commande",
  search: "Cherche sur le web",
  delegate: "Délègue à un agent",
  think: "Réfléchit",
  other: "Utilise un outil",
};

/** Nom de la catégorie, pour l'histogramme et la liste des outils récents. */
export const TOOL_NOUNS = {
  read: "Lecture",
  write: "Écriture",
  run: "Commandes",
  search: "Recherche web",
  delegate: "Délégation",
  think: "Réflexion",
  other: "Autres outils",
};

const REST_ACTIVITY = { waiting: "Attend votre réponse", idle: "Au repos", sleeping: "Dort" };

export const ACTIVITY_NOUNS = { working: "Au travail", waiting: "En attente", idle: "Au repos", sleeping: "En sommeil" };

/** Teinte du badge d'activité (voir .badge[data-tone] dans style.css). */
const ACTIVITY_TONES = { working: "accent", waiting: "alert", idle: "muted", sleeping: "muted" };

export const MOOD_LABELS = {
  happy: "Bonne humeur",
  focused: "Concentration",
  tired: "Fatigue",
  worried: "Inquiétude",
  exhausted: "Épuisement",
};

const MOOD_TONES = { happy: "ok", focused: "ok", tired: "warn", worried: "warn", exhausted: "danger" };

/** Outil qui pilote la session (champ `provider` publié par le démon). */
export const PROVIDER_LABELS = { claude: "Claude Code", codex: "Codex" };

export const providerLabel = (provider) => PROVIDER_LABELS[provider] ?? String(provider ?? "Inconnu");

export const activityTone = (activity) => ACTIVITY_TONES[activity] ?? "muted";
export const moodTone = (mood) => MOOD_TONES[mood] ?? "ok";
export const moodLabel = (mood) => MOOD_LABELS[mood] ?? mood;

/** « Lit des fichiers (Read) », « Au repos »… */
export function activityLabel(view) {
  if (view.activity !== "working") return REST_ACTIVITY[view.activity] ?? view.activity;
  const base = TOOL_ACTIVITY[view.tool] ?? "Travaille";
  return view.toolName ? `${base} (${view.toolName})` : base;
}

/**
 * La cause de l'humeur en clair, avec la valeur mesurée et le seuil franchi.
 * Cause et seuils viennent du démon (moodCause, moodThresholds) : l'interface ne recalcule rien.
 * `quota` est celui du fournisseur de la session (state.quotas[view.provider]).
 */
export function explainMood(view, quota, thresholds) {
  if (view.mood === "happy") return "Tout va bien : le contexte et les quotas sont sous leurs seuils.";
  if (view.mood === "focused") return "Au travail, sans tension : le contexte et les quotas sont sous leurs seuils.";

  const exhausted = view.mood === "exhausted";
  const tool = providerLabel(view.provider);
  switch (view.moodCause) {
    case "context": {
      const threshold = exhausted ? thresholds.contextExhausted : thresholds.contextTired;
      const consequence = exhausted ? "L'auto-compaction approche." : "La qualité des réponses peut baisser.";
      return `Contexte à ${formatPercent(view.contextPercent)} (seuil : ${threshold} %). ${consequence}`;
    }
    case "quota5h": {
      const threshold = exhausted ? thresholds.fiveHourExhausted : thresholds.fiveHourWorried;
      const consequence = exhausted
        ? `${tool} va bientôt refuser de répondre.`
        : `Le quota est partagé par toutes les sessions ${tool} du compte.`;
      return `Quota 5 h à ${formatPercent(quota.fiveHour?.usedPercent)} (seuil : ${threshold} %). ${consequence}`;
    }
    case "quota7d":
      return `Quota de la semaine à ${formatPercent(quota.sevenDay?.usedPercent)} (seuil : ${thresholds.sevenDayWorried} %). Il est partagé par toutes les sessions ${tool} du compte.`;
    default:
      return "La cause de cette humeur n'a pas été communiquée.";
  }
}
