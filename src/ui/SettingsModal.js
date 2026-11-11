/**
 * Settings dialog: graphics quality, sound + volume, reduced effects, replay the how-to.
 * Opens from the corner gear on every screen; during a race it does not pause anything.
 *
 * handlers: onPrefs(partial), onQualityInfo() → {mode,name,pixelDensity,fps}|null, onReplayTutorial()
 */
import { h } from './dom.js';
import { Modal } from './Modal.js';

const QUALITY = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];
const QUALITY_NOTE = {
  auto: 'Adjusts itself to keep the game smooth.',
  low: 'For older laptops and phones.',
  medium: 'A middle ground.',
  high: 'Sharpest. Needs a good graphics card.',
};

export class SettingsModal {
  /** @param {Object} handlers  @param {(open:boolean)=>void} onToggle */
  constructor(handlers, onToggle) {
    this.handlers = handlers;
    this.prefs = { quality: 'auto', volume: 1, reduceFx: false, muted: false, qualityApi: true };

    // graphics
    this.qButtons = QUALITY.map((q, i) =>
      h(
        'button',
        { class: 'seg__opt', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-value': q.value, 'data-testid': `prefs-quality-${q.value}`, onclick: () => this._set({ quality: q.value }), onkeydown: (e) => this._arrows(e, i) },
        h('span', { class: 'seg__label' }, q.label)
      )
    );
    this.qGroup = h('div', { class: 'seg seg--quality', role: 'radiogroup', 'aria-labelledby': 'prefs-lbl-quality', style: { '--n': QUALITY.length } }, h('span', { class: 'seg__thumb', 'aria-hidden': 'true' }), this.qButtons);
    this.qNote = h('p', { class: 'prefs__note', 'data-testid': 'prefs-quality-note', 'aria-live': 'polite' });

    // sound
    this.soundSwitch = this._switch('prefs-sound', 'Sound', () => this._set({ muted: !this.prefs.muted }));
    this.volume = h('input', {
      class: 'range',
      type: 'range',
      min: '0',
      max: '100',
      step: '5',
      value: '100',
      'aria-label': 'Volume',
      'data-testid': 'prefs-volume',
      oninput: () => this._volumeInput(),
      onchange: () => this._set({ volume: Number(this.volume.value) / 100 }),
    });
    this.volumeOut = h('output', { class: 'prefs__value', 'aria-hidden': 'true' }, '100');

    // effects
    this.fxSwitch = this._switch('prefs-reduce', 'Reduce effects', () => this._set({ reduceFx: !this.prefs.reduceFx }));

    this.tutorialBtn = h(
      'button',
      {
        class: 'link-btn',
        type: 'button',
        'data-testid': 'prefs-tutorial',
        onclick: () => {
          this.handlers.onReplayTutorial?.();
          this.tutorialBtn.textContent = 'The how-to shows in your next race';
          this.tutorialBtn.disabled = true;
        },
      },
      'Show the how-to again'
    );

    this.modal = new Modal({
      testid: 'settings-modal',
      titleId: 'prefs-title',
      panelClass: 'prefs',
      onToggle: (open) => {
        clearInterval(this._live);
        if (open) {
          this._renderLive();
          this._live = setInterval(() => this._renderLive(), 1000);
        }
        onToggle?.(open);
      },
      content: [],
    });
    this.closeBtn = this.modal.closeButton('prefs-close');
    this.modal.panel.append(
      h('header', { class: 'modal__head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Preferences'), h('h2', { class: 'modal__title', id: 'prefs-title' }, 'Settings')), this.closeBtn),
      h(
        'div',
        { class: 'modal__body prefs__body' },
        h('section', { class: 'prefs__group' }, h('h3', { class: 'section-title', id: 'prefs-lbl-quality' }, 'Graphics'), this.qGroup, this.qNote),
        h(
          'section',
          { class: 'prefs__group' },
          h('h3', { class: 'section-title' }, 'Sound'),
          h('div', { class: 'prefs__row' }, h('span', { class: 'prefs__label' }, 'Sound', h('small', {}, 'Press M to mute')), this.soundSwitch),
          h('div', { class: 'prefs__row prefs__row--volume' }, h('span', { class: 'prefs__label' }, 'Volume'), this.volume, this.volumeOut)
        ),
        h(
          'section',
          { class: 'prefs__group' },
          h('h3', { class: 'section-title' }, 'Motion'),
          h('div', { class: 'prefs__row' }, h('span', { class: 'prefs__label' }, 'Reduce effects', h('small', {}, 'Fewer animations and flashes')), this.fxSwitch)
        ),
        h('div', { class: 'prefs__foot' }, this.tutorialBtn)
      )
    );
    this.el = this.modal.el;
  }

  get open() {
    return this.modal.open;
  }

  show() {
    this.tutorialBtn.disabled = false;
    this.tutorialBtn.textContent = 'Show the how-to again';
    this.modal.show(this.closeBtn);
  }

  close() {
    this.modal.close();
  }

  /** @param {{quality:string, volume:number, reduceFx:boolean, muted:boolean, qualityApi?:boolean}} prefs */
  setPrefs(prefs) {
    this.prefs = { ...this.prefs, ...prefs };
    const p = this.prefs;
    const idx = Math.max(0, QUALITY.findIndex((q) => q.value === p.quality));
    this.qButtons.forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === idx));
      b.tabIndex = i === idx ? 0 : -1;
    });
    this.qGroup.style.setProperty('--i', idx);
    this._renderLive();
    this._setSwitch(this.soundSwitch, !p.muted);
    if (document.activeElement !== this.volume) this.volume.value = String(Math.round(p.volume * 100));
    this.volumeOut.textContent = String(Math.round(p.volume * 100));
    this.volume.disabled = !!p.muted;
    this._setSwitch(this.fxSwitch, !!p.reduceFx);
    document.documentElement.toggleAttribute('data-reduce-fx', !!p.reduceFx);
  }

  _renderLive() {
    const p = this.prefs;
    let text = QUALITY_NOTE[p.quality] || '';
    if (p.qualityApi === false) text = 'This build always runs one quality level.';
    const info = this.modal?.open ? this.handlers.onQualityInfo?.() : null;
    // "Now" only means something in Auto (a fixed level is applied on the next drawn frame).
    if (p.quality === 'auto' && info && info.name) text += ` Now: ${String(info.name).replace(/-(\d[\d.]*)x$/, ' · $1×').replace(/-/g, ' ')}${info.fps ? `, ${info.fps} fps` : ''}.`;
    if (this.qNote.textContent !== text) this.qNote.textContent = text;
  }

  _set(partial) {
    this.handlers.onPrefs?.(partial);
  }

  _volumeInput() {
    this.volumeOut.textContent = this.volume.value;
    this._set({ volume: Number(this.volume.value) / 100 });
  }

  _arrows(e, i) {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const j = (i + d + QUALITY.length) % QUALITY.length;
    this._set({ quality: QUALITY[j].value });
    this.qButtons[j].focus();
  }

  _switch(testid, label, onclick) {
    return h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': label, 'data-testid': testid, onclick }, h('span', { class: 'switch__knob', 'aria-hidden': 'true' }));
  }

  _setSwitch(el, on) {
    if (el.getAttribute('aria-checked') !== String(on)) el.setAttribute('aria-checked', String(on));
  }
}
