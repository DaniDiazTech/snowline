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
 *
 * Additive (ready-for-players pass):
 *   setPrefs({quality, volume, reduceFx, muted, qualityApi})   settings dialog state (also sets
 *                                   <html data-reduce-fx> for calmer CSS)
 *   openSettings() / closeSettings()                            the gear dialog (also from the corner gear)
 *   showOnboarding({waiting, onDone}) / closeOnboarding()       first-run how-to
 *   confirm({title, body, ok, cancel}) → Promise<boolean>       yes/no dialog
 *   notify(text, tone='info'|'good'|'bad')                     non-error toast (menus)
 *   setRejoin({code, name} | null)                              home: one-tap "Rejoin as <name>"
 *   setFps(text | null)                                         debug corner (?fps=1)
 *   setRiderColor(colorIndex)                                   HUD scarf ribbon colour
 *   crashLabel(text)                                            short crash reason next to the rider
 *   setClosing(msLeft | null)                                   "Race closes in 0:24" chip
 *   setWatching({name, place} | null)                           spectating chip; shrinks the finish card
 *   updateHud(hud) also takes {gaps: {ahead, behind}, tailwind}
 *   setResults(view) also takes {awards, journey, practice, hostName}
 *   setLobby(view) also takes {takenColors}
 *   handlers: onChangeSettings(), onRemovePlayer(id, name)
 *   setLobby(view) also takes {inProgress, live: [{id,name,color,progress,finished}]}
 *   handlers: onPrefs(partial), onQualityInfo() → info|null, onModal(open), onRejoin(), onReplayTutorial(),
 *             onInput(held, t)  — t is the input event's timeStamp (performance.now() timebase)
 */
import { PLAYER_COLORS } from '../contracts.js';
import { h, icon } from './dom.js';
import { ICONS } from './icons.js';
import { HomeView } from './HomeView.js';
import { LobbyView } from './LobbyView.js';
import { HudView } from './HudView.js';
import { ResultsView } from './ResultsView.js';
import { FameModal } from './FameModal.js';
import { InputSurface } from './InputSurface.js';
import { SettingsModal } from './SettingsModal.js';
import { Onboarding } from './Onboarding.js';
import { ConfirmModal } from './ConfirmModal.js';

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

    // Dialogs. Game is told when any is open (it freezes the backdrop scene behind them).
    this._open = new Set();
    const track = (name) => (open) => {
      if (open) this._open.add(name);
      else this._open.delete(name);
      document.documentElement.toggleAttribute('data-modal', this._open.size > 0);
      this.handlers.onModal?.(this._open.size > 0);
    };
    this.fame.onToggle = track('fame');
    this.settings = new SettingsModal(hooks, track('settings'));
    this.onboarding = new Onboarding(track('onboarding'));
    this.confirmer = new ConfirmModal(track('confirm'));

    // Corner chrome: connection + mute (always available).
    this.connEl = h('span', { class: 'conn', 'data-testid': 'connection', 'data-status': 'online', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'conn__dot' }), h('span', { class: 'conn__label' }));
    this.muteBtn = h(
      'button',
      { class: 'icon-btn icon-btn--glass', type: 'button', 'aria-label': 'Mute sound', 'aria-pressed': 'false', title: 'Sound (M)', 'data-testid': 'mute', onclick: () => this.handlers.onToggleMute?.() },
      h('span', { class: 'swap' }, icon(ICONS.soundOn, 'icon swap__a'), icon(ICONS.soundOff, 'icon swap__b'))
    );
    this.gearBtn = h(
      'button',
      { class: 'icon-btn icon-btn--glass', type: 'button', 'aria-label': 'Settings', title: 'Settings', 'aria-haspopup': 'dialog', 'data-testid': 'open-settings', onclick: () => this.openSettings() },
      icon(ICONS.gear)
    );
    // Fullscreen: touch devices only (desktop has F11), where the API exists (not iPhone Safari).
    const fsTarget = document.documentElement;
    const canFs = !!(fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen) && (document.fullscreenEnabled || document.webkitFullscreenEnabled) && matchMedia('(pointer: coarse)').matches;
    this.fsBtn = canFs
      ? h(
          'button',
          { class: 'icon-btn icon-btn--glass', type: 'button', 'aria-label': 'Full screen', title: 'Full screen', 'aria-pressed': 'false', 'data-testid': 'fullscreen', onclick: () => this._toggleFullscreen() },
          h('span', { class: 'swap' }, icon(ICONS.expand, 'icon swap__a'), icon(ICONS.shrink, 'icon swap__b'))
        )
      : null;
    if (canFs) {
      const sync = () => {
        const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
        this.fsBtn.setAttribute('aria-pressed', String(on));
        this.fsBtn.classList.toggle('is-done', on);
      };
      document.addEventListener('fullscreenchange', sync);
      document.addEventListener('webkitfullscreenchange', sync);
    }
    const chrome = h('div', { class: 'chrome' }, this.connEl, this.fsBtn, this.gearBtn, this.muteBtn);

    this.toasts = h('div', { class: 'toasts', 'aria-live': 'assertive' });
    this.fpsEl = h('div', { class: 'fps-corner', 'data-testid': 'fps', 'aria-hidden': 'true', hidden: true });
    this.rotateEl = h('div', { class: 'rotate-hint', 'data-testid': 'rotate-hint', role: 'note' }, icon(ICONS.rotate, 'icon'), h('span', {}, 'Turn your phone sideways. Snowline plays best that way.'));

    root.append(this.home.el, this.lobby.el, this.hud.el, this.results.el, chrome, this.rotateEl, this.fame.el, this.settings.el, this.onboarding.el, this.confirmer.el, this.toasts, this.fpsEl);

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
      this.confirmer.modal.open && this.confirmer._answer(false);
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
    if (Number.isInteger(profile?.colorIndex)) this.setRiderColor(profile.colorIndex);
  }

  /** Additive: the HUD's scarf ribbon wears the local rider's colour. */
  setRiderColor(colorIndex) {
    this.hud.el.style.setProperty('--scarf', PLAYER_COLORS[colorIndex] ?? PLAYER_COLORS[0]);
  }

  setJoinCode(code) {
    this.home.setJoinCode(code);
  }

  setBusy(busy, label) {
    this.home.setBusy(busy, label);
  }

  /** Additive: home shows a one-tap "Rejoin as <name>" (null hides it). */
  setRejoin(info) {
    this.home.setRejoin(info);
  }

  showError(message) {
    this._toast(message, 'error');
  }

  /** Additive: a non-error toast (host changes, reconnects…). */
  notify(message, tone = 'info') {
    this._toast(message, tone === 'bad' ? 'warn' : tone);
  }

  _toast(message, kind) {
    const error = kind === 'error';
    const toast = h(
      'div',
      { class: `toast toast--${kind}`, role: error ? 'alert' : 'status', 'data-testid': error ? 'error-toast' : 'notice-toast' },
      h('span', { class: 'toast__dot' }),
      h('span', {}, String(message))
    );
    const dismiss = () => {
      toast.classList.add('is-out');
      setTimeout(() => toast.remove(), 300);
    };
    toast.addEventListener('click', dismiss);
    while (this.toasts.children.length >= 3) this.toasts.firstElementChild.remove();
    this.toasts.append(toast);
    setTimeout(dismiss, error ? Math.max(4500, String(message).length * 70) : 3200);
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

  crashLabel(text) {
    this.hud.crashLabel(text);
  }

  setClosing(msLeft) {
    this.hud.setClosing(msLeft);
  }

  setWatching(info) {
    this.hud.setWatching(info);
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
    this.settings.close();
    this.fame.show();
    this.handlers.onOpenFame?.();
  }

  closeFame() {
    this.fame.close();
  }

  /* ================= settings / onboarding / dialogs (additive) ================= */

  setPrefs(prefs) {
    this.settings.setPrefs(prefs);
  }

  openSettings() {
    this.fame.close();
    this.settings.show();
  }

  closeSettings() {
    this.settings.close();
  }

  showOnboarding(opts) {
    this.onboarding.show(opts);
  }

  closeOnboarding() {
    this.onboarding.close();
  }

  /** @returns {Promise<boolean>} */
  confirm(opts) {
    return this.confirmer.ask(opts);
  }

  /** Debug corner (?fps=1). null hides it. */
  setFps(text) {
    const el = this.fpsEl;
    if (text === null || text === undefined) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (el.textContent !== text) el.textContent = text;
  }

  _toggleFullscreen() {
    const doc = document;
    const el = doc.documentElement;
    try {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      else {
        const p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
        // The game is landscape: lock it there when the browser allows (Android Chrome, in fullscreen).
        Promise.resolve(p)
          .then(() => screen.orientation?.lock?.('landscape'))
          .catch(() => {});
      }
    } catch {
      /* not allowed */
    }
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
