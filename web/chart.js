// Histogramme SVG des tokens par minute, avec axes. Le SVG est reconstruit à la largeur réelle du conteneur :
// le texte garde sa taille à 360 px comme à 1280 px (un viewBox fixe le réduirait).
import { compactFormat, numberFormat } from "./format.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_HEIGHT = 200;
const MARGIN = Object.freeze({ top: 12, right: 12, bottom: 28, left: 50 });
const Y_INTERVALS = 4;
/** Multiples « lisibles » pour les graduations : 1, 2, 2,5, 5, 10 × puissance de dix. */
const NICE_MULTIPLIERS = [1, 2, 2.5, 5, 10];
const MIN_DRAWABLE_WIDTH = 200;
/** Au-delà, une graduation toutes les 5 minutes tient sans chevauchement. */
const WIDE_CHART_PX = 520;
const NOW_LABEL_MIN_PX = 320;
const BAR_GAP_PX = 2;

function svgElement(name, attributes, className) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (className) element.setAttribute("class", className);
  return element;
}

function svgText(text, attributes, className) {
  const element = svgElement("text", attributes, className);
  element.textContent = text;
  return element;
}

/** Plus petit pas lisible ≥ `rawStep` (entier ≥ 1). */
export function niceStep(rawStep) {
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  return NICE_MULTIPLIERS.map((multiplier) => multiplier * magnitude).find((step) => step >= rawStep);
}

export class TokenChart {
  constructor(container) {
    this.container = container;
    this.svg = svgElement("svg", { role: "img", focusable: "false" }, "chart-svg");
    container.append(this.svg);
    this.data = null;
    this.signature = "";
    new ResizeObserver(() => this.draw()).observe(container);
  }

  /** `history` : tokens par minute, du plus ancien au plus récent (le dernier est la minute en cours). */
  render(history, hue) {
    this.data = { history, hue };
    this.draw();
  }

  draw() {
    if (!this.data) return;
    const width = Math.floor(this.container.clientWidth);
    if (width < MIN_DRAWABLE_WIDTH) return; // conteneur masqué : le ResizeObserver redessinera à l'affichage.
    const { history, hue } = this.data;
    const signature = `${width}|${hue}|${history.join(",")}`;
    if (signature === this.signature) return;
    this.signature = signature;

    const plotWidth = width - MARGIN.left - MARGIN.right;
    const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
    const baseline = MARGIN.top + plotHeight;
    const peak = Math.max(0, ...history);
    const step = niceStep(Math.max(peak, Y_INTERVALS) / Y_INTERVALS);
    const ceiling = step * Y_INTERVALS;
    const slot = plotWidth / history.length;
    const barWidth = Math.max(1, Math.floor(slot) - BAR_GAP_PX);

    const nodes = [];
    for (let tick = 0; tick <= Y_INTERVALS; tick += 1) {
      const y = baseline - (tick / Y_INTERVALS) * plotHeight;
      nodes.push(svgElement("line", { x1: MARGIN.left, x2: MARGIN.left + plotWidth, y1: y, y2: y }, tick === 0 ? "chart-axis" : "chart-grid"));
      nodes.push(svgText(compactFormat.format(step * tick), { x: MARGIN.left - 8, y: y + 4, "text-anchor": "end" }, "chart-label"));
    }

    const lastIndex = history.length - 1;
    history.forEach((value, index) => {
      const barHeight = value > 0 ? Math.max(2, Math.round((value / ceiling) * plotHeight)) : 1;
      const isNow = index === lastIndex;
      const bar = svgElement(
        "rect",
        {
          x: Math.round(MARGIN.left + index * slot + (slot - barWidth) / 2),
          y: baseline - barHeight,
          width: barWidth,
          height: barHeight,
          ...(value > 0 && { fill: isNow ? `hsl(${hue} 85% 78%)` : `hsl(${hue} 62% 62%)` }),
        },
        value > 0 ? "chart-bar" : "chart-bar chart-bar-zero",
      );
      const minutesAgo = lastIndex - index;
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `${minutesAgo === 0 ? "Minute en cours" : `Il y a ${minutesAgo} min`} : ${numberFormat.format(value)} tokens/min`;
      bar.append(title);
      nodes.push(bar);
    });

    const labelEvery = plotWidth >= WIDE_CHART_PX ? 5 : 10;
    // « maintenant » (10 caractères) touche le repère « −10 min » quand le tracé fait moins de ~300 px.
    const nowLabel = plotWidth >= NOW_LABEL_MIN_PX ? "maintenant" : "maint.";
    for (let minutesAgo = 0; minutesAgo <= lastIndex; minutesAgo += labelEvery) {
      const center = MARGIN.left + (lastIndex - minutesAgo) * slot + slot / 2;
      const isNow = minutesAgo === 0;
      nodes.push(svgElement("line", { x1: center, x2: center, y1: baseline, y2: baseline + 4 }, "chart-axis"));
      nodes.push(
        svgText(
          isNow ? nowLabel : `−${minutesAgo} min`,
          { x: isNow ? MARGIN.left + plotWidth : center, y: baseline + 18, "text-anchor": isNow ? "end" : "middle" },
          "chart-label",
        ),
      );
    }

    this.svg.setAttribute("viewBox", `0 0 ${width} ${CHART_HEIGHT}`);
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(CHART_HEIGHT));
    this.svg.setAttribute(
      "aria-label",
      `Tokens par minute sur les ${history.length} dernières minutes. Pic : ${numberFormat.format(peak)}. Minute en cours : ${numberFormat.format(history[lastIndex] ?? 0)}.`,
    );
    this.svg.replaceChildren(...nodes);
  }
}
