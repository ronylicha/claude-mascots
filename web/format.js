// Formats d'affichage en français : nombres, montants, durées, temps relatif.

export const numberFormat = new Intl.NumberFormat("fr-FR");
export const compactFormat = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
export const moneyFormat = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD" });
/** Un tour coûte souvent moins d'un centime : trois décimales évitent d'afficher « 0,00 $ ». */
export const preciseMoneyFormat = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const shareFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
export const dateTimeFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "medium" });
export const timeFormat = new Intl.DateTimeFormat("fr-FR", { timeStyle: "medium" });
export const clockFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** En dessous, « à l'instant » est plus parlant qu'un compteur de secondes. */
const JUST_NOW_MS = 5 * SECOND;

export function levelFor(percent, warnAt, dangerAt) {
  if (percent >= dangerAt) return "danger";
  if (percent >= warnAt) return "warn";
  return "ok";
}

/** « 74 % » ou « ? » quand Claude Code n'a rien communiqué. */
export function formatPercent(value) {
  return value === null || value === undefined ? "?" : `${Math.round(value)} %`;
}

/** Part d'un total, avec une décimale (« 87,3 % »). */
export function formatShare(percent) {
  return `${shareFormat.format(percent)} %`;
}

const pad2 = (value) => String(value).padStart(2, "0");

/** Durée écoulée : « 45 s », « 12 min 05 s », « 3 h 12 min », « 2 j 4 h ». */
export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / SECOND));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${pad2(minutes)} min`;
  if (minutes > 0) return `${minutes} min ${pad2(seconds)} s`;
  return `${seconds} s`;
}

/** « il y a 12 s » ; un écart négatif (horloges décalées) compte comme « à l'instant ». */
export function formatRelative(elapsedMs) {
  if (elapsedMs < JUST_NOW_MS) return "à l'instant";
  if (elapsedMs < MINUTE) return `il y a ${Math.floor(elapsedMs / SECOND)} s`;
  if (elapsedMs < HOUR) return `il y a ${Math.floor(elapsedMs / MINUTE)} min`;
  if (elapsedMs < DAY) return `il y a ${Math.floor(elapsedMs / HOUR)} h ${pad2(Math.floor((elapsedMs % HOUR) / MINUTE))}`;
  return `il y a ${Math.floor(elapsedMs / DAY)} j`;
}

export function formatCountdown(resetsAt) {
  if (!resetsAt) return "Réinitialisation : inconnue";
  const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / MINUTE));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts = days > 0 ? [`${days} j`, `${hours} h`] : hours > 0 ? [`${hours} h`, pad2(rest)] : [`${rest} min`];
  return `Recharge complète dans ${parts.join(" ")}`;
}
