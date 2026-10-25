// Vue détaillée d'une session : remplit le markup statique de #view-detail (index.html).
// Les nœuds sont créés une fois ; chaque seconde, seuls les textes et largeurs qui changent sont réécrits.
import { TokenChart } from "./chart.js";
import { createElement, setAttribute, setPercentWidth, setText, syncChildren } from "./dom.js";
import {
  clockFormat,
  dateTimeFormat,
  formatDuration,
  formatPercent,
  formatRelative,
  formatShare,
  levelFor,
  moneyFormat,
  numberFormat,
  preciseMoneyFormat,
  timeFormat,
} from "./format.js";
import { describeQuotaSource, renderGauge } from "./gauges.js";
import {
  ACTIVITY_NOUNS,
  TOOL_KINDS,
  TOOL_NOUNS,
  activityLabel,
  activityTone,
  explainMood,
  moodLabel,
  moodTone,
  providerLabel,
} from "./labels.js";
import { RoomPainter, drawToolIcon } from "./scene.js";
import { skyPhase } from "./sprites.js";

const TOKEN_PARTS = [
  { key: "input", label: "Entrée" },
  { key: "output", label: "Sortie" },
  { key: "cacheRead", label: "Cache lu" },
  { key: "cacheWrite", label: "Cache écrit" },
];

const SKY_LABELS = { day: "le jour", dusk: "le crépuscule", night: "la nuit" };
const UNKNOWN = "Inconnu";

const USAGE_WARNING_CLAUDE =
  "Comptage non fiable : l'amont a renvoyé des messages sans aucun token d'entrée. Contexte et coût sont masqués ; lancer la session via le correcteur d'usage (tap/usage-shim.ts, commande cc2) pour des chiffres mesurés.";
const USAGE_WARNING_GENERIC = "Comptage non fiable : le journal de session contient des appels sans aucun token d'entrée. Contexte et coût sont masqués.";

/** Coût affiché : null = pas de prix par token (abonnement Codex) ou valeur absente. */
function describeCost(view) {
  if (view.costUsd !== null) return moneyFormat.format(view.costUsd);
  if (!view.usageReliable) return "Non mesuré";
  return view.provider === "codex" ? "Inclus" : "Non communiqué";
}

function collectFields(root) {
  const fields = {};
  for (const element of root.querySelectorAll("[data-field]")) fields[element.dataset.field] = element;
  return fields;
}

export class DetailView {
  constructor(root, sprites) {
    this.root = root;
    this.sprites = sprites;
    this.fields = collectFields(root);
    this.view = null;
    this.painter = new RoomPainter(this.fields.scene, sprites);
    this.chart = new TokenChart(this.fields.chart);
    this.tokenRows = this.buildTokenRows();
    this.toolRows = this.buildToolRows();
  }

  buildTokenRows() {
    return TOKEN_PARTS.map((part) => {
      const segment = createElement("span", `stack-seg seg-${part.key}`);
      this.fields.tokenBar.append(segment);
      const swatch = createElement("span", `swatch seg-${part.key}`);
      swatch.setAttribute("aria-hidden", "true");
      const value = createElement("span", "legend-value");
      const share = createElement("span", "legend-share");
      const row = createElement("li", "legend-row");
      row.append(swatch, createElement("span", "legend-label", part.label), value, share);
      this.fields.tokenLegend.append(row);
      return { part, segment, value, share };
    });
  }

  buildToolRows() {
    return TOOL_KINDS.map((kind) => {
      const icon = createElement("canvas", "tool-icon");
      icon.setAttribute("aria-hidden", "true");
      drawToolIcon(icon, this.sprites, kind);
      const fill = createElement("span", "tool-fill");
      const track = createElement("span", "tool-track");
      track.append(fill);
      const count = createElement("span", "tool-count");
      const row = createElement("li", "tool-row");
      row.append(icon, createElement("span", "tool-label", TOOL_NOUNS[kind]), track, count);
      this.fields.toolsList.append(row);
      return { kind, row, fill, count };
    });
  }

  /** `phase` : « content » (session affichée), « loading » (pas encore de données) ou « gone » (session terminée). */
  setPhase(phase) {
    this.fields.content.hidden = phase !== "content";
    this.fields.loading.hidden = phase !== "loading";
    this.fields.gone.hidden = phase !== "gone";
  }

  /** Élément à focaliser à l'arrivée dans une phase (titre de la page, ou rien pendant le chargement). */
  headingFor(phase) {
    if (phase === "content") return this.fields.title;
    if (phase === "gone") return this.fields.goneTitle;
    return null;
  }

  setGoneMessage(message) {
    setText(this.fields.goneMessage, message);
  }

  draw(frame, hour) {
    if (this.view) this.painter.paint(this.view, frame, hour);
  }

  /** `state` : le DashboardState courant (quotas par fournisseur et seuils d'humeur publiés par le démon). */
  update(view, state, now) {
    const { moodThresholds } = state;
    const quota = state.quotas[view.provider];
    this.view = view;
    this.renderHeader(view);
    this.renderState(view, quota, moodThresholds, now);
    this.renderTime(view, now);
    this.renderIdentity(view);
    this.renderContext(view, moodThresholds);
    this.renderCost(view);
    this.renderTokens(view);
    this.renderChart(view);
    this.renderTools(view);
    this.renderRecentTools(view, now);
    this.renderQuota(view, quota);
  }

  renderHeader(view) {
    const f = this.fields;
    setText(f.title, view.name);
    setText(f.subtitle, `${providerLabel(view.provider)} · ${view.project} · pid ${view.pid}`);
    setText(f.activityBadge, ACTIVITY_NOUNS[view.activity] ?? view.activity);
    f.activityBadge.dataset.tone = activityTone(view.activity);
    setText(f.moodBadge, moodLabel(view.mood));
    f.moodBadge.dataset.tone = moodTone(view.mood);
  }

  renderState(view, quota, thresholds, now) {
    const f = this.fields;
    const activity = activityLabel(view);
    setText(f.activity, activity);
    setText(f.status, view.status);
    setText(f.mood, moodLabel(view.mood));
    setText(f.moodCause, explainMood(view, quota, thresholds));
    setAttribute(f.scene, "aria-label", `Chambre de ${view.name} : ${activity}, humeur : ${moodLabel(view.mood).toLowerCase()}.`);
    const hour = new Date(now).getHours();
    setText(f.skyCaption, `Il est ${clockFormat.format(now)} : la fenêtre montre ${SKY_LABELS[skyPhase(hour)]}.`);
  }

  renderTime(view, now) {
    const f = this.fields;
    setText(f.startedAt, dateTimeFormat.format(view.startedAt));
    setText(f.duration, formatDuration(now - view.startedAt));
    setText(
      f.lastActivity,
      view.lastActivityAt === null
        ? "Aucune activité enregistrée"
        : `${formatRelative(now - view.lastActivityAt)} · ${timeFormat.format(view.lastActivityAt)}`,
    );
  }

  renderIdentity(view) {
    const f = this.fields;
    setText(f.identName, view.name);
    setText(f.identProvider, providerLabel(view.provider));
    setText(f.identPath, view.cwd);
    setText(f.identSession, view.sessionId);
    setText(f.identModel, view.model ?? UNKNOWN);
    setText(f.identVersion, view.version || UNKNOWN);
    setText(f.identPid, String(view.pid));
  }

  renderContext(view, thresholds) {
    const f = this.fields;
    const percent = view.contextPercent;
    const size = view.contextWindowSize;
    const used = percent !== null && size ? Math.round((size * percent) / 100) : null;

    setText(f.contextValue, percent === null ? UNKNOWN : formatPercent(percent));
    setPercentWidth(f.contextFill, percent ?? 0);
    f.contextFill.dataset.level = levelFor(percent ?? 0, thresholds.contextTired, thresholds.contextExhausted);
    f.contextTickTired.style.left = `${thresholds.contextTired}%`;
    f.contextTickExhausted.style.left = `${thresholds.contextExhausted}%`;
    setText(f.contextTicksNote, `Repères : fatigue à ${thresholds.contextTired} %, épuisement à ${thresholds.contextExhausted} %.`);
    if (percent === null) {
      f.contextMeter.removeAttribute("aria-valuenow");
      setAttribute(f.contextMeter, "aria-valuetext", "Contexte inconnu");
    } else {
      setAttribute(f.contextMeter, "aria-valuenow", String(Math.round(percent)));
      setAttribute(f.contextMeter, "aria-valuetext", formatPercent(percent));
    }
    setText(f.contextWindow, size ? `${numberFormat.format(size)} tokens` : UNKNOWN);
    setText(f.contextUsed, used === null ? UNKNOWN : `≈ ${numberFormat.format(used)} tokens`);
    setText(f.contextFree, used === null ? UNKNOWN : `≈ ${numberFormat.format(Math.max(0, size - used))} tokens`);
  }

  renderCost(view) {
    const f = this.fields;
    setText(f.cost, describeCost(view));
    setText(f.turns, numberFormat.format(view.turns));
    setText(f.costPerTurn, view.costUsd !== null && view.turns > 0 ? preciseMoneyFormat.format(view.costUsd / view.turns) : "–");
    setText(f.rate, numberFormat.format(view.tokensPerMinute));
  }

  renderTokens(view) {
    const f = this.fields;
    const { tokens } = view;
    const total = TOKEN_PARTS.reduce((sum, part) => sum + tokens[part.key], 0);
    const summary = [];
    for (const { part, segment, value, share } of this.tokenRows) {
      const percent = total > 0 ? (tokens[part.key] / total) * 100 : 0;
      setPercentWidth(segment, percent);
      setText(value, numberFormat.format(tokens[part.key]));
      setText(share, total > 0 ? formatShare(percent) : "–");
      summary.push(`${part.label.toLowerCase()} ${formatShare(percent)}`);
    }
    setText(f.tokenTotal, numberFormat.format(total));
    setAttribute(f.tokenBar, "aria-label", total > 0 ? `Répartition des tokens : ${summary.join(", ")}.` : "Aucun token comptabilisé.");

    const inputSide = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    setText(
      f.cacheRatio,
      inputSide > 0
        ? `Le cache a servi ${formatShare((tokens.cacheRead / inputSide) * 100)} des tokens d'entrée.`
        : "Aucun token d'entrée à comparer pour l'instant.",
    );
    // Un amont qui ne transmet pas `usage` (proxy) laisse des zéros : on le dit plutôt que de les afficher comme une mesure.
    f.usageWarning.hidden = view.usageReliable;
    const warning = view.provider === "claude" ? USAGE_WARNING_CLAUDE : USAGE_WARNING_GENERIC;
    setText(f.usageWarning, view.usageReliable ? "" : warning);
  }

  renderChart(view) {
    const f = this.fields;
    const { history } = view;
    const sum = history.reduce((acc, value) => acc + value, 0);
    this.chart.render(history, view.avatar.hue);
    setText(f.chartWindow, `${history.length} dernières minutes`);
    setText(f.chartPeak, numberFormat.format(Math.max(0, ...history)));
    setText(f.chartAverage, numberFormat.format(history.length > 0 ? Math.round(sum / history.length) : 0));
    setText(f.chartSum, numberFormat.format(sum));
  }

  renderTools(view) {
    const f = this.fields;
    const counts = this.toolRows.map(({ kind }) => view.toolCounts?.[kind] ?? 0);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const peak = Math.max(0, ...counts);
    this.toolRows.forEach(({ row, fill, count }, index) => {
      setPercentWidth(fill, peak > 0 ? (counts[index] / peak) * 100 : 0);
      setText(count, numberFormat.format(counts[index]));
      row.dataset.empty = counts[index] === 0 ? "true" : "false";
    });
    setText(f.toolsTotal, total === 0 ? "Aucun appel d'outil pour l'instant." : `${numberFormat.format(total)} appels d'outils depuis le début de la session.`);
  }

  renderRecentTools(view, now) {
    const f = this.fields;
    const recent = view.recentTools ?? [];
    f.recentEmpty.hidden = recent.length > 0;
    f.recentList.hidden = recent.length === 0;
    syncChildren(
      f.recentList,
      recent,
      () => this.createRecentRow(),
      (row, tool) => this.updateRecentRow(row, tool, now),
    );
  }

  createRecentRow() {
    const icon = createElement("canvas", "tool-icon");
    icon.setAttribute("aria-hidden", "true");
    const text = createElement("span", "recent-text");
    text.append(createElement("span", "recent-name"), createElement("span", "recent-kind"));
    const when = createElement("span", "recent-when");
    when.append(createElement("time", "recent-time"), createElement("span", "recent-ago"));
    const row = createElement("li", "recent-row");
    row.append(icon, text, when);
    return row;
  }

  updateRecentRow(row, tool, now) {
    const icon = row.querySelector(".tool-icon");
    if (icon.dataset.kind !== tool.kind) {
      drawToolIcon(icon, this.sprites, tool.kind);
      icon.dataset.kind = tool.kind;
    }
    setText(row.querySelector(".recent-name"), tool.name);
    setText(row.querySelector(".recent-kind"), TOOL_NOUNS[tool.kind] ?? TOOL_NOUNS.other);
    const time = row.querySelector(".recent-time");
    setAttribute(time, "datetime", new Date(tool.at).toISOString());
    setText(time, timeFormat.format(tool.at));
    setText(row.querySelector(".recent-ago"), formatRelative(now - tool.at));
  }

  renderQuota(view, quota) {
    const f = this.fields;
    setText(f.quotaTitle, `Quota du compte ${providerLabel(view.provider)}`);
    renderGauge(f.gaugeFiveHour, quota.fiveHour);
    renderGauge(f.gaugeSevenDay, quota.sevenDay);
    setText(f.quotaSource, describeQuotaSource(quota));
  }
}
