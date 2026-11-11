/**
 * First-run how-to: four lines on the one-button controls, shown before the first race.
 * In practice the countdown waits for it ("Let's ride"); in a room race it shows during the
 * countdown and closes itself at GO. Either way onDone() runs once when it closes.
 */
import { h, icon } from './dom.js';
import { ICONS } from './icons.js';
import { Modal } from './Modal.js';

const TIPS = [
  { icon: ICONS.tap, keys: ['Tap', 'Space'], text: 'Jump' },
  { icon: ICONS.hold, keys: ['Hold'], text: 'Backflip off ramps and big air' },
  { icon: ICONS.bolt, keys: [], lead: 'Land tricks', text: 'Speed boost' },
  { icon: ICONS.balloon, keys: [], lead: 'Pits have ramps', text: 'Miss one and a balloon carries you over. Costs 3\u00a0s' },
];

export class Onboarding {
  /** @param {(open:boolean)=>void} onToggle */
  constructor(onToggle) {
    this.onDone = null;
    this.okBtn = h('button', { class: 'btn btn--primary btn--block', type: 'button', 'data-testid': 'onboarding-ok', onclick: () => this.close() }, h('span', { class: 'btn__label' }, "Let's ride"));
    this.skipBtn = h('button', { class: 'link-btn', type: 'button', 'data-testid': 'onboarding-skip', onclick: () => this.close() }, 'Skip');
    this.sub = h('p', { class: 'howto__sub' });
    const list = h(
      'ul',
      { class: 'howto' },
      TIPS.map((t, i) =>
        h(
          'li',
          { class: 'howto__row', style: { '--i': i } },
          h('span', { class: 'howto__icon' }, icon(t.icon, 'icon')),
          h('span', { class: 'howto__what' }, t.keys.length ? t.keys.flatMap((k, j) => (j ? [h('span', { class: 'howto__or' }, ' or '), h('kbd', {}, k)] : [h('kbd', {}, k)])) : h('b', {}, t.lead)),
          h('span', { class: 'howto__text' }, t.text)
        )
      )
    );
    this.modal = new Modal({
      testid: 'onboarding',
      titleId: 'howto-title',
      panelClass: 'howto-panel',
      onToggle,
      onClose: () => {
        const done = this.onDone;
        this.onDone = null;
        done?.();
      },
      content: [
        h('p', { class: 'eyebrow' }, 'How to ride'),
        h('h2', { class: 'modal__title', id: 'howto-title' }, 'It all comes down to one button'),
        this.sub,
        h('div', { class: 'modal__body howto__body' }, list),
        h('div', { class: 'howto__actions' }, this.okBtn, this.skipBtn),
      ],
    });
    this.el = this.modal.el;
  }

  get open() {
    return this.modal.open;
  }

  /** @param {{waiting?:boolean, onDone?:()=>void}} o  waiting: the countdown is held until it closes */
  show({ waiting = true, onDone } = {}) {
    this.onDone = onDone || null;
    this.okBtn.querySelector('.btn__label').textContent = waiting ? "Let's ride" : 'Got it';
    this.skipBtn.hidden = !waiting;
    this.sub.textContent = waiting ? "The countdown starts when you're ready." : 'The race is about to start.';
    this.modal.show(this.okBtn);
  }

  close() {
    this.modal.close();
  }
}
