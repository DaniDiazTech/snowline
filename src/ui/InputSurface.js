/**
 * The whole screen is the race's one button.
 *
 * Pointer / touch anywhere that is not an interactive element, Space, ArrowUp
 * or W → onInput(true); release → onInput(false). Only emits on changes,
 * ignores key auto-repeat, and force-releases on blur / tab hide / pointer
 * cancel so the button can never stick. Inactive unless enable() was called.
 *
 * onChange(held, t) also gets the time of the edge (the DOM event's timeStamp, in the
 * performance.now() timebase), so the simulation can apply it at the tick it really happened
 * on even when the event is dispatched late (after a slow frame).
 *
 * The listeners that must be able to preventDefault (touch, selection, context menu) are only
 * attached while racing: a non-passive touch listener on window makes every scroll on the
 * menus wait for the main thread.
 */
const KEYS = new Set(['Space', 'ArrowUp', 'KeyW']);
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="dialog"], [data-ui-interactive]';

/** event.timeStamp when it is a sane performance.now() time, else now. */
function eventTime(e) {
  const now = performance.now();
  const t = e && e.timeStamp;
  return typeof t === 'number' && t > 0 && t <= now + 1 && now - t < 1000 ? t : now;
}

export class InputSurface {
  /** @param {(held:boolean)=>void} onChange */
  constructor(onChange) {
    this.onChange = onChange;
    this.active = false;
    this.held = false;
    this.pointers = new Set();
    this.keys = new Set();

    this._down = (e) => {
      if (!this.active) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
      if (e.cancelable) e.preventDefault(); // no text selection, no synthetic mouse, no focus steal
      this.pointers.add(e.pointerId);
      this._sync(eventTime(e));
    };
    this._up = (e) => {
      if (!this.pointers.delete(e.pointerId)) return;
      this._sync(eventTime(e));
    };
    this._keyDown = (e) => {
      if (!this.active || !KEYS.has(e.code)) return;
      // Typing in a field, or using a dialog's buttons (settings mid-race), is not riding.
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [role="dialog"]')) return;
      e.preventDefault(); // no page scroll, no button activation
      if (e.repeat || this.keys.has(e.code)) return;
      this.keys.add(e.code);
      this._sync(eventTime(e));
    };
    this._keyUp = (e) => {
      if (!this.keys.delete(e.code)) return;
      e.preventDefault();
      this._sync(eventTime(e));
    };
    this._release = () => this.releaseAll();
    this._visibility = () => {
      if (document.visibilityState !== 'visible') this.releaseAll();
    };
    this._block = (e) => {
      if (this.active && !(e.target instanceof Element && e.target.closest(INTERACTIVE))) e.preventDefault();
    };

    window.addEventListener('pointerdown', this._down, { passive: false });
    window.addEventListener('pointerup', this._up);
    window.addEventListener('pointercancel', this._up);
    window.addEventListener('keydown', this._keyDown);
    window.addEventListener('keyup', this._keyUp);
    window.addEventListener('blur', this._release);
    document.addEventListener('visibilitychange', this._visibility);
  }

  enable() {
    if (this.active) return;
    this.active = true;
    // Long-press menus, selection and iOS touch gestures while racing.
    window.addEventListener('contextmenu', this._block);
    window.addEventListener('selectstart', this._block);
    window.addEventListener('touchstart', this._block, { passive: false });
    window.addEventListener('touchmove', this._block, { passive: false });
  }

  disable() {
    this.releaseAll();
    if (!this.active) return;
    this.active = false;
    this._unblock();
  }

  _unblock() {
    window.removeEventListener('contextmenu', this._block);
    window.removeEventListener('selectstart', this._block);
    window.removeEventListener('touchstart', this._block);
    window.removeEventListener('touchmove', this._block);
  }

  releaseAll() {
    this.pointers.clear();
    this.keys.clear();
    this._sync();
  }

  _sync(t = performance.now()) {
    const held = this.active && (this.pointers.size > 0 || this.keys.size > 0);
    if (held === this.held) return;
    this.held = held;
    this.onChange(held, t);
  }

  destroy() {
    this.disable();
    window.removeEventListener('pointerdown', this._down);
    window.removeEventListener('pointerup', this._up);
    window.removeEventListener('pointercancel', this._up);
    window.removeEventListener('keydown', this._keyDown);
    window.removeEventListener('keyup', this._keyUp);
    window.removeEventListener('blur', this._release);
    document.removeEventListener('visibilitychange', this._visibility);
    this._unblock();
  }
}
