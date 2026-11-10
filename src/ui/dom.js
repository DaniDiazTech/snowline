/**
 * Tiny DOM helpers. User-provided text is always set with textContent;
 * `icon()` only ever parses the static SVG strings from icons.js.
 */

/**
 * h('button', { class: 'btn', type: 'button', 'data-testid': 'x', onclick }, 'Label', childNode)
 * - `class` → className, `text` → textContent, `on*` → event listener,
 * - `style` (object) → CSS custom properties / styles, other keys → attributes (true → "", false/null → skipped).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const iconCache = new Map();
/** Parses one of the static SVG strings from icons.js into a fresh element. */
export function icon(markup, className = 'icon') {
  let tpl = iconCache.get(markup);
  if (!tpl) {
    tpl = document.createElement('template');
    tpl.innerHTML = markup.trim();
    iconCache.set(markup, tpl);
  }
  const svg = tpl.content.firstElementChild.cloneNode(true);
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

/** Sets textContent only when it actually changed (cheap per-frame updates). */
export function setText(el, value) {
  const s = String(value);
  if (el.__text !== s) {
    el.__text = s;
    el.textContent = s;
  }
}

/** Restarts a CSS animation class on an element. */
export function replay(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // reflow so the animation starts again
  el.classList.add(className);
}

export const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const finePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
