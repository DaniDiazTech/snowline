/**
 * Game — the application state machine. Wires UI ⇄ Room ⇄ Race ⇄ Renderer ⇄ Audio.
 *
 *   home ──create/join──▶ lobby ──start──▶ countdown ▶ racing ▶ results ──▶ lobby
 *     └──────practice (no room)────────────────▲
 *
 * While no race is on screen, a bot rides an endless "backdrop" course behind the UI.
 */
import { COUNTDOWN_MS, DEFAULT_SETTINGS, NET_SEND_HZ, PLAYER_COLORS, PX_PER_M, Phase, RiderMode, SimEvent, TICK_MS } from '../contracts.js';
import { randomSeed } from '../math/random.js';
import { Room } from '../net/Room.js';
import { WinnersStore, winnersStore } from '../store/WinnersStore.js';
import { Race } from './Race.js';

const PROFILE_KEY = 'snowline.profile';
const MUTE_KEY = 'snowline.muted';
const NET_SEND_MS = 1000 / NET_SEND_HZ;
/** Practice runs end this long after the player finishes, even if bots are still out. */
const PRACTICE_GRACE_MS = 8000;
const PRACTICE_SETTINGS = Object.freeze({ ...DEFAULT_SETTINGS, bots: 3 });
const ORDINALS = ['1st', '2nd', '3rd'];
const ordinal = (n) => ORDINALS[n - 1] ?? `${n}th`;

const JOIN_ERRORS = {
  'not-found': 'Room not found. Check the code and try again.',
  full: 'That room is full.',
  offline: 'Could not reach the game server from this network.',
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
      onLeave: () => this.leave(),
      onCopyLink: () => this.audio.ui('click'),
      onPlayAgain: () => (this.practice ? this.startPractice(this.profile) : this.room?.backToLobby()),
      onBackToLobby: () => this.showLobby(),
      onToggleMute: () => this.setMuted(!this.muted),
      onInput: (held) => {
        this.audio.unlock();
        this.race?.setInput(held);
      },
    };
  }

  /** Called once by main.js after the UI exists. */
  start(ui) {
    this.ui = ui;
    ui.setProfile(this.profile);
    ui.setMuted(this.muted);
    this.audio.setMuted(this.muted);
    const code = this.params.get('room');
    if (code) ui.setJoinCode(code);
    this.newBackdrop();
    this.goHome();
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
    this.profile = { name: String(profile.name ?? '').slice(0, 14), colorIndex: profile.colorIndex | 0 };
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
  }

  async openFame() {
    this.ui.setHallOfFame(null);
    this.ui.setHallOfFame(await this.store.list(50));
  }

  /* ---------------------------------- rooms ---------------------------------- */

  async createRoom(profile) {
    if (this.room) return;
    this.audio.unlock();
    this.audio.ui('click');
    this.ui.setBusy(true, 'Creating room…');
    try {
      this.attachRoom(await Room.create(this.namedProfile(profile), this.netOpts));
    } catch (err) {
      this.ui.showError(JOIN_ERRORS[err?.message] ?? 'Could not create a room. Check your connection.');
    } finally {
      this.ui.setBusy(false);
    }
  }

  async joinRoom(code, profile) {
    if (this.room) return;
    this.audio.unlock();
    this.audio.ui('click');
    this.ui.setBusy(true, 'Joining…');
    try {
      this.attachRoom(await Room.join(code, this.namedProfile(profile), this.netOpts));
    } catch (err) {
      this.ui.showError(JOIN_ERRORS[err?.message] ?? 'Could not join. Check your connection.');
    } finally {
      this.ui.setBusy(false);
    }
  }

  attachRoom(room) {
    this.room = room;
    this.practice = false;
    this.knownIds = new Set(room.players.map((p) => p.id));
    const on = (event, cb) => this.roomOff.push(room.on(event, cb));
    on('players', (players) => this.onPlayers(players));
    on('settings', () => this.refreshLobby());
    on('start', (info) => this.beginRace(info));
    on('state', ({ id, net, recvMs }) => this.race?.pushRemoteState(id, net, recvMs));
    on('finish', (report) => this.onRemoteFinish(report));
    on('results', (results) => this.showResults(results));
    on('phase', (phase) => this.onRoomPhase(phase));
    on('status', (status) => this.ui.setConnection(status));
    on('closed', ({ reason }) => this.onRoomClosed(reason));
    room.setDnfProvider(() => (this.race && !this.practice && room.race?.raceId === this.raceId ? this.race.botDnfReports() : []));
    this.ui.setConnection(room.status ?? 'online');
    this.audio.ui('join');
    // Keep the invite in the address bar so the host can also just copy the URL.
    this.setUrlRoom(room.code);
    this.showLobby();
  }

  detachRoom() {
    for (const off of this.roomOff) off();
    this.roomOff = [];
    this.room = null;
    this.setUrlRoom(null);
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
    this.detachRoom();
    this.goHome();
    if (reason !== 'left' && reason !== 'pagehide') this.ui.showError('Disconnected from the room.');
  }

  onPlayers(players) {
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
    this.ui.setLobby({
      code: room.code,
      shareUrl: this.shareUrl(),
      players: room.players,
      selfId: room.selfId,
      isHost: room.isHost,
      settings: room.settings,
      canStart: room.isHost && !busy,
      startHint: busy ? 'A race is in progress — you are in the next one.' : undefined,
    });
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
      this.ui.setCountdown(null);
      this.newBackdrop();
    }
  }

  newBackdrop() {
    const seed = randomSeed();
    this.backdrop = new Race({
      seed,
      settings: { ...DEFAULT_SETTINGS, length: 'marathon', bots: 2 },
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
    this.phase = Phase.COUNTDOWN;
    // Start-line slots: everyone lines up behind the gate in a stable order.
    const ids = [race.local.id, ...race.remotes.keys(), ...race.bots.map((b) => b.id)].sort();
    this.slots = new Map(ids.map((id, i) => [id, i]));
    this.renderer.setCourse(race.course);
    this.ui.resetRace();
    this.ui.show('race');
    this.audio.startMusic('race');
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
    if (type === SimEvent.TRICK) this.ui.trickToast(data.label, data.points);
    else if (type === SimEvent.COMBO) this.pendingCombo = data;
    else if (type === SimEvent.BOOST) {
      const c = this.pendingCombo;
      this.ui.comboBanked(c?.total ?? 0, c?.mult ?? 1, data.level);
      this.pendingCombo = null;
    } else if (type === SimEvent.RESCUE_START) this.ui.announce('Fell in — lifted across, −3 s', 'bad');
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
    this.ui.setResults({
      results: this.lastResults,
      selfId: this.practice ? 'local' : this.room?.selfId,
      isHost: this.practice || !!this.room?.isHost,
      saved: this.saved,
    });
  }

  /* ---------------------------------- frame ---------------------------------- */

  frame(dtMs) {
    const now = performance.now();
    if (this.race) this.raceFrame(now, dtMs);
    else this.backdropFrame(now, dtMs);
    const night = this.renderer.atmosphere?.night ?? 0;
    if (Math.abs(night - this.lastTone) > 0.04) {
      this.lastTone = night;
      this.ui.setTone(night);
    }
  }

  backdropFrame(now, dtMs) {
    const b = this.backdrop;
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
  }

  raceFrame(now, dtMs) {
    const race = this.race;
    const room = this.practice ? null : this.room;

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
      if (this.countdownShown !== 'GO') {
        this.countdownShown = 'GO';
        this.ui.setCountdown('GO');
        this.audio.ui('go');
      }
    }

    let events = race.drainEvents();
    // After a long stall (hidden tab) the catch-up produces a pile of events: only the finish matters.
    if (events.length > 24) events = events.filter((e) => e.type === SimEvent.FINISH);
    for (const e of events) this.handleEvent(e);
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
    this.renderer.draw({ timeMs: race.timeMs, dtMs, local, others, events, phase: this.phase, cinematic: false });

    const s = race.state;
    const atm = this.renderer.atmosphere;
    this.audio.update({ speed: s.speed, mode: s.mode, boostLevel: s.boostT > 0 ? s.boostLevel : 0, night: atm.night, weather: atm.weather, weatherAmt: atm.weatherAmt, flash: atm.flash });

    if (this.phase !== Phase.RESULTS) {
      const rows = race.standings();
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
      });
      if (!this.finalStretch && s.progress > 0.88 && !race.finished) {
        this.finalStretch = true;
        this.ui.announce('Final stretch', 'good');
      }
    }
  }

  resize() {
    this.renderer.resize(window.innerWidth, window.innerHeight);
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
