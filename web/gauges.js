// Jauges de quota du compte : la même mise en page sert en haut de la grille et dans la vue détaillée.
import { setAttribute, setText } from "./dom.js";
import { formatCountdown, levelFor } from "./format.js";

const QUOTA_WARN_AT = 70;
const QUOTA_DANGER_AT = 90;

const QUOTA_SOURCES = {
  statusline: "barre d'état de Claude Code",
  cache: "cache de la barre d'état",
  rollout: "journaux de session Codex",
  none: "aucune source récente",
};

/** Remplit un élément `.gauge` (valeur, remplissage, compte à rebours) à partir d'une fenêtre de quota. */
export function renderGauge(gauge, quotaWindow) {
  const fill = gauge.querySelector(".gauge-fill");
  const track = gauge.querySelector(".gauge-track");
  if (!quotaWindow) {
    setText(gauge.querySelector(".gauge-value"), "–");
    setText(gauge.querySelector(".gauge-reset"), "Pas encore de mesure");
    fill.style.width = "0";
    delete fill.dataset.level;
    track.removeAttribute("aria-valuenow");
    setAttribute(track, "aria-valuetext", "Pas encore de mesure");
    return;
  }
  const used = Math.round(quotaWindow.usedPercent);
  setText(gauge.querySelector(".gauge-value"), `${used} % utilisé`);
  setText(gauge.querySelector(".gauge-reset"), formatCountdown(quotaWindow.resetsAt));
  fill.style.width = `${Math.min(100, Math.max(0, used))}%`;
  fill.dataset.level = levelFor(used, QUOTA_WARN_AT, QUOTA_DANGER_AT);
  setAttribute(track, "aria-valuenow", String(used));
  setAttribute(track, "aria-valuetext", `${used} % utilisé`);
}

/** « Source du quota : barre d'état de Claude Code · mesuré à 22:41:09 ». */
export function describeQuotaSource(quota) {
  const when = quota.observedAt ? ` · mesuré à ${new Date(quota.observedAt).toLocaleTimeString("fr-FR")}` : "";
  return `Source du quota : ${QUOTA_SOURCES[quota.source] ?? quota.source}${when}`;
}
