// Raccourcis DOM. Tout texte affiché passe par textContent : jamais de HTML construit à partir de données.

export function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Élément #${id} introuvable dans index.html`);
  return element;
}

/** N'écrit que si le texte change : évite de réinitialiser la sélection de l'utilisateur à chaque seconde. */
export function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

export function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Largeur en pourcentage via CSSOM (autorisé par la CSP, contrairement à l'attribut style). */
export function setPercentWidth(element, percent) {
  element.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

/** Aligne les enfants de `container` sur `items` en réutilisant les nœuds existants. */
export function syncChildren(container, items, create, update) {
  while (container.children.length > items.length) container.lastElementChild.remove();
  items.forEach((item, index) => {
    let child = container.children[index];
    if (!child) {
      child = create();
      container.append(child);
    }
    update(child, item);
  });
}
