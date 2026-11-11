/**
 * Home screen: wordmark, name + colour, create / join / practice / hall of fame.
 */
import { PLAYER_COLORS } from '../contracts.js';
import { h, icon, replay } from './dom.js';
import { ICONS, RIDER_SVG } from './icons.js';

const CODE_LEN = 5;
const NAME_MAX = 14;
const COLOR_NAMES = ['Ember', 'Amber', 'Sun', 'Moss', 'Lagoon', 'Sky', 'Iris', 'Orchid', 'Blossom', 'Ivory', 'Cedar', 'Slate'];

export class HomeView {
  constructor(handlers) {
    this.handlers = handlers;
    this.profile = { name: '', colorIndex: 0 };
    this.inviteCode = '';
    this.busy = false;
    this.lastAction = null;

    // --- brand ---
    const brand = h(
      'div',
      { class: 'brand reveal', style: { '--d': '0ms' } },
      icon(ICONS.emblem, 'brand__emblem'),
      h('h1', { class: 'wordmark', 'aria-label': 'Snowline' }, ...[...'SNOWLINE'].map((c) => h('span', { 'aria-hidden': 'true' }, c))),
      h('p', { class: 'brand__tagline' }, 'a downhill race with friends')
    );

    // --- name + preview ---
    this.preview = h('span', { class: 'rider-preview', 'aria-hidden': 'true' });
    this.preview.append(icon(RIDER_SVG, 'rider'));
    this.nameInput = h('input', {
      id: 'home-name',
      class: 'field__input',
      type: 'text',
      maxlength: NAME_MAX,
      autocomplete: 'nickname',
      autocapitalize: 'words',
      spellcheck: 'false',
      enterkeyhint: 'go',
      placeholder: 'Your name',
      'data-testid': 'name-input',
      oninput: () => this._onNameInput(),
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.inviteCode ? this._join() : this._create();
        }
      },
    });
    this.nameHint = h('span', { class: 'field__hint', 'aria-live': 'polite' });
    const nameField = h(
      'div',
      { class: 'field field--name' },
      h('label', { class: 'field__label', for: 'home-name' }, 'Rider'),
      h('div', { class: 'field__row' }, this.preview, this.nameInput),
      this.nameHint
    );

    // --- colour swatches ---
    this.swatches = PLAYER_COLORS.map((color, i) =>
      h('button', {
        class: 'swatch',
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        'aria-label': COLOR_NAMES[i] || `Colour ${i + 1}`,
        title: COLOR_NAMES[i] || '',
        tabindex: '-1',
        style: { '--c': color },
        'data-testid': `color-swatch-${i}`,
        onclick: () => this._pickColor(i, true),
      })
    );
    const swatchGroup = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Scarf colour', onkeydown: (e) => this._swatchKeys(e) }, this.swatches);

    // --- actions ---
    this.createBtn = h('button', { class: 'btn btn--primary btn--block', type: 'button', 'data-testid': 'create-room', onclick: () => this._create() }, h('span', { class: 'btn__label' }, 'Create room'));

    this.codeInput = h('input', {
      id: 'home-code',
      class: 'code__input',
      type: 'text',
      inputmode: 'text',
      maxlength: 120, // paste-friendly (a whole invite URL works): sanitised to 5 valid chars
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      enterkeyhint: 'go',
      'aria-label': 'Room code',
      'data-testid': 'join-code',
      oninput: () => this._onCodeInput(),
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._join();
        }
      },
      onfocus: () => this._renderCells(),
      onblur: () => this._renderCells(),
      onkeyup: () => this._renderCells(),
      onselect: () => this._renderCells(),
    });
    this.cells = Array.from({ length: CODE_LEN }, () => h('span', { class: 'code__cell', 'aria-hidden': 'true' }));
    this.codeBox = h('label', { class: 'code', for: 'home-code' }, h('span', { class: 'code__cells' }, this.cells), this.codeInput);
    this.joinLabel = h('span', { class: 'btn__label' }, 'Join');
    this.joinBtn = h('button', { class: 'btn btn--join', type: 'button', 'data-testid': 'join-room', onclick: () => this._join() }, this.joinLabel);
    const joinRow = h('div', { class: 'join' }, this.codeBox, this.joinBtn);
    this.divider = h('p', { class: 'divider' }, h('span', {}, 'or join with a code'));

    this.practiceBtn = h('button', { class: 'link-btn', type: 'button', 'data-testid': 'practice', onclick: () => this._practice() }, 'Practice solo');
    this.fameBtn = h('button', { class: 'link-btn', type: 'button', 'data-testid': 'hall-of-fame', onclick: () => this.handlers.openFame() }, icon(ICONS.trophy, 'icon icon--sm'), 'Hall of fame');
    const secondary = h('div', { class: 'home__secondary' }, this.practiceBtn, h('span', { class: 'dot-sep', 'aria-hidden': 'true' }), this.fameBtn);

    // Back after a refresh: one tap to get into the same room under the same name.
    this.rejoinCode = h('span', { class: 'rejoin__code' });
    this.rejoinBtn = h(
      'button',
      { class: 'btn btn--primary btn--block', type: 'button', 'data-testid': 'rejoin', onclick: () => this._rejoin() },
      h('span', { class: 'btn__label' }, 'Rejoin')
    );
    this.rejoinEl = h('div', { class: 'rejoin', hidden: true }, h('p', { class: 'rejoin__head' }, h('span', { class: 'eyebrow' }, 'Welcome back'), this.rejoinCode), this.rejoinBtn);

    this.card = h('form', { class: 'glass home__card reveal', style: { '--d': '120ms' }, novalidate: true, onsubmit: (e) => e.preventDefault(), 'aria-label': 'Play' }, this.rejoinEl, nameField, swatchGroup, this.createBtn, this.divider, joinRow, secondary);

    const howto = h(
      'p',
      { class: 'home__howto reveal', style: { '--d': '260ms' }, 'data-testid': 'how-to' },
      h('span', {}, h('kbd', {}, 'Tap'), ' or ', h('kbd', {}, 'Space'), ' to jump'),
      h('span', { class: 'dot-sep', 'aria-hidden': 'true' }),
      h('span', {}, h('kbd', {}, 'Hold'), ' to backflip'),
      h('span', { class: 'dot-sep', 'aria-hidden': 'true' }),
      h('span', {}, 'land tricks to boost')
    );

    this.el = h('section', { class: 'screen screen--home', 'data-screen': 'home', 'aria-label': 'Snowline', hidden: true }, brand, this.card, howto);
    this._pickColor(0, false);
    this._renderCells();
  }

  /* ---------------- public ---------------- */

  setProfile(profile) {
    if (!profile) return;
    if (typeof profile.name === 'string' && document.activeElement !== this.nameInput) this.nameInput.value = profile.name.slice(0, NAME_MAX);
    this.profile.name = this.nameInput.value.trim();
    if (Number.isInteger(profile.colorIndex)) this._pickColor(profile.colorIndex, false);
  }

  setJoinCode(code) {
    const clean = sanitize(code);
    this.inviteCode = clean;
    this.codeInput.value = clean;
    this.el.classList.toggle('home--invite', !!clean);
    this.createBtn.classList.toggle('btn--primary', !clean);
    this.createBtn.classList.toggle('btn--ghost', !!clean);
    this.createBtn.querySelector('.btn__label').textContent = clean ? 'Create a new room instead' : 'Create room';
    this.joinBtn.classList.toggle('btn--primary', !!clean);
    this.joinBtn.classList.toggle('btn--block', !!clean);
    this._updateJoinLabel();
    this.divider.firstChild.textContent = clean ? 'or' : 'or join with a code';
    this._renderCells();
    if (clean) {
      this.nameInput.focus({ preventScroll: true });
    }
  }

  /** @param {{code:string, name:string}|null} info */
  setRejoin(info) {
    this.rejoin = info;
    this.rejoinEl.hidden = !info;
    this.card.classList.toggle('has-rejoin', !!info);
    if (!info) return;
    this._rejoinLabel();
    this.rejoinCode.textContent = `Room ${info.code}`;
  }

  setBusy(busy, label) {
    this.busy = !!busy;
    this.card.classList.toggle('is-busy', this.busy);
    for (const b of [this.createBtn, this.joinBtn, this.practiceBtn, this.fameBtn, this.rejoinBtn]) b.disabled = this.busy;
    this.nameInput.readOnly = this.busy;
    this.codeInput.readOnly = this.busy;
    for (const b of [this.createBtn, this.joinBtn, this.practiceBtn, this.rejoinBtn]) {
      b.classList.remove('is-loading');
      if (b.__label !== undefined) {
        const l = b.querySelector('.btn__label') || b;
        l.textContent = b.__label;
        delete b.__label;
      }
    }
    if (this.busy) {
      const target = this.lastAction || this.createBtn;
      const l = target.querySelector('.btn__label') || target;
      target.__label = l.textContent;
      target.classList.add('is-loading');
      if (label) l.textContent = label;
    } else {
      this._updateJoinLabel();
    }
  }

  onShow() {
    // Avoid popping the on-screen keyboard on touch devices.
    if (matchMedia('(pointer: fine)').matches && !this.nameInput.value && this.rejoinEl.hidden) this.nameInput.focus({ preventScroll: true });
  }

  /* ---------------- internals ---------------- */

  _profile() {
    return { name: cleanName(this.nameInput.value).trim(), colorIndex: this.profile.colorIndex };
  }

  _rejoinLabel() {
    if (!this.rejoin || this.busy) return;
    const name = cleanName(this.nameInput.value).trim() || this.rejoin.name;
    this.rejoinBtn.querySelector('.btn__label').textContent = `Rejoin as ${name}`;
  }

  _onNameInput() {
    this._rejoinLabel();
    this.nameHint.textContent = '';
    this.nameInput.removeAttribute('aria-invalid');
    this.profile = this._profile();
    this.handlers.onProfileChange?.(this._profile());
  }

  _pickColor(i, emit) {
    const idx = ((i % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length;
    this.profile.colorIndex = idx;
    this.swatches.forEach((s, j) => {
      s.setAttribute('aria-checked', String(j === idx));
      s.tabIndex = j === idx ? 0 : -1;
    });
    this.preview.style.setProperty('--scarf', PLAYER_COLORS[idx]);
    if (emit) {
      replay(this.preview, 'is-flutter');
      this.handlers.onProfileChange?.(this._profile());
    }
  }

  _swatchKeys(e) {
    const cols = 6;
    const delta = { ArrowRight: 1, ArrowDown: cols, ArrowLeft: -1, ArrowUp: -cols }[e.key];
    if (!delta) return;
    e.preventDefault();
    this._pickColor(this.profile.colorIndex + delta, true);
    this.swatches[this.profile.colorIndex].focus();
  }

  _validName() {
    const name = cleanName(this.nameInput.value).trim();
    if (this.nameInput.value !== name && document.activeElement !== this.nameInput) this.nameInput.value = name;
    if (name.length >= 1 && /[\p{L}\p{N}]/u.test(name)) return true;
    this.nameHint.textContent = name.length ? 'Use at least one letter or number' : 'Pick a name first';
    this.nameInput.setAttribute('aria-invalid', 'true');
    replay(this.nameInput.parentElement, 'shake');
    this.nameInput.focus({ preventScroll: true });
    return false;
  }

  _create() {
    if (this.busy || !this._validName()) return;
    this.lastAction = this.createBtn;
    this.handlers.onCreate?.(this._profile());
  }

  _join() {
    if (this.busy) return;
    const code = sanitize(this.codeInput.value);
    if (code.length !== CODE_LEN) {
      replay(this.codeBox, 'shake');
      this.codeInput.focus({ preventScroll: true });
      return;
    }
    if (!this._validName()) return;
    this.lastAction = this.joinBtn;
    this.handlers.onJoin?.(code, this._profile());
  }

  _rejoin() {
    if (this.busy || !this._validName()) return;
    this.lastAction = this.rejoinBtn;
    this.handlers.onRejoin?.();
  }

  _practice() {
    if (this.busy || !this._validName()) return;
    this.lastAction = this.practiceBtn;
    this.handlers.onPractice?.(this._profile());
  }

  _onCodeInput() {
    const clean = sanitize(this.codeInput.value);
    if (this.codeInput.value !== clean) this.codeInput.value = clean;
    if (this.inviteCode) this.inviteCode = clean || this.inviteCode;
    this._updateJoinLabel();
    this._renderCells();
  }

  _updateJoinLabel() {
    if (this.busy) return;
    const code = sanitize(this.codeInput.value);
    this.joinLabel.textContent = this.el.classList.contains('home--invite') ? (code.length === CODE_LEN ? `Join room ${code}` : 'Join room') : 'Join';
  }

  _renderCells() {
    const v = this.codeInput.value;
    const focused = document.activeElement === this.codeInput;
    const caret = Math.min(v.length, CODE_LEN - 1);
    this.cells.forEach((cell, i) => {
      cell.textContent = v[i] || '';
      cell.classList.toggle('is-filled', !!v[i]);
      cell.classList.toggle('is-caret', focused && i === caret);
    });
    this.codeBox.classList.toggle('is-complete', v.length === CODE_LEN);
  }
}

/** No control / zero-width characters, single spaces, at most NAME_MAX characters (not UTF-16 units). */
function cleanName(raw) {
  const s = String(raw || '')
    .normalize('NFC')
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^\s+/, '');
  return [...s].slice(0, NAME_MAX).join('');
}

/** Uppercase, strip anything that is not A–Z / 0–9, keep the first 5. Tolerates pasted URLs ("…?room=ABCDE"). */
export function sanitize(raw) {
  let s = String(raw || '');
  const m = s.match(/[?&]room=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LEN);
}
