/**
 * Colour helpers for the renderer.
 *
 * Colours travel through the renderer as small float arrays [r, g, b] in
 * 0..255 (cheap to mix, no string parsing in hot loops). Palettes are blended
 * in OKLab, a perceptual space: mid-way between orange and blue is a soft
 * mauve there, instead of the muddy grey a plain RGB lerp gives.
 */
import { clamp } from '../math/utils.js';

const hexCache = new Map();

/** '#rrggbb' | '#rgb' → [r, g, b] (cached, returns a shared array: copy before mutating). */
export function hex(value) {
  let rgb = hexCache.get(value);
  if (rgb) return rgb;
  let h = value.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  hexCache.set(value, rgb);
  return rgb;
}

/** [r,g,b] → '#rrggbb'. */
export function toHex(c) {
  const to = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}

/** [r,g,b] (+alpha) → css rgba() string. */
export function rgba(c, a = 1) {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

/** Parses '#hex' or 'rgb(a)(...)' → [r,g,b]. */
export function parse(value) {
  if (Array.isArray(value)) return value;
  if (value[0] === '#') return hex(value);
  const m = value.match(/[\d.]+/g);
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

/* ---------- OKLab ---------- */

const toLinear = (v) => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function rgbToOklab(c) {
  const r = toLinear(c[0]);
  const g = toLinear(c[1]);
  const b = toLinear(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb(lab) {
  const l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]) ** 3;
  const m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]) ** 3;
  const s = (lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const enc = (v) => {
    v = clamp(v, 0, 1);
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  };
  return [enc(r), enc(g), enc(b)];
}

/** Perceptual mix of two colours (any accepted form) → [r,g,b]. */
export function mixLab(a, b, t) {
  const A = rgbToOklab(parse(a));
  const B = rgbToOklab(parse(b));
  return oklabToRgb([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/** Cheap RGB mix (used per frame for small tints) → new [r,g,b]. */
export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Multiplies brightness. */
export function scale(c, k) {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** Desaturate towards luminance by t. */
export function desaturate(c, t) {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] + (y - c[0]) * t, c[1] + (y - c[1]) * t, c[2] + (y - c[2]) * t];
}

/** Sum of absolute channel differences (for "has this colour changed enough to re-tint?"). */
export function colorDistance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}
