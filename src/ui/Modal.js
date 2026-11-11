/**
 * Shared dialog shell (same look as the hall of fame): scrim + frosted panel, Escape and
 * scrim-click to close, a focus trap, focus returned on close, and an onToggle(open) hook.
 */
import { h, icon } from './dom.js';
import { ICONS } from './icons.js';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class Modal {
  /**
   * @param {Object} o
   * @param {string} o.testid           data-testid of the modal root
   * @param {string} o.titleId          id of the element that labels the dialog
   * @param {Node[]} o.content          panel children (header included)
   * @param {string} [o.panelClass]     extra classes on the panel
   * @param {string} [o.modalClass]     extra classes on the modal root
   * @param {boolean} [o.dismissable]   Escape / scrim close (default true)
   * @param {(open:boolean)=>void} [o.onToggle]
   * @param {()=>void} [o.onClose]      after a close (any cause)
   */
  constructor({ testid, titleId, content, panelClass = '', modalClass = '', dismissable = true, onToggle, onClose }) {
    this.open = false;
    this.onToggle = onToggle;
    this.onClose = onClose;
    this.dismissable = dismissable;
    this.panel = h('div', { class: `glass glass--strong modal__panel ${panelClass}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, ...content);
    this.el = h('div', { class: `modal ${modalClass}`, 'data-testid': testid, hidden: true }, h('div', { class: 'modal__scrim', onclick: () => this.dismissable && this.close() }), this.panel);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dismissable) {
        e.stopPropagation();
        this.close();
      } else if (e.key === 'Tab') this._trap(e);
    });
  }

  /** A close (×) button wired to this modal. */
  closeButton(testid, label = 'Close') {
    return h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, 'data-testid': testid, onclick: () => this.close() }, icon(ICONS.close));
  }

  /** @param {HTMLElement} [focus] element to focus (defaults to the panel) */
  show(focus) {
    if (this.open) return;
    this.open = true;
    clearTimeout(this._hideTimer);
    this.returnFocus = document.activeElement;
    this.el.hidden = false;
    // Start the enter transition on the next frame instead of forcing a synchronous layout.
    requestAnimationFrame(() => requestAnimationFrame(() => this.open && this.el.classList.add('is-open')));
    (focus || this.panel).focus({ preventScroll: true });
    this.onToggle?.(true);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('is-open');
    this._hideTimer = setTimeout(() => {
      if (!this.open) this.el.hidden = true;
    }, 320);
    if (this.returnFocus instanceof HTMLElement && this.returnFocus.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.onToggle?.(false);
    this.onClose?.();
  }

  _trap(e) {
    const f = [...this.panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === this.panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
