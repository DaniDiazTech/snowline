/**
 * Snowline UI — every DOM screen and the race HUD, as pure views.
 *
 * The UI never runs game logic or networking: Game feeds it state through the
 * setters below and receives user intent through the handler callbacks.
 *
 *   const ui = new UI(document.getElementById('ui'), {
 *     onCreate(profile), onJoin(code, profile), onPractice(profile), onProfileChange(profile),
 *     onOpenFame(), onSettings(partialSettings), onStart(), onLeave(), onCopyLink(),
 *     onPlayAgain(), onBackToLobby(), onToggleMute(), onInput(held)
 *   });
 *
 * Additive extras beyond the agreed API: setTone(), setTrickAnchor(), openFame(), closeFame(), destroy().
 */
import { h, icon } from './dom.js';
import { ICONS } from './icons.js';
import { HomeView } from './HomeView.js';
import { LobbyView } from './LobbyView.js';
import { HudView } from './HudView.js';
import { ResultsView } from './ResultsView.js';
import { FameModal } from './FameModal.js';
import { InputSurface } from './InputSurface.js';

const SCREENS = ['home', 'lobby', 'race', 'results'];
const LEAVE_MS = 420;

export class UI {
  /**
   * @param {HTMLElement} root
   * @param {Object} handlers  see file header; every handler is optional
   */
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    this.screen = 'none';
    root.classList.add('ui');

    // Views get a proxy that always calls the *current* handler + UI-internal actions.
    const self = this;
    const hooks = new Proxy(
      {},
      {
        get(_, key) {
          if (key === 'openFame') return () => self.openFame();
          return self.handlers[key];
        },
      }
    );

    this.home = new HomeView(hooks);
    this.lobby = new LobbyView(hooks);
    this.hud = new HudView();
    this.results = new ResultsView(hooks);
    this.fame = new FameModal(hooks);
    this.views = { home: this.home, lobby: this.lobby, race: this.hud, results: this.results };

    // Corner chrome: connection + mute (always available).
    this.connEl = h('span', { class: 'conn', 'data-testid': 'connection', 'data-status': 'online', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'conn__dot' }), h('span', { class: 'conn__label' }));
    this.muteBtn = h(
      'button',
      { class: 'icon-btn icon-btn--glass', type: 'button', 'aria-label': 'Mute sound', 'aria-pressed': 'false', title: 'Sound (M)', 'data-testid': 'mute', onclick: () => this.handlers.onToggleMute?.() },
      h('span', { class: 'swap' }, icon(ICONS.soundOn, 'icon swap__a'), icon(ICONS.soundOff, 'icon swap__b'))
    );
    const chrome = h('div', { class: 'chrome' }, this.connEl, this.muteBtn);

    this.toasts = h('div', { class: 'toasts', 'aria-live': 'assertive' });

    root.append(this.home.el, this.lobby.el, this.hud.el, this.results.el, chrome, this.fame.el, this.toasts);

    this.input = new InputSurface((held) => this.handlers.onInput?.(held));
    this._keys = (e) => {
      if (e.code !== 'KeyM' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
      this.handlers.onToggleMute?.();
    };
    window.addEventListener('keydown', this._keys);
  }

  /* ================= screens ================= */

  /** @param {'home'|'lobby'|'race'|'results'|'none'} screen */
  show(screen) {
    if (screen === this.screen) return;
    const prev = this.screen;
    this.screen = screen;
    document.documentElement.dataset.screen = screen;

    for (const name of SCREENS) {
      const el = this.views[name].el;
      if (name === screen) {
        clearTimeout(el.__leave);
        el.classList.remove('is-leaving');
        el.hidden = false;
        void el.offsetWidth; // let the entering transition run
        el.classList.add('is-active');
      } else if (!el.hidden) {
        el.classList.remove('is-active');
        el.classList.add('is-leaving');
        clearTimeout(el.__leave);
        el.__leave = setTimeout(() => {
          el.hidden = true;
          el.classList.remove('is-leaving');
        }, LEAVE_MS);
      }
    }

    if (screen === 'race') {
      if (prev !== 'race') this.hud.reset();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // Space must not "click" a focused button
      this.fame.close();
      this.input.enable();
    } else {
      this.input.disable();
    }
    if (screen === 'home') this.home.onShow();
    if (screen === 'lobby' || screen === 'results') this.views[screen].el.scrollTop = 0;
  }

  /** Clears every per-race HUD state (finish overlay, combo, toasts). Call when a new race begins. */
  resetRace() {
    this.hud.reset();
  }

  /* ================= home ================= */

  setProfile(profile) {
    this.home.setProfile(profile);
  }

  setJoinCode(code) {
    this.home.setJoinCode(code);
  }

  setBusy(busy, label) {
    this.home.setBusy(busy, label);
  }

  showError(message) {
    const toast = h('div', { class: 'toast toast--error', role: 'alert', 'data-testid': 'error-toast' }, h('span', { class: 'toast__dot' }), h('span', {}, String(message)));
    const dismiss = () => {
      toast.classList.add('is-out');
      setTimeout(() => toast.remove(), 300);
    };
    toast.addEventListener('click', dismiss);
    while (this.toasts.children.length >= 3) this.toasts.firstElementChild.remove();
    this.toasts.append(toast);
    setTimeout(dismiss, 4500);
  }

  /** @param {'connecting'|'online'|'offline'} status */
  setConnection(status) {
    const el = this.connEl;
    if (el.dataset.status === status) return;
    el.dataset.status = status;
    el.querySelector('.conn__label').textContent = { connecting: 'Connecting…', online: 'Online', offline: 'Offline' }[status] || '';
    el.classList.add('is-expanded');
    clearTimeout(this._connTimer);
    if (status === 'online') this._connTimer = setTimeout(() => el.classList.remove('is-expanded'), 2200);
  }

  /* ================= lobby ================= */

  setLobby(view) {
    this.lobby.setLobby(view);
  }

  /* ================= race ================= */

  setCountdown(value) {
    this.hud.setCountdown(value);
  }

  updateHud(hud) {
    this.hud.update(hud);
  }

  trickToast(label, points) {
    this.hud.trickToast(label, points);
  }

  /** Additive: anchor trick toasts above the local rider (screen px). Cheap enough to call per frame. */
  setTrickAnchor(x, y) {
    this.hud.setTrickAnchor(x, y);
  }

  comboBanked(total, mult, boostLevel) {
    this.hud.comboBanked(total, mult, boostLevel);
  }

  announce(text, tone = 'info') {
    this.hud.announce(text, tone);
  }

  setFinished(place, timeMs) {
    this.hud.setFinished(place, timeMs);
  }

  /* ================= results / fame ================= */

  setResults(view) {
    this.results.setResults(view);
  }

  /** @param {Array|null} records  null = loading */
  setHallOfFame(records) {
    this.fame.setRecords(records);
  }

  /** Opens the hall-of-fame dialog and asks Game for data (onOpenFame). */
  openFame() {
    if (this.screen === 'race') return;
    this.fame.show();
    this.handlers.onOpenFame?.();
  }

  closeFame() {
    this.fame.close();
  }

  setMuted(muted) {
    this.muteBtn.setAttribute('aria-pressed', String(!!muted));
    this.muteBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    this.muteBtn.classList.toggle('is-muted', !!muted);
  }

  /**
   * Additive: adapts glass + ink to the scene behind the UI.
   * @param {'day'|'night'|number} tone  a number is Atmosphere.night (0..1)
   */
  setTone(tone) {
    const t = typeof tone === 'number' ? (tone > 0.5 ? 'night' : 'day') : tone === 'night' ? 'night' : 'day';
    if (document.documentElement.dataset.tone !== t) document.documentElement.dataset.tone = t;
  }

  destroy() {
    this.input.destroy();
    window.removeEventListener('keydown', this._keys);
    this.root.replaceChildren();
  }
}
