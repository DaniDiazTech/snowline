/**
 * Small yes/no dialog. ask() resolves true (confirmed) or false (cancelled / dismissed).
 */
import { h } from './dom.js';
import { Modal } from './Modal.js';

export class ConfirmModal {
  /** @param {(open:boolean)=>void} onToggle */
  constructor(onToggle) {
    this.resolve = null;
    this.title = h('h2', { class: 'modal__title', id: 'confirm-title' });
    this.body = h('p', { class: 'confirm__body' });
    this.okBtn = h('button', { class: 'btn btn--primary', type: 'button', 'data-testid': 'confirm-ok', onclick: () => this._answer(true) }, h('span', { class: 'btn__label' }));
    this.cancelBtn = h('button', { class: 'btn btn--ghost', type: 'button', 'data-testid': 'confirm-cancel', onclick: () => this._answer(false) }, h('span', { class: 'btn__label' }));
    this.modal = new Modal({
      testid: 'confirm',
      titleId: 'confirm-title',
      panelClass: 'confirm',
      onToggle,
      onClose: () => this._answer(false),
      content: [h('p', { class: 'eyebrow' }, 'Are you sure?'), this.title, this.body, h('div', { class: 'confirm__actions' }, this.cancelBtn, this.okBtn)],
    });
    this.el = this.modal.el;
  }

  /** @param {{title:string, body?:string, ok?:string, cancel?:string}} o  @returns {Promise<boolean>} */
  ask({ title, body = '', ok = 'OK', cancel = 'Cancel' }) {
    this._answer(false); // a pending question is cancelled by a new one
    this.title.textContent = title;
    this.body.textContent = body;
    this.body.hidden = !body;
    this.okBtn.firstChild.textContent = ok;
    this.cancelBtn.firstChild.textContent = cancel;
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.modal.show(this.cancelBtn);
    });
  }

  _answer(value) {
    const r = this.resolve;
    this.resolve = null;
    if (this.modal.open) this.modal.close();
    r?.(value);
  }
}
