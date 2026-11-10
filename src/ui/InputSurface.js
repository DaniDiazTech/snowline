/**
 * The whole screen is the race's one button.
 *
 * Pointer / touch anywhere that is not an interactive element, Space, ArrowUp
 * or W → onInput(true); release → onInput(false). Only emits on changes,
 * ignores key auto-repeat, and force-releases on blur / tab hide / pointer
 * cancel so the button can never stick. Inactive unless enable() was called.
 */
const KEYS = new Set(['Space', 'ArrowUp', 'KeyW']);
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="dialog"], [data-ui-interactive]';

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
      this._sync();
    };
    this._up = (e) => {
      if (!this.pointers.delete(e.pointerId)) return;
      this._sync();
    };
    this._keyDown = (e) => {
      if (!this.active || !KEYS.has(e.code)) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
      e.preventDefault(); // no page scroll, no button activation
      if (e.repeat || this.keys.has(e.code)) return;
      this.keys.add(e.code);
      this._sync();
    };
    this._keyUp = (e) => {
      if (!this.keys.delete(e.code)) return;
      e.preventDefault();
      this._sync();
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
    // Long-press menus, selection and iOS touch gestures while racing.
    window.addEventListener('contextmenu', this._block);
    window.addEventListener('selectstart', this._block);
    window.addEventListener('touchstart', this._block, { passive: false });
    window.addEventListener('touchmove', this._block, { passive: false });
  }

  enable() {
    this.active = true;
  }

  disable() {
    this.releaseAll();
    this.active = false;
  }

  releaseAll() {
    this.pointers.clear();
    this.keys.clear();
    this._sync();
  }

  _sync() {
    const held = this.active && (this.pointers.size > 0 || this.keys.size > 0);
    if (held === this.held) return;
    this.held = held;
    this.onChange(held);
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
    window.removeEventListener('contextmenu', this._block);
    window.removeEventListener('selectstart', this._block);
    window.removeEventListener('touchstart', this._block);
    window.removeEventListener('touchmove', this._block);
  }
}
