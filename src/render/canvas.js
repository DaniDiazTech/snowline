/** Offscreen canvas helpers shared by the render layers. */

/** A 2D canvas that never touches the page (OffscreenCanvas when available). */
export function makeCanvas(width, height) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Resizes (and clears) a canvas made by makeCanvas. */
export function sizeCanvas(canvas, width, height) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas;
}

/** Fractional part, always positive (for wrapping scroll offsets). */
export function wrap(v, size) {
  return ((v % size) + size) % size;
}
