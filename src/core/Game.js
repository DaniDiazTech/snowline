/**
 * Game — the application state machine. Wires UI ⇄ Room ⇄ Race ⇄ Renderer ⇄ Audio.
 *
 *   home ──create/join──▶ lobby ──start──▶ countdown ▶ racing ▶ results ──▶ lobby
 *     └──────practice (no room)────────────────▲
 *
 * While no race is on screen, a bot rides an endless "backdrop" course behind the UI (no bots,
 * ~30 fps when the renderer allows it, frozen while a dialog covers it).
 *
 * Also owns the player's preferences (graphics quality, volume, reduced effects), the first-run
 * how-to and contextual hints, rejoin-after-refresh, the leave/unload guards and the screen wake lock.
 */
import { COUNTDOWN_MS, DEFAULT_SETTINGS, FeatureType, NET_SEND_HZ, PLAYER_COLORS, PX_PER_M, Phase, RiderMode, SimEvent, TICK_MS } from '../contracts.js';
import { randomSeed } from '../math/random.js';
import { generateCourse } from '../world/Course.js';
import { Room } from '../net/Room.js';
import { WinnersStore, winnersStore } from '../store/WinnersStore.js';
import { Race } from './Race.js';

const PROFILE_KEY = 'snowline.profile';
const MUTE_KEY = 'snowline.muted';
const PREFS_KEY = 'snowline.prefs';
const ONBOARD_KEY = 'snowline.onboarded';
const HINTS_KEY = 'snowline.hints';
/** sessionStorage (per tab, survives a refresh): the room this tab is in and its player id, for rejoin. */
const SESSION_KEY = 'snowline.session';
const QUALITIES = ['auto', 'low', 'medium', 'high'];
/** Contextual hints run during this many first races. */
const HINT_RACES = 2;
const HINT_GAP_MS = 3500;
/** Backdrop frame interval when it may be throttled (≈ 30 fps). */
const BACKDROP_FRAME_MS = 1000 / 30 - 2;
const NET_SEND_MS = 1000 / NET_SEND_HZ;
/** Practice runs end this long after the player finishes, even if bots are still out. */
const PRACTICE_GRACE_MS = 8000;
const PRACTICE_SETTINGS = Object.freeze({ ...DEFAULT_SETTINGS, bots: 3 });
const NAME_MAX = 14;
/** Display names: no control / zero-width characters, single spaces, at most 14 characters. */
const cleanName = (raw) =>
  [...String(raw ?? '').normalize('NFC').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').replace(/^\s+/, '')].slice(0, NAME_MAX).join('');
const ORDINALS = ['1st', '2nd', '3rd'];
const ordinal = (n) => ORDINALS[n - 1] ?? `${n}th`;

/** Position changes must hold this long before a callout, and callouts are at least this far apart. */
const CALLOUT_HOLD_MS = 800;
const CALLOUT_GAP_MS = 3000;
const PHOTO_FINISH_MS = 500;
/** After the local finish, the camera switches to a rider still racing after this long. */
const SPECTATE_AFTER_MS = 2000;
const CRASH_REASONS = {
  rock: 'Rock. Jump earlier',
  log: 'Log. Jump earlier',
  snowman: 'Snowman. Jump earlier',
  spikes: 'Ice spikes. Jump earlier',
  campfire: 'Campfire. Jump earlier',
  landing: 'Landed tilted. Let go sooner',
};
const JOIN_ERRORS = {
  'not-found': 'Room not found. Check the code with the host.',
  full: 'That room is full. It takes 12 riders.',
  offline: "This network blocks the game server. School and office Wi-Fi often do. Try mobile data.",
  removed: 'The host removed you from this room. You can try again in a minute.',
};
const CREATE_ERRORS = {
  offline: "This network blocks the game servers. Try mobile data, or practice solo.",
};

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: nothing to do */
  }
}

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY)) ?? null;
  } catch {
    return null;
  }
}

function writeSession(value) {
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

const systemReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Player preferences, validated. */
function sanitizePrefs(raw = {}) {
  return {
    quality: QUALITIES.includes(raw.quality) ? raw.quality : 'auto',
    volume: Number.isFinite(raw.volume) ? Math.max(0, Math.min(1, raw.volume)) : 1,
    reduceFx: typeof raw.reduceFx === 'boolean' ? raw.reduceFx : systemReducedMotion(),
  };
}

export class Game {
  /**
   * @param {Object} deps
   * @param {import('../render/Renderer.js').Renderer} deps.renderer
   * @param {import('../ui/UI.js').UI} deps.ui   created by main.js with `game.handlers`
   * @param {import('../audio/AudioEngine.js').AudioEngine} deps.audio
   * @param {URLSearchParams} deps.params
   */
  constructor({ renderer, audio, params }) {
    this.renderer = renderer;
    this.audio = audio;
    this.ui = null;
    this.params = params;
    this.netOpts = params.get('net') === 'local' ? { net: 'local' } : {};
    this.autopilot = params.has('auto') ? Number(params.get('auto')) || 0.8 : false;
    // Test and offline sessions must never write to the real hall of fame.
    this.store = this.netOpts.net || this.autopilot ? new WinnersStore({ key: 'snowline-hof-dev-4pXw' }) : winnersStore;

    this.profile = { name: '', colorIndex: Math.floor(Math.random() * PLAYER_COLORS.length), ...readJson(PROFILE_KEY, {}) };
    this.muted = !!readJson(MUTE_KEY, false);
    this.prefs = sanitizePrefs(readJson(PREFS_KEY, {}));
    /** Test / offline-tab sessions skip the first-run how-to unless ?tutorial=1 asks for it. */
    this.tutorial = params.has('tutorial') ? params.get('tutorial') !== '0' : !this.netOpts.net && !this.autopilot;
    this.hints = { races: 0, ...readJson(HINTS_KEY, {}) };
    this.hintState = null;
    /** a dialog (settings, hall of fame, how-to, confirm) covers the scene */
    this.modalOpen = false;
    this.backdropPausedAt = 0;
    this.lastBackdropDraw = 0;
    this.wakeLock = null;
    this.fps = { ema: 16.7, shownAt: 0, on: params.has('fps') && params.get('fps') !== '0' };
    this.spectate = null;
    this.phase = Phase.HOME;
    /** @type {Room|null} */
    this.room = null;
    this.roomOff = [];
    /** @type {Race|null} the race on screen (multiplayer or practice) */
    this.race = null;
    this.practice = false;
    this.practiceEndAt = 0;
    this.lastResults = null;
    this.saved = 'pending';
    this.countdownShown = null;
    this.lastSendMs = 0;
    this.finalStretch = false;
    this.lastSketchyMs = -1e9;
    this.lastTone = -1;
    /** backdrop: a bot riding behind the menus */
    this.backdrop = null;
    this.backdropClock = 0;

    this.handlers = {
      onCreate: (profile) => this.createRoom(profile),
      onJoin: (code, profile) => this.joinRoom(code, profile),
      onPractice: (profile) => this.startPractice(profile),
      onProfileChange: (profile) => this.setProfile(profile),
      onOpenFame: () => this.openFame(),
      onSettings: (partial) => this.room?.setSettings(partial),
      onStart: () => {
        this.audio.ui('click');
        this.room?.startRace();
      },
      onLeave: () => this.confirmLeave(),
      onCopyLink: () => this.audio.ui('click'),
      // Rematch: the host starts the next race straight from the results (everyone gets one 'start').
      onPlayAgain: () => {
        if (this.practice) return this.startPractice(this.profile);
        this.audio.ui('click');
        this.room?.startRace();
      },
      onChangeSettings: () => this.room?.backToLobby(),
      onRemovePlayer: (id, name) => this.removePlayer(id, name),
      onBackToLobby: () => this.showLobby(),
      onToggleMute: () => this.setMuted(!this.muted),
      onInput: (held, t) => {
        this.audio.unlock();
        // finished and watching: a press switches to the next rider still racing
        if (held && this.watching) this.cycleFocus();
        this.race?.setInput(held, t);
      },
      // additive
      onPrefs: (partial) => this.setPrefs(partial),
      onQualityInfo: () => this.qualityInfo(),
      onModal: (open) => this.setModalOpen(open),
      onRejoin: () => this.rejoin(),
      onReplayTutorial: () => {
        writeJson(ONBOARD_KEY, false);
        this.hints = { races: 0 };
        writeJson(HINTS_KEY, this.hints);
        this.tutorial = true;
      },
    };
  }

  /** Called once by main.js after the UI exists. */
  start(ui) {
    this.ui = ui;
    ui.setProfile(this.profile);
    ui.setMuted(this.muted);
    this.audio.setMuted(this.muted);
    this.applyPrefs();
    const code = this.params.get('room');
    if (code) {
      ui.setJoinCode(code);
      // Back after a refresh of this tab (it was in that room) with a known name: one-tap rejoin.
      // A fresh invite link already has a one-tap "Join room CODE" with the stored name filled in.
      const prev = readSession();
      if (this.profile.name.trim() && prev && String(prev.code).toUpperCase() === code.toUpperCase()) ui.setRejoin?.({ code: code.toUpperCase(), name: this.profile.name.trim() });
    }
    this.newBackdrop();
    this.goHome();
    if (this.fps.on) ui.setFps?.('…');
    this.installPageGuards();
    // Browsers only allow sound after a gesture.
    const unlock = () => {
      this.audio.unlock();
      if (!this.race) this.audio.startMusic('menu');
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  /* ------------------------------ profile / misc ------------------------------ */

  setProfile(profile) {
    this.profile = { name: cleanName(profile.name), colorIndex: profile.colorIndex | 0 };
    writeJson(PROFILE_KEY, this.profile);
    this.room?.setProfile(this.profile);
  }

  namedProfile(profile) {
    this.setProfile(profile ?? this.profile);
    const name = this.profile.name.trim() || `Rider ${Math.floor(Math.random() * 90 + 10)}`;
    return { name, colorIndex: this.profile.colorIndex };
  }

  setMuted(muted) {
    this.muted = muted;
    writeJson(MUTE_KEY, muted);
    this.audio.unlock();
    this.audio.setMuted(muted);
    this.ui.setMuted(muted);
    this.ui.setPrefs?.({ ...this.prefs, muted: this.muted });
  }

  /* ------------------------------- preferences ------------------------------- */

  setPrefs(partial = {}) {
    if ('muted' in partial) this.setMuted(!!partial.muted);
    this.prefs = sanitizePrefs({ ...this.prefs, ...partial });
    writeJson(PREFS_KEY, this.prefs);
    this.applyPrefs();
  }

  applyPrefs() {
    const p = this.prefs;
    // Feature-detected: the renderer's quality API may not exist in every build.
    if (typeof this.renderer.setQuality === 'function') this.renderer.setQuality(p.quality);
    if (typeof this.renderer.setReducedEffects === 'function') this.renderer.setReducedEffects(p.reduceFx);
    this.audio.setVolume?.(p.volume);
    this.ui?.setPrefs?.({ ...p, muted: this.muted, qualityApi: typeof this.renderer.setQuality === 'function' });
  }

  /** Live renderer quality for the settings panel (null when the renderer has no governor). */
  qualityInfo() {
    const q = this.renderer.quality;
    if (!q) return null;
    return { mode: q.mode, name: q.name, pixelDensity: q.pixelDensity, fps: Math.round(1000 / this.fps.ema) };
  }

  setModalOpen(open) {
    this.modalOpen = !!open;
  }

  async openFame() {
    this.ui.setHallOfFame(null);
    this.ui.setHallOfFame(await this.store.list(50));
  }

  /* ---------------------------------- rooms ---------------------------------- */

  async createRoom(profile) {
    if (this.room || this.joining) return;
    this.audio.unlock();
    this.audio.ui('click');
    if (!this.online()) return this.ui.showError("You're offline. You can still practice solo.");
    this.joining = true;
    this.ui.setBusy(true, 'Creating room…');
    try {
      this.attachRoom(await Room.create(this.namedProfile(profile), this.netOpts));
    } catch (err) {
      this.ui.showError(CREATE_ERRORS[err?.message] ?? "Couldn't create a room. Try again.");
    } finally {
      this.joining = false;
      this.ui.setBusy(false);
    }
  }

  async joinRoom(code, profile) {
    if (this.room || this.joining) return;
    this.audio.unlock();
    this.audio.ui('click');
    if (!this.online()) return this.ui.showError("You're offline. Connect to the internet to join.");
    this.joining = true;
    this.ui.setBusy(true, 'Joining…');
    // Same tab, same room (a refresh): keep the player id so the host sees a rejoin, not a stranger.
    const prev = readSession();
    const selfId = prev && String(prev.code).toUpperCase() === String(code).toUpperCase() ? prev.selfId : undefined;
    try {
      this.attachRoom(await Room.join(code, this.namedProfile(profile), selfId ? { ...this.netOpts, selfId } : this.netOpts));
    } catch (err) {
      this.ui.showError(JOIN_ERRORS[err?.message] ?? "Couldn't join. Try again.");
    } finally {
      this.joining = false;
      this.ui.setBusy(false);
    }
  }

  /** One-tap rejoin offered on the home screen after a refresh. */
  rejoin() {
    const code = this.params.get('room');
    if (code) this.joinRoom(code, this.profile);
  }

  online() {
    return this.netOpts.net === 'local' || typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  attachRoom(room) {
    this.room = room;
    this.practice = false;
    this.knownIds = new Set(room.players.map((p) => p.id));
    const on = (event, cb) => this.roomOff.push(room.on(event, cb));
    on('players', (players) => this.onPlayers(players));
    on('settings', () => this.refreshLobby());
    on('start', (info) => this.beginRace(info));
    on('state', ({ id, net, recvMs }) => {
      if (this.race) this.race.pushRemoteState(id, net, recvMs);
      else if (this.spectate && Array.isArray(net) && Number.isFinite(net[1])) this.spectate.xs.set(id, net[1]);
    });
    on('finish', (report) => {
      if (!this.race && this.spectate && report.timeMs >= 0) this.spectate.finished.set(report.id, report.timeMs);
      this.onRemoteFinish(report);
    });
    on('results', (results) => this.showResults(results));
    on('phase', (phase) => this.onRoomPhase(phase));
    on('status', (status) => this.onStatus(status));
    on('closed', ({ reason }) => this.onRoomClosed(reason));
    room.setDnfProvider(() => (this.race && !this.practice && room.race?.raceId === this.raceId ? this.race.botDnfReports() : []));
    this.ui.setConnection(room.status ?? 'online');
    this.hostId = room.players.find((p) => p.isHost)?.id ?? null;
    this.connStatus = room.status ?? 'online';
    writeSession({ code: room.code, selfId: room.selfId });
    this.followAssignedColor(room.players);
    this.ui.setRejoin?.(null);
    this.audio.ui('join');
    // Keep the invite in the address bar so the host can also just copy the URL.
    this.setUrlRoom(room.code);
    this.showLobby();
  }

  /** @param {boolean} [unloading]  the page is going away (refresh): keep ?room= and the rejoin record */
  detachRoom(unloading = false) {
    for (const off of this.roomOff) off();
    this.roomOff = [];
    this.room = null;
    this.spectate = null;
    if (unloading) return;
    this.setUrlRoom(null);
    writeSession(null);
    this.ui.setRejoin?.(null);
  }

  /** Puts ?room=CODE in the address bar (or removes it) without touching the other parameters. */
  setUrlRoom(code) {
    try {
      const url = new URL(location.href);
      if (code) url.searchParams.set('room', code);
      else url.searchParams.delete('room');
      history.replaceState(null, '', url);
    } catch {
      /* file:// etc. */
    }
  }

  /** The invite link. Offline (loopback) rooms only exist on the loopback transport. */
  shareUrl() {
    return this.room.shareUrl + (this.netOpts.net ? '&net=local' : '');
  }

  /** Leave, but ask the host first when others are in the room (it hands the room to someone else). */
  async confirmLeave() {
    const room = this.room;
    const others = room ? room.players.filter((p) => p.id !== room.selfId && p.connected).length : 0;
    const racing = room && this.race && !this.practice && (this.phase === Phase.RACING || this.phase === Phase.COUNTDOWN);
    if (room && (racing || (room.isHost && others > 0 && this.phase === Phase.LOBBY)) && this.ui.confirm) {
      const ok = await this.ui.confirm(
        racing
          ? { title: 'Leave the race?', body: "You'll drop out of this race and the room.", ok: 'Leave', cancel: 'Keep racing' }
          : { title: 'Leave the room?', body: `You're the host. ${others === 1 ? 'The other rider stays' : `The other ${others} riders stay`} and the next one in the list takes over.`, ok: 'Leave', cancel: 'Stay' }
      );
      if (!ok || this.room !== room) return;
    }
    this.leave();
  }

  /** Host tool: remove a rider from the lobby (asks first). */
  async removePlayer(id, name) {
    const room = this.room;
    if (!room?.isHost) return;
    const ok = await this.ui.confirm({ title: `Remove ${name || 'this rider'}?`, body: "They go back to the home screen and can't rejoin for a minute.", ok: 'Remove', cancel: 'Keep' });
    if (ok && this.room === room) room.removePlayer(id);
  }

  leave() {
    this.audio.ui('leave');
    const room = this.room;
    if (room) {
      this.detachRoom();
      room.leave();
    }
    this.goHome();
  }

  onRoomClosed(reason) {
    if (!this.room) return;
    const code = this.room.code;
    if (reason === 'pagehide') return this.detachRoom(true);
    this.detachRoom();
    this.goHome();
    if (reason === 'removed') this.ui.showError('The host removed you from the room.');
    else if (reason !== 'left' && reason !== 'pagehide') {
      this.ui.showError('You lost the connection to the room. The code is filled in if you want back in.');
      this.ui.setJoinCode(code);
    }
  }

  /** Connection indicator + in-race messages when the link drops and comes back. */
  onStatus(status) {
    const prev = this.connStatus;
    this.connStatus = status;
    this.ui.setConnection(status);
    if (prev === status) return;
    const racing = this.race && !this.practice && this.phase !== Phase.RESULTS;
    if (status === 'offline' || status === 'connecting') {
      if (prev === 'online') {
        if (racing) this.ui.announce('Connection lost. Keep riding while it reconnects', 'bad');
        else this.ui.notify?.('Connection lost. Reconnecting…', 'bad');
      }
    } else if (status === 'online' && prev && prev !== 'online') {
      if (racing) this.ui.announce('Back online', 'good');
      else this.ui.notify?.('Back online', 'good');
    }
  }

  /** The host keeps colours unique: our own scarf follows its assignment. */
  followAssignedColor(players) {
    const me = players.find((p) => p.id === this.room?.selfId);
    if (me && me.colorIndex !== this.profile.colorIndex) {
      this.profile = { ...this.profile, colorIndex: me.colorIndex };
      writeJson(PROFILE_KEY, this.profile);
      this.ui.setProfile(this.profile);
    }
  }

  onPlayers(players) {
    // Host changes (the host left or dropped): say who runs the room now.
    const host = players.find((p) => p.isHost);
    if (host && this.hostId && host.id !== this.hostId) {
      const msg = host.id === this.room.selfId ? 'The host left. You are the host now.' : `The host left. ${host.name} is the host now.`;
      if (this.race && !this.practice && this.phase !== Phase.RESULTS) this.ui.announce(msg, 'info');
      else this.ui.notify?.(msg, 'info');
    }
    if (host) this.hostId = host.id;
    this.followAssignedColor(players);
    const ids = new Set(players.map((p) => p.id));
    for (const p of players) {
      if (!this.knownIds.has(p.id) && p.id !== this.room.selfId) this.audio.ui('join');
    }
    for (const id of this.knownIds) if (!ids.has(id)) this.audio.ui('leave');
    this.knownIds = ids;
    if (this.race && !this.practice) {
      for (const p of players) {
        if (p.id !== this.room.selfId && this.race.remotes.has(p.id)) this.race.addRemote(p);
      }
      // Riders who left or lost their connection stop being drawn and ranked.
      for (const [id, remote] of this.race.remotes) remote.gone = !players.some((p) => p.id === id && p.connected);
      if (this.staleRace()) return this.showLobby();
    }
    this.refreshLobby();
    if (this.lastResults && this.phase === Phase.RESULTS) this.pushResults();
  }

  onRoomPhase(phase) {
    if (phase === Phase.LOBBY && this.phase !== Phase.LOBBY) this.showLobby();
    else if (this.staleRace()) this.showLobby();
    else this.refreshLobby();
  }

  /** True when the race on screen is no longer the room's race (we were offline while it moved on). */
  staleRace() {
    const room = this.room;
    return !!(room && this.race && !this.practice && this.phase !== Phase.RESULTS && room.race && room.race.raceId !== this.raceId);
  }

  refreshLobby() {
    const room = this.room;
    if (!room || this.phase !== Phase.LOBBY) return;
    // A race can be started from the lobby or straight from the results (e.g. after the host changed).
    const busy = room.phase === Phase.COUNTDOWN || room.phase === Phase.RACING;
    if (!busy) this.spectate = null;
    this.ui.setLobby({
      code: room.code,
      shareUrl: this.shareUrl(),
      players: room.players,
      selfId: room.selfId,
      isHost: room.isHost,
      settings: room.settings,
      canStart: room.isHost && !busy,
      startHint: busy ? "A race is on. You're in the next one." : undefined,
      inProgress: busy,
      live: busy ? this.liveStandings() : null,
      takenColors: room.takenColors,
    });
  }

  /**
   * Joined while a race runs: a mini standings table from the riders' state messages (the course is
   * rebuilt from the race seed once, to turn x into progress). Null when there is nothing to show.
   */
  liveStandings() {
    const room = this.room;
    const r = room?.race;
    if (!r) return null;
    let sp = this.spectate;
    if (!sp || sp.raceId !== r.raceId) {
      let course = null;
      try {
        course = generateCourse(r.seed, r.settings);
      } catch {
        return null;
      }
      sp = this.spectate = { raceId: r.raceId, startX: course.startX, length: course.length, xs: new Map(), finished: new Map(), at: 0 };
    }
    const rows = [];
    for (const p of room.players) {
      if (!(r.ids ?? []).includes(p.id) || p.id === room.selfId) continue;
      const fin = sp.finished.get(p.id);
      const x = sp.xs.get(p.id);
      const progress = fin !== undefined ? 1 : x === undefined ? 0 : Math.max(0, Math.min(1, (x - sp.startX) / sp.length));
      rows.push({ id: p.id, name: p.name, color: PLAYER_COLORS[p.colorIndex] ?? PLAYER_COLORS[0], progress, finished: fin !== undefined, timeMs: fin ?? -1 });
    }
    rows.sort((a, b) => (a.finished && b.finished ? a.timeMs - b.timeMs : b.progress - a.progress));
    return rows;
  }

  /* --------------------------------- screens --------------------------------- */

  goHome() {
    this.phase = Phase.HOME;
    this.endRaceView();
    this.ui.show('home');
    this.audio.startMusic('menu');
  }

  showLobby() {
    if (!this.room) return this.goHome();
    this.phase = Phase.LOBBY;
    this.endRaceView();
    this.ui.show('lobby');
    this.refreshLobby();
    this.audio.startMusic('menu');
  }

  endRaceView() {
    if (this.race) {
      this.race = null;
      this.lastResults = null;
      this.hintState = null;
      this.ui.setCountdown(null);
      this.ui.closeOnboarding?.();
      this.newBackdrop();
    }
    this.setWakeLock(false);
  }

  newBackdrop() {
    const seed = randomSeed();
    this.backdrop = new Race({
      seed,
      // Nobody races the attract-mode rider: no bots (each one plans by simulation every tick).
      settings: { ...DEFAULT_SETTINGS, length: 'marathon', bots: 0 },
      goAtMs: performance.now(),
      self: { id: 'backdrop', name: '', colorIndex: this.profile.colorIndex },
      autopilot: 0.9,
    });
    // Each backdrop continues the same day/night clock instead of snapping back to dawn.
    this.backdrop.clockOffset = this.backdropClock;
    this.renderer.setCourse(this.backdrop.course);
  }

  /* ----------------------------------- race ----------------------------------- */

  startPractice(profile) {
    this.audio.unlock();
    this.audio.ui('click');
    const self = { id: 'local', ...this.namedProfile(profile) };
    this.practice = true;
    this.enterRace(new Race({ seed: this.seedParam() ?? randomSeed(), settings: this.practiceSettings(), goAtMs: performance.now() + COUNTDOWN_MS, self, autopilot: this.autopilot }));
  }

  seedParam() {
    const seed = Number(this.params.get('seed'));
    return Number.isFinite(seed) && seed > 0 ? seed >>> 0 : null;
  }

  practiceSettings() {
    const pick = (key, list) => (list.includes(this.params.get(key)) ? this.params.get(key) : PRACTICE_SETTINGS[key]);
    const bots = this.params.has('bots') ? Math.max(0, Math.min(6, Number(this.params.get('bots')) | 0)) : PRACTICE_SETTINGS.bots;
    return {
      length: pick('length', ['sprint', 'classic', 'marathon']),
      weather: pick('weather', ['auto', 'clear', 'snow', 'storm', 'fog']),
      startTime: pick('startTime', ['auto', 'dawn', 'day', 'golden', 'dusk', 'night']),
      bots,
      catchUp: this.params.get('catchup') !== '0',
    };
  }

  /** @param {import('../contracts.js').StartInfo} info */
  beginRace(info) {
    const room = this.room;
    const me = room.players.find((p) => p.id === room.selfId);
    const racing = new Set(room.race?.ids ?? room.players.map((p) => p.id));
    const remotes = room.players.filter((p) => p.id !== room.selfId && racing.has(p.id));
    this.practice = false;
    const race = new Race({
      seed: info.seed,
      settings: info.settings,
      goAtMs: info.goAtLocalMs,
      self: { id: room.selfId, name: me?.name ?? this.profile.name, colorIndex: me?.colorIndex ?? this.profile.colorIndex },
      remotes,
      autopilot: this.autopilot,
    });
    room.setCourseSpan(race.course.startX, race.course.finishX);
    this.raceId = info.raceId;
    this.enterRace(race);
  }

  enterRace(race) {
    this.race = race;
    this.backdrop = null;
    this.lastResults = null;
    this.saved = 'pending';
    this.countdownShown = null;
    this.finalStretch = false;
    this.practiceEndAt = 0;
    this.callout = { shown: 0, pending: 0, since: 0, lastAt: -1e9 };
    this.posAt = 0;
    this.places = new Map();
    this.finishCount = 0;
    this.photoShown = false;
    this.gapInfo = null;
    this.spectateAt = 0;
    this.watching = false;
    this.focusId = null;
    this.phase = Phase.COUNTDOWN;
    // Start-line slots: everyone lines up behind the gate in a stable order.
    const ids = [race.local.id, ...race.remotes.keys(), ...race.bots.map((b) => b.id)].sort();
    this.slots = new Map(ids.map((id, i) => [id, i]));
    this.renderer.setCourse(race.course);
    this.ui.resetRace();
    this.ui.setRiderColor?.(race.local.colorIndex);
    this.ui.show('race');
    this.audio.startMusic('race');
    this.setWakeLock(true);
    this.startHints();
    this.maybeOnboard(race);
  }

  /* ------------------------------- first run -------------------------------- */

  /** First race ever: the how-to card. A practice countdown waits for it; a room race cannot wait. */
  maybeOnboard(race) {
    if (!this.tutorial || readJson(ONBOARD_KEY, false) || !this.ui.showOnboarding) return;
    const hold = this.practice;
    if (hold) race.goAtMs = Infinity;
    this.ui.showOnboarding({
      waiting: hold,
      onDone: () => {
        writeJson(ONBOARD_KEY, true);
        if (hold && this.race === race && !race.started) race.goAtMs = performance.now() + COUNTDOWN_MS;
      },
    });
  }

  startHints() {
    this.hintState = null;
    if (!this.tutorial || this.hints.races >= HINT_RACES) return;
    this.hints.races++;
    writeJson(HINTS_KEY, this.hints);
    this.hintState = { shown: new Set(), lastAt: -1e9, airMs: 0, cleared: false };
  }

  /** One-time contextual hints in the first races, as announce pills. */
  hint(key, text, tone = 'info') {
    const hs = this.hintState;
    const now = performance.now();
    if (!hs || hs.shown.has(key) || now - hs.lastAt < HINT_GAP_MS) return;
    hs.shown.add(key);
    hs.lastAt = now;
    this.ui.announce(text, tone);
  }

  hintFrame(race, dtMs) {
    const hs = this.hintState;
    if (!hs || !race.started || race.finished) return;
    const s = race.state;
    hs.airMs = s.mode === RiderMode.AIR ? hs.airMs + dtMs : 0;
    if (hs.airMs > 380 && !(s.stats.flips > 0)) this.hint('flip', 'Big air. Hold to backflip');
    if (!hs.cleared && race.tick % 10 === 0) {
      // ~3.5 s ahead at the current speed, so it shows before the ramp's run-up, not at the lip
      const pit = race.course.featuresIn(s.x + 300, s.x + Math.max(1400, (s.speed || 0) * 3.5)).find((f) => f.type === FeatureType.CHASM);
      if (pit) this.hint('pit', 'Pit ahead. Jump off the ramp');
    }
  }

  onRemoteFinish(report) {
    const race = this.race;
    if (!race || this.practice) return;
    race.noteFinish(report.id, report.timeMs);
    if (report.id === this.room.selfId || report.timeMs < 0) return;
    const place = [...race.finishTimes.values()].filter((t) => t < report.timeMs).length + 1;
    this.ui.announce(`${report.name} finished ${ordinal(place)}`, 'info');
  }

  handleEvent(event) {
    const { type, data } = event;
    this.audio.onSimEvent(event);
    if (this.hintState) {
      if (type === SimEvent.CHASM_CLEAR) this.hintState.cleared = true;
      else if (type === SimEvent.BOOST) setTimeout(() => this.hint('boost', 'Clean landing. Speed boost', 'good'), 1200);

    }
    if (type === SimEvent.TRICK) this.ui.trickToast(data.label, data.points);
    else if (type === SimEvent.COMBO) this.pendingCombo = data;
    else if (type === SimEvent.BOOST) {
      const c = this.pendingCombo;
      this.ui.comboBanked(c?.total ?? 0, c?.mult ?? 1, data.level);
      this.pendingCombo = null;
    } else if (type === SimEvent.RESCUE_START) this.ui.announce('Fell in. The balloon costs you 3 s', 'bad');
    else if (type === SimEvent.CRASH && CRASH_REASONS[data?.cause]) this.ui.crashLabel?.(CRASH_REASONS[data.cause]);
    else if (type === SimEvent.LAND && data?.sketchy && performance.now() - this.lastSketchyMs > 4000) {
      this.lastSketchyMs = performance.now();
      this.ui.announce('Sketchy landing', 'info');
    } else if (type === SimEvent.FINISH) this.onLocalFinish();
  }

  onLocalFinish() {
    if (this.phase === Phase.RESULTS) return; // crossed the line after the race was called
    const race = this.race;
    const report = race.localReport();
    const place = [...race.finishTimes.entries()].filter(([id, t]) => id !== race.local.id && t < report.timeMs).length + 1;
    this.ui.setFinished(place, report.timeMs);
    this.audio.ui(place === 1 ? 'win' : 'finish');
    if (this.practice) this.practiceEndAt = performance.now() + PRACTICE_GRACE_MS;
    else this.room?.reportFinish(report);
    this.spectateAt = performance.now() + SPECTATE_AFTER_MS;
    this.setWakeLock(false);
  }

  /** @param {import('../contracts.js').RaceResults} results */
  showResults(results) {
    if (!this.race) return; // joined mid-race: stay in the lobby
    if (!this.practice && results.raceId !== this.raceId) return this.showLobby(); // not the race we rode
    this.lastResults = results;
    this.phase = Phase.RESULTS;
    this.ui.setCountdown(null);
    this.pushResults();
    this.ui.show('results');
    this.audio.startMusic('results');
    this.setWakeLock(false);
    // The hall of fame is for people: the first human across the line, in room races only.
    const humans = results.ranking.filter((r) => !r.id.startsWith('bot:'));
    const winner = humans.find((r) => r.timeMs >= 0);
    if (this.practice || !winner || !this.room.isHost) {
      this.saved = null;
      this.pushResults();
      return;
    }
    // Only the host writes, so one race is stored exactly once.
    const room = this.room;
    this.store
      .add({
        name: winner.name,
        colorIndex: winner.colorIndex,
        timeMs: winner.timeMs,
        length: results.settings.length,
        players: humans.length,
        score: Math.round(winner.stats?.score ?? 0),
        room: room.code,
        at: Date.now(),
      })
      .then((where) => {
        if (this.lastResults !== results) return;
        this.saved = where === 'remote' ? 'ok' : 'local';
        this.pushResults();
      });
  }

  pushResults() {
    if (!this.resultsExtras || this.resultsExtras.for !== this.lastResults) this.resultsExtras = { for: this.lastResults, ...this.resultExtras(this.lastResults) };
    const host = this.room?.players.find((p) => p.isHost);
    this.ui.setResults({
      results: this.lastResults,
      selfId: this.practice ? 'local' : this.room?.selfId,
      isHost: this.practice || !!this.room?.isHost,
      saved: this.saved,
      awards: this.resultsExtras.awards,
      journey: this.resultsExtras.journey,
      practice: this.practice,
      hostName: host?.name ?? '',
    });
  }

  /* ---------------------------------- frame ---------------------------------- */

  frame(dtMs) {
    const now = performance.now();
    if (dtMs > 0 && dtMs < 250) this.fps.ema += (dtMs - this.fps.ema) * 0.05;
    if (this.fps.on && now - this.fps.shownAt > 500) {
      this.fps.shownAt = now;
      const q = this.renderer.quality;
      this.ui.setFps?.(`${Math.round(1000 / this.fps.ema)} fps${q ? ` · ${q.name} · ${(+q.pixelDensity || 1).toFixed(2)}×` : ''}`);
    }
    if (this.race) this.raceFrame(now, dtMs);
    else if (!this.backdropFrame(now, dtMs)) return;
    const night = this.renderer.atmosphere?.night ?? 0;
    if (Math.abs(night - this.lastTone) > 0.04) {
      this.lastTone = night;
      this.ui.setTone(night);
    }
  }

  /** Returns false when the frame was skipped (nothing drawn). */
  backdropFrame(now, dtMs) {
    const b = this.backdrop;
    // A dialog covers the scene: freeze it (no sim, no draw) and resume where it was.
    if (this.modalOpen) {
      if (!this.backdropPausedAt) this.backdropPausedAt = now;
      return false;
    }
    if (this.backdropPausedAt) {
      b.goAtMs += now - this.backdropPausedAt;
      this.backdropPausedAt = 0;
    }
    // ~30 fps behind the menus, when the renderer can be told (its 'auto' governor reads skipped
    // frames as slowness and would drop the race quality otherwise).
    const r = this.renderer;
    const throttle = typeof r.setFrameInterval === 'function' || (r.quality && r.quality.mode !== 'auto');
    if (typeof r.setFrameInterval === 'function') r.setFrameInterval(BACKDROP_FRAME_MS + 2);
    if (throttle && now - this.lastBackdropDraw < BACKDROP_FRAME_MS) return false;
    dtMs = this.lastBackdropDraw && now - this.lastBackdropDraw < 250 ? now - this.lastBackdropDraw : dtMs;
    this.lastBackdropDraw = now;
    b.update(now);
    b.drainEvents();
    b.drainBotFinishes();
    this.backdropClock = b.clockOffset + b.timeMs;
    const { local, others } = b.views(now, new Map());
    this.renderer.draw({ timeMs: this.backdropClock, dtMs, local, others, events: [], phase: this.phase, cinematic: true });
    const s = b.state;
    this.audio.update({ speed: 0, mode: RiderMode.IDLE, boostLevel: 0, night: this.renderer.atmosphere.night, weather: this.renderer.atmosphere.weather, weatherAmt: this.renderer.atmosphere.weatherAmt * 0.5, flash: this.renderer.atmosphere.flash });
    // Past the finish (or somehow stopped): roll a fresh mountain.
    if (b.finished || (s.mode === RiderMode.FINISHED && s.speed < 20)) this.newBackdrop();
    // Joined mid-race: refresh the lobby's live standings a few times a second.
    if (this.spectate && this.phase === Phase.LOBBY && now - this.spectate.at > 250) {
      this.spectate.at = now;
      this.refreshLobby();
    }
    return true;
  }

  raceFrame(now, dtMs) {
    const race = this.race;
    const room = this.practice ? null : this.room;
    if (typeof this.renderer.setFrameInterval === 'function') this.renderer.setFrameInterval(0);

    // Countdown
    if (!race.started) {
      const left = race.goAtMs - now;
      const value = left <= 0 ? 'GO' : Math.min(3, Math.ceil(left / 1000));
      if (left <= 3000 && value !== this.countdownShown) {
        this.countdownShown = value;
        this.ui.setCountdown(value);
        this.audio.ui(value === 'GO' ? 'go' : 'countdown');
      }
    }
    race.update(now);
    if (race.started && this.phase === Phase.COUNTDOWN) {
      this.phase = Phase.RACING;
      this.ui.closeOnboarding?.();
      if (this.countdownShown !== 'GO') {
        this.countdownShown = 'GO';
        this.ui.setCountdown('GO');
        this.audio.ui('go');
      }
    }

    let events = race.drainEvents();
    // After a long stall (hidden tab) the catch-up produces a pile of events: only the finish matters.
    if (race.catchingUp || events.length > 24) events = events.filter((e) => e.type === SimEvent.FINISH);
    for (const e of events) this.handleEvent(e);
    this.hintFrame(race, dtMs);
    for (const report of race.drainBotFinishes()) room?.reportFinish(report);

    // Network: latest state, 12 times a second (also on the start line, so ghosts line up).
    if (room && now - this.lastSendMs >= NET_SEND_MS) {
      this.lastSendMs = now - this.lastSendMs > 2 * NET_SEND_MS ? now : this.lastSendMs + NET_SEND_MS;
      room.sendState(race.netState());
    }

    // Practice: no host to end the race, so do it here.
    if (this.practice && this.phase === Phase.RACING && race.finished) {
      const allIn = race.bots.every((b) => b.sim.state.finishTick >= 0);
      if (allIn || now >= this.practiceEndAt) this.showResults(race.localResults());
    }

    const { local, others } = race.views(now, this.slots);
    const rows = race.standings();
    if (now - this.posAt > 200) {
      this.posAt = now;
      this.places = race.notePositions(rows);
      this.calloutFrame(now, race, rows);
    }
    const gaps = race.gaps(rows);
    this.spectateFrame(now, race, others);
    this.renderer.draw({ timeMs: race.timeMs, dtMs, local, others, events, phase: this.phase, cinematic: false, markers: this.offscreenMarkers(gaps, others), focusId: this.focusId ?? undefined });

    const s = race.state;
    const atm = this.renderer.atmosphere;
    this.audio.update({ speed: s.speed, mode: s.mode, boostLevel: s.boostT > 0 ? s.boostLevel : 0, night: atm.night, weather: atm.weather, weatherAmt: atm.weatherAmt, flash: atm.flash });

    if (this.phase !== Phase.RESULTS) {
      this.closingFrame(now, race);
      const anchor = this.renderer.worldToScreen(local.x, local.y);
      this.ui.setTrickAnchor(anchor.x, anchor.y);
      this.ui.updateHud({
        timeMs: race.finished ? s.finishTick * TICK_MS : race.timeMs,
        speedMps: s.speed / PX_PER_M,
        progress: s.progress,
        position: race.position(rows),
        total: rows.length,
        scarf: s.scarf,
        boostT: s.boostT,
        boostLevel: s.boostT > 0 ? s.boostLevel : 0,
        hoverT: s.hoverT,
        magnetT: s.magnetT,
        combo: s.combo,
        racers: rows,
        gaps,
        tailwind: !race.finished && race.localAssist > 0.3,
      });
      if (!this.finalStretch && s.progress > 0.88 && !race.finished) {
        this.finalStretch = true;
        this.ui.announce('Final stretch', 'good');
      }
    }
  }

  /* ------------------------------ race extras ------------------------------- */

  /** "Passed Maya · 2nd" / "Paz passed you · 3rd" once a new place has held for a moment; photo finishes. */
  calloutFrame(now, race, rows) {
    const c = this.callout;
    const pos = race.position(rows);
    if (!race.started || !c) return;
    if (!c.shown) c.shown = pos;
    if (!race.finished && pos !== c.shown) {
      if (c.pending !== pos) {
        c.pending = pos;
        c.since = now;
      } else if (now - c.since >= CALLOUT_HOLD_MS && now - c.lastAt >= CALLOUT_GAP_MS) {
        const byPlace = new Map([...this.places].map(([id, p]) => [p, id]));
        const otherId = byPlace.get(pos < c.shown ? pos + 1 : pos - 1);
        const other = rows.find((r) => r.id === otherId);
        if (other) {
          this.ui.announce(pos < c.shown ? `Passed ${other.name} · ${ordinal(pos)}` : `${other.name} passed you · ${ordinal(pos)}`, pos < c.shown ? 'good' : 'info');
          this.audio.ui('pass');
        }
        c.shown = pos;
        c.lastAt = now;
      }
    } else c.pending = 0;
    // Photo finish: two finishers within half a second.
    if (race.finishTimes.size !== this.finishCount) {
      this.finishCount = race.finishTimes.size;
      const times = [...race.finishTimes.values()].sort((a, b) => a - b);
      if (!this.photoShown && times.some((t, i) => i > 0 && t - times[i - 1] < PHOTO_FINISH_MS)) {
        this.photoShown = true;
        this.ui.announce('Photo finish', 'good');
      }
    }
  }

  /** The nearest rider ahead and behind, when off-screen, as edge markers for the renderer. */
  offscreenMarkers(gaps, others) {
    const out = [];
    for (const g of [gaps.ahead, gaps.behind]) {
      if (!g) continue;
      const v = others.find((o) => o.id === g.id);
      if (!v) continue;
      const p = this.renderer.worldToScreen(v.x, v.y);
      if (p.x < 0 || p.x > innerWidth || p.y < 0 || p.y > innerHeight) out.push({ id: g.id, gapS: g.gapS });
    }
    return out;
  }

  /** Riders still racing (ids in `others`), leader first. */
  stillRacing(race, others) {
    const done = (id) => race.finishTimes.has(id) || race.bots.some((b) => b.id === id && b.sim.state.finishTick >= 0);
    return others.filter((o) => !done(o.id)).sort((a, b) => b.x - a.x);
  }

  /** After the finish the camera follows someone still racing; a press switches rider. */
  spectateFrame(now, race, others) {
    if (!race.finished || !this.spectateAt || now < this.spectateAt || this.phase === Phase.RESULTS) return;
    const racing = this.stillRacing(race, others);
    this.lastOthers = others;
    if (!racing.length) {
      this.focusId = null;
      this.watching = false;
      this.ui.setWatching?.(null);
      return;
    }
    if (!this.focusId || !racing.some((o) => o.id === this.focusId)) {
      const me = race.state.x;
      this.focusId = racing.reduce((best, o) => (Math.abs(o.x - me) < Math.abs(best.x - me) ? o : best)).id;
    }
    this.watching = true;
    const v = racing.find((o) => o.id === this.focusId);
    this.ui.setWatching?.({ name: v?.name ?? '', place: this.places.get(this.focusId) });
  }

  cycleFocus() {
    const racing = this.race && this.lastOthers ? this.stillRacing(this.race, this.lastOthers) : [];
    if (racing.length < 2) return;
    const i = racing.findIndex((o) => o.id === this.focusId);
    this.focusId = racing[(i + 1) % racing.length].id;
  }

  /** "Race closes in 0:24": the room's closing time, or the practice grace after you finish. */
  closingFrame(now, race) {
    const at = this.practice ? (this.practiceEndAt || null) : this.room?.raceClosesAtLocalMs ?? null;
    this.ui.setClosing?.(at && race.started ? Math.max(0, at - now) : null);
  }

  /** Award chips and the local rider's "started / peaked / finished" line for the results screen. */
  resultExtras(results) {
    const ranking = results?.ranking || [];
    const race = this.race;
    const awards = [];
    const best = (key, fn, label, fmt, min = 1) => {
      let top = null;
      for (const r of ranking) {
        const v = fn(r);
        if (Number.isFinite(v) && v >= min && (!top || v > top.v)) top = { r, v };
      }
      if (top) awards.push({ key, label, name: top.r.name, color: PLAYER_COLORS[top.r.colorIndex] ?? PLAYER_COLORS[0], value: fmt(top.v) });
    };
    best('flips', (r) => r.stats?.flips, 'Most flips', (v) => String(v));
    best('speed', (r) => (r.stats?.topSpeed ?? 0) / PX_PER_M * 3.6, 'Top speed', (v) => `${Math.round(v)} km/h`, 1);
    best('combo', (r) => r.stats?.bestCombo, 'Biggest combo', (v) => String(v));
    const finishers = ranking.filter((r) => r.timeMs >= 0 && r.stats);
    if (finishers.length > 1) {
      const fewest = Math.min(...finishers.map((r) => r.stats.crashes ?? 0));
      const clean = finishers.filter((r) => (r.stats.crashes ?? 0) === fewest);
      if (clean.length === 1) awards.push({ key: 'clean', label: 'Cleanest run', name: clean[0].name, color: PLAYER_COLORS[clean[0].colorIndex] ?? PLAYER_COLORS[0], value: fewest ? `${fewest} crash${fewest === 1 ? '' : 'es'}` : 'no crashes' });
    }
    let journey = '';
    if (race) {
      let come = null;
      ranking.forEach((r, i) => {
        const p = race.positions.get(this.practice && r.id === 'local' ? race.local.id : r.id);
        if (p && r.timeMs >= 0 && p.worst - (i + 1) >= 2 && (!come || p.worst - (i + 1) > come.v)) come = { r, v: p.worst - (i + 1) };
      });
      if (come) awards.push({ key: 'comeback', label: 'Comeback', name: come.r.name, color: PLAYER_COLORS[come.r.colorIndex] ?? PLAYER_COLORS[0], value: `+${come.v} places` });
      const mine = race.positions.get(race.local.id);
      const finalPlace = ranking.findIndex((r) => r.id === race.local.id) + 1;
      if (mine && finalPlace > 0) journey = `Started ${ordinal(mine.start)} · peaked ${ordinal(mine.best)} · finished ${ordinal(finalPlace)}`;
    }
    return { awards, journey };
  }

  resize() {
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }

  /* ------------------------------ page lifecycle ------------------------------ */

  installPageGuards() {
    // Closing / reloading the tab during a room race throws the rider out: ask first.
    window.addEventListener('beforeunload', (e) => {
      if (!this.room || this.practice || this.autopilot || !this.race || this.phase === Phase.RESULTS) return;
      e.preventDefault();
      e.returnValue = '';
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantWakeLock) this.setWakeLock(true);
    });
    window.addEventListener('offline', () => {
      if (!this.room) this.ui.notify?.("You're offline. Practice still works.", 'bad');
    });
  }

  /** Keeps the screen on during a race (phones dim after ~30 s without touches). Feature-detected. */
  async setWakeLock(on) {
    this.wantWakeLock = on;
    try {
      if (on) {
        if (this.wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
        const lock = await navigator.wakeLock.request('screen');
        if (!this.wantWakeLock) return lock.release().catch(() => {});
        this.wakeLock = lock;
        lock.addEventListener?.('release', () => {
          if (this.wakeLock === lock) this.wakeLock = null;
        });
      } else if (this.wakeLock) {
        const lock = this.wakeLock;
        this.wakeLock = null;
        await lock.release();
      }
    } catch {
      this.wakeLock = null;
    }
  }

  /** Read-only snapshot for automated tests and the console. */
  debugSnapshot() {
    const race = this.race;
    return {
      phase: this.phase,
      room: this.room ? { code: this.room.code, isHost: this.room.isHost, players: this.room.players.length, phase: this.room.phase, broker: this.room.brokerName } : null,
      race: race
        ? { seed: race.seed, tick: race.tick, started: race.started, finished: race.finished, progress: race.state.progress, mode: race.state.mode, speed: race.state.speed, x: race.state.x, y: race.state.y, ghosts: [...race.remotes.entries()].map(([id, r]) => ({ id, x: r.ghost.x, samples: r.ghost.samples.length })) }
        : null,
      results: this.lastResults,
      saved: this.saved,
    };
  }
}
