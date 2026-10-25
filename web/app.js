import { DetailView } from "./detail.js";
import { byId, setAttribute, setPercentWidth, setText } from "./dom.js";
import { compactFormat, formatPercent, levelFor, moneyFormat, numberFormat } from "./format.js";
import { describeQuotaSource, renderGauge } from "./gauges.js";
import { PROVIDER_LABELS, activityLabel, moodLabel, moodTone, providerLabel } from "./labels.js";
import { RoomPainter } from "./scene.js";
import { loadSprites } from "./sprites.js";

const FRAME_MS = 125;
const APP_TITLE = document.title;
const CONTEXT_WARN_AT = 70;
const CONTEXT_DANGER_AT = 90;
const SESSION_ROUTE = /^#\/session\/([^/?#]+)$/;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const gridView = byId("view-grid");
const troupe = byId("troupe");
const template = byId("card-template");
const announcer = byId("announcer");

/** sessionId → carte : on réutilise les cartes pour ne pas faire clignoter l'animation. */
const cards = new Map();
/** sessionId → nom, pour expliquer « session terminée » même après sa disparition de l'état. */
const knownNames = new Map();

let sprites = null;
let detail = null;
/** Dernier état reçu du démon ; null tant que le flux n'a rien envoyé. */
let dashboard = null;
let route = { name: "grid" };
/** « content », « loading » ou « gone » : phase actuelle de la vue détaillée. */
let detailPhase = null;
/** Vrai quand la vue détaillée a été ouverte depuis la grille : « Retour » peut alors rejouer l'historique. */
let openedFromGrid = false;
let gridScrollY = 0;
let cardSerial = 0;
let announcedCount = null;

function parseRoute(hash) {
  const match = SESSION_ROUTE.exec(hash);
  if (!match) return { name: "grid" };
  try {
    return { name: "session", sessionId: decodeURIComponent(match[1]) };
  } catch {
    return { name: "grid" }; // séquence %-encodée invalide dans l'URL.
  }
}

const sessionHref = (sessionId) => `#/session/${encodeURIComponent(sessionId)}`;

/** Un groupe de jauges par fournisseur ; les ids viennent de index.html (gauge-{fournisseur}-five-hour…). */
const quotaGroups = Object.keys(PROVIDER_LABELS).map((provider) => ({
  provider,
  element: byId(`quota-group-${provider}`),
  fiveHour: byId(`gauge-${provider}-five-hour`),
  sevenDay: byId(`gauge-${provider}-seven-day`),
  source: byId(`quota-source-${provider}`),
}));

/**
 * Un groupe est visible si son fournisseur a au moins une session ou une mesure de quota.
 * Sans l'un ni l'autre pour les deux, on montre les deux groupes (« Pas encore de mesure »).
 */
function renderQuota(state) {
  const activeProviders = new Set(state.sessions.map((view) => view.provider));
  const hasData = (group) => activeProviders.has(group.provider) || state.quotas[group.provider].source !== "none";
  const showAll = !quotaGroups.some(hasData);
  for (const group of quotaGroups) {
    group.element.hidden = !showAll && !hasData(group);
    const quota = state.quotas[group.provider];
    renderGauge(group.fiveHour, quota.fiveHour);
    renderGauge(group.sevenDay, quota.sevenDay);
    setText(group.source, describeQuotaSource(quota));
  }
}

function renderTotals(state) {
  setText(byId("total-sessions"), String(state.totals.sessions));
  setText(byId("total-working"), String(state.totals.working));
  setText(byId("total-rate"), compactFormat.format(state.totals.tokensPerMinute));
  setText(byId("total-cost"), moneyFormat.format(state.totals.costUsd));
  const chip = byId("device-chip");
  chip.dataset.state = state.device.connected ? "on" : "off";
  setText(chip, state.device.connected ? `Carte USB : ${state.device.path}` : "Carte USB : non connectée");
}

function drawSparkline(canvas, history, hue) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const peak = Math.max(1, ...history);
  const barWidth = canvas.width / history.length;
  history.forEach((value, index) => {
    const height = Math.max(value > 0 ? 2 : 1, Math.round((value / peak) * (canvas.height - 2)));
    context.fillStyle = value > 0 ? `hsl(${hue} 62% 62%)` : "#2a2648";
    context.fillRect(Math.floor(index * barWidth), canvas.height - height, Math.max(1, Math.floor(barWidth) - 1), height);
  });
}

function createCard(view) {
  const element = template.content.firstElementChild.cloneNode(true);
  const id = `card-${++cardSerial}`;
  const card = {
    element,
    view,
    painter: new RoomPainter(element.querySelector(".scene"), sprites),
    link: element.querySelector(".card-link"),
    mood: element.querySelector(".card-mood"),
    provider: element.querySelector(".card-provider"),
    project: element.querySelector(".card-project"),
    activity: element.querySelector(".card-activity"),
    meter: element.querySelector(".bar-track"),
    fill: element.querySelector(".bar-fill"),
    contextValue: element.querySelector(".bar-value"),
    spark: element.querySelector(".spark"),
    rate: element.querySelector(".stat-rate"),
  };
  card.provider.id = `${id}-provider`;
  card.project.id = `${id}-project`;
  card.activity.id = `${id}-activity`;
  card.mood.id = `${id}-mood`;
  // Le nom du lien reste court (le nom de la session) ; le reste de la carte est lu comme description.
  card.link.setAttribute("aria-describedby", `${card.provider.id} ${card.project.id} ${card.activity.id} ${card.mood.id}`);
  card.link.setAttribute("href", sessionHref(view.sessionId));
  return card;
}

function updateCard(card, view) {
  card.view = view;
  card.element.dataset.activity = view.activity;
  setText(card.link, view.name);
  setText(card.provider, providerLabel(view.provider));
  card.provider.dataset.provider = view.provider;
  setText(card.project, `${view.project} · pid ${view.pid}`);
  setText(card.activity, activityLabel(view));
  setText(card.mood, moodLabel(view.mood));
  card.mood.dataset.tone = moodTone(view.mood);

  const context = view.contextPercent;
  setPercentWidth(card.fill, context ?? 0);
  card.fill.dataset.level = levelFor(context ?? 0, CONTEXT_WARN_AT, CONTEXT_DANGER_AT);
  setText(card.contextValue, formatPercent(context));
  if (context === null) {
    card.meter.removeAttribute("aria-valuenow");
    setAttribute(card.meter, "aria-valuetext", "Contexte inconnu");
  } else {
    setAttribute(card.meter, "aria-valuenow", String(Math.round(context)));
    setAttribute(card.meter, "aria-valuetext", formatPercent(context));
  }

  setText(card.rate, numberFormat.format(view.tokensPerMinute));
  drawSparkline(card.spark, view.history, view.avatar.hue);
}

function announceSessionCount(count) {
  if (announcedCount !== null && count !== announcedCount) {
    announcer.textContent = count === 0 ? "Aucune session active." : `${count} session${count > 1 ? "s" : ""} active${count > 1 ? "s" : ""}.`;
  }
  announcedCount = count;
}

function renderSessions(sessions) {
  const alive = new Set(sessions.map((view) => view.sessionId));
  for (const [sessionId, card] of cards) {
    if (!alive.has(sessionId)) {
      card.element.remove();
      cards.delete(sessionId);
    }
  }
  sessions.forEach((view, index) => {
    knownNames.set(view.sessionId, view.name);
    let card = cards.get(view.sessionId);
    if (!card) {
      card = createCard(view);
      cards.set(view.sessionId, card);
    }
    updateCard(card, view);
    // append déplace un nœud déjà présent : l'ordre suit celui du démon. On ne touche au DOM que si l'ordre change,
    // sinon le lien qui a le focus le perdrait à chaque seconde.
    if (troupe.children[index] !== card.element) troupe.append(card.element);
  });
  byId("empty-state").hidden = sessions.length > 0;
  announceSessionCount(sessions.length);
}

/** Focus sans défilement : la position de la page est gérée à part (restauration du défilement de la grille). */
function focusElement(element) {
  element?.focus({ preventScroll: true });
}

function goneMessage(sessionId) {
  const name = knownNames.get(sessionId);
  return name
    ? `La session « ${name} » est terminée : son processus ne tourne plus.`
    : "Aucune session active ne porte cet identifiant. Elle est peut-être terminée, ou le lien est périmé.";
}

/**
 * Met la vue détaillée à jour avec l'état courant. `forceFocus` : on vient d'arriver sur la route.
 * Sinon on ne déplace le focus que s'il est perdu (<body>), pour ne jamais le voler à quelqu'un qui navigue.
 */
function refreshDetail(forceFocus = false) {
  if (route.name !== "session") return;
  const view = dashboard?.sessions.find((session) => session.sessionId === route.sessionId) ?? null;
  const phase = !dashboard ? "loading" : view ? "content" : "gone";
  const phaseChanged = phase !== detailPhase;
  detailPhase = phase;

  if (phaseChanged) detail.setPhase(phase);
  if (phase === "content") {
    detail.update(view, dashboard, Date.now());
    if (phaseChanged || forceFocus) document.title = `${view.name} — ${APP_TITLE}`;
  } else if (phase === "gone") {
    detail.setGoneMessage(goneMessage(route.sessionId));
    if (phaseChanged) document.title = `Session terminée — ${APP_TITLE}`;
  }

  // Un élément qu'on vient de masquer reste `activeElement` jusqu'au prochain rendu : on teste aussi `[hidden]`.
  const active = document.activeElement;
  const focusLost = !active || active === document.body || active.closest("[hidden]") !== null;
  if (forceFocus || (phaseChanged && focusLost)) focusElement(detail.headingFor(phase));
}

function onRouteChange() {
  const previous = route;
  route = parseRoute(location.hash);

  if (route.name === "session") {
    if (previous.name === "grid") gridScrollY = window.scrollY;
    gridView.hidden = true;
    detail.root.hidden = false;
    detailPhase = null;
    refreshDetail(true);
    window.scrollTo(0, 0);
    return;
  }

  openedFromGrid = false;
  detailPhase = null;
  detail.root.hidden = true;
  gridView.hidden = false;
  document.title = APP_TITLE;
  window.scrollTo(0, gridScrollY);
  if (previous.name === "session") {
    // On rend le focus à la carte d'où l'on vient ; à défaut, au titre de la grille.
    focusElement(cards.get(previous.sessionId)?.link ?? byId("troupe-title"));
  }
}

/** « Retour » : rejoue l'historique si on vient de la grille (pas d'entrée en double), sinon navigue vers la grille. */
function goBack() {
  if (openedFromGrid) history.back();
  else location.hash = "#/";
}

const isPlainPrimaryClick = (event) => event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;

function bindNavigation() {
  troupe.addEventListener("click", (event) => {
    if (event.target.closest(".card-link") && isPlainPrimaryClick(event)) openedFromGrid = true;
  });
  byId("view-detail").addEventListener("click", (event) => {
    if (!event.target.closest(".js-back") || !isPlainPrimaryClick(event)) return;
    event.preventDefault();
    goBack();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (route.name !== "session") return;
    event.preventDefault();
    goBack();
  });
  window.addEventListener("hashchange", onRouteChange);
  history.scrollRestoration = "manual";
}

function render(state) {
  dashboard = state;
  byId("offline-state").hidden = true;
  renderTotals(state);
  renderQuota(state);
  renderSessions(state.sessions);
  refreshDetail();
}

function animate(timestamp) {
  const frame = reducedMotion.matches ? 1 : Math.floor(timestamp / FRAME_MS);
  const hour = new Date().getHours();
  if (route.name === "session") {
    detail.draw(frame, hour);
  } else {
    for (const card of cards.values()) card.painter.paint(card.view, frame, hour);
  }
  requestAnimationFrame(animate);
}

function connect() {
  const events = new EventSource("/events");
  events.onmessage = (message) => render(JSON.parse(message.data));
  events.onerror = () => {
    byId("offline-state").hidden = false;
  };
}

function showFatalError(message) {
  const element = byId("error-state");
  element.textContent = message;
  element.hidden = false;
}

try {
  sprites = await loadSprites();
} catch (error) {
  showFatalError(`Impossible de charger les sprites : ${error.message}`);
  throw error;
}
detail = new DetailView(byId("view-detail"), sprites);
bindNavigation();
onRouteChange();
connect();
requestAnimationFrame(animate);
