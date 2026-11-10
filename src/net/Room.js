/**
 * Room — Kahoot-style lobby + race protocol on top of a Transport (see contracts.js NETWORK).
 *
 * Topics (prefix TOPIC_PREFIX + CODE + '/'):
 *   meta       retained, host-published {h, e, ph, n, s, at}: lets joiners see full / in-race; cleared
 *              when the last player leaves. Refreshed every 10 s (`at` = epoch ms).
 *   ctl        reliable control, every message is {t, f:senderId, ...}:
 *                hello {n,c}       join / re-join / "please resend the snapshot"
 *                snap  {...}       host: full authoritative room snapshot (roster, settings, phase, race, results)
 *                prof  {n,c}       profile change → host
 *                deny  {to,r}      host: join refused ('full')
 *                fin   {rid,r}     a FinishReport → host;  fok {rid,r} host-validated re-broadcast
 *                ping  {to,a} / pong {to,a,b}   clock sync against the host (unreliable)
 *                hb    {rtt[,e,v,ph]}          heartbeat every 2 s (unreliable)
 *                bye   {r:'leave'|'lost'}      leave / last will
 *   s/<id>     unreliable NetState arrays (latest wins), 12 Hz
 *
 * Authority: the host owns roster order, names (de-duplicated), settings, phase, start and
 * results. Every incoming message is validated; anything malformed, oversized, too frequent or
 * from an unknown id is ignored. Host migration: when the host says bye or is silent for
 * ~6 s, the earliest-joined live player takes over with epoch+1 (higher epoch wins; equal epoch
 * → lower id wins), so every client converges on the same host, including a returning old host.
 *
 * Timebase: all local times are clock.now() (performance.now() by default), the timebase of
 * StartInfo.goAtLocalMs. Each client estimates its offset to the host clock from ping/pong
 * (min-RTT sample of the last 8, refreshed every 5 s and after every host change).
 *
 * Event order: 'players' → 'settings' → 'start' → 'results' → 'phase' within one update.
 */
import { Phase, MAX_PLAYERS, COUNTDOWN_MS, DEFAULT_SETTINGS, PLAYER_COLORS, COURSE_LENGTHS, WEATHERS, START_TIMES } from '../contracts.js';
import { Emitter } from './emitter.js';
import { ClockSync, systemClock } from './clock.js';
import { MqttTransport, LoopbackTransport, LoopbackHub } from './Transport.js';
import { BROKERS, TOPIC_PREFIX, makeRoomCode, normalizeCode, brokerIndexForCode, randomUint32 } from './brokers.js';

/** Protocol timing (ms). Override per room with opts.timing (tests use a ManualClock). */
export const NET_TIMING = Object.freeze({
  heartbeatMs: 2000, // hb + liveness check period
  staleMs: 6000, // silent this long → connected:false (and host migration if it is the host)
  suspectMs: 2000, // after a 'lost' will, silent this long → treated as gone
  removeMs: 20000, // disconnected this long in lobby/results → removed from the roster
  joinTimeoutMs: 4000, // no host answer → 'not-found'
  helloRetryMs: 800,
  connectTimeoutMs: 6000, // joiner → 'offline'
  createRaceMs: 3000, // create: wait this long for the best-ranked broker
  syncEveryMs: 5000,
  metaEveryMs: 10000,
  graceMs: 30000, // after the first finisher
  capMs: Object.freeze({ sprint: 4 * 60000, classic: 6 * 60000, marathon: 9 * 60000 }), // from GO
  minFinishMs: 10000, // finish times below this are rejected
});

const NAME_MAX = 14;
const ID_RE = /^[A-Za-z0-9_-]{4,24}$/;
const BOT_RE = /^bot:[A-Za-z0-9_-]{1,16}$/;
const PHASES = new Set(Object.values(Phase));
const STAT_KEYS = ['score', 'bestCombo', 'flips', 'grindPx', 'crashes', 'coins', 'topSpeed'];
const HOST_ONLY = new Set(['snap', 'deny', 'fok', 'pong']);
const CTL_TYPES = new Set(['hello', 'snap', 'prof', 'deny', 'fin', 'fok', 'ping', 'pong', 'hb', 'bye']);

/* ------------------------------ validation helpers ------------------------------ */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Strip control/format characters, collapse spaces, max 14 code points; '' → 'Rider'. */
export function sanitizeName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.slice(0, 64).normalize('NFC').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
  s = [...s].slice(0, NAME_MAX).join('').trim();
  return s || 'Rider';
}

function sanitizeColor(c) {
  return Number.isInteger(c) && c >= 0 && c < PLAYER_COLORS.length ? c : 0;
}

/** @returns {import('../contracts.js').RaceSettings|null} */
export function sanitizeSettings(s, base = DEFAULT_SETTINGS) {
  if (!isObj(s)) return null;
  const out = { ...base };
  if ('length' in s) {
    if (!Object.hasOwn(COURSE_LENGTHS, s.length)) return null;
    out.length = s.length;
  }
  if ('weather' in s) {
    if (!WEATHERS.includes(s.weather)) return null;
    out.weather = s.weather;
  }
  if ('startTime' in s) {
    if (!START_TIMES.includes(s.startTime)) return null;
    out.startTime = s.startTime;
  }
  if ('bots' in s) {
    if (!Number.isInteger(s.bots) || s.bots < 0 || s.bots > 6) return null;
    out.bots = s.bots;
  }
  return out;
}

function sanitizeStats(st) {
  const o = {};
  for (const k of STAT_KEYS) o[k] = isObj(st) && fin(st[k]) ? clamp(st[k], 0, 1e9) : 0;
  return o;
}

/** Shape-check a FinishReport; returns a clean copy or null. */
function sanitizeReport(r) {
  if (!isObj(r) || typeof r.id !== 'string' || !(ID_RE.test(r.id) || BOT_RE.test(r.id))) return null;
  if (!fin(r.timeMs) || !(r.timeMs === -1 || (r.timeMs >= 0 && r.timeMs < 3600000))) return null;
  return {
    id: r.id,
    name: sanitizeName(r.name),
    colorIndex: sanitizeColor(r.colorIndex),
    timeMs: r.timeMs,
    progress: fin(r.progress) ? clamp(r.progress, 0, 1) : 0,
    stats: sanitizeStats(r.stats),
  };
}

function sanitizeResults(res) {
  if (!isObj(res) || !Number.isInteger(res.raceId) || !Number.isInteger(res.seed) || !Array.isArray(res.ranking)) return null;
  const settings = sanitizeSettings(res.settings);
  if (!settings || res.ranking.length > 32) return null;
  const ranking = [];
  for (const r of res.ranking) {
    const c = sanitizeReport(r);
    if (!c) return null;
    ranking.push(c);
  }
  const out = { raceId: res.raceId, seed: res.seed >>> 0, settings, ranking };
  if (['all', 'grace', 'cap'].includes(res.reason)) out.reason = res.reason;
  return out;
}

function validNet(net) {
  if (!Array.isArray(net) || net.length < 9 || net.length > 16) return false;
  for (const v of net) if (!fin(v) || Math.abs(v) > 1e8) return false;
  return true;
}

function randomId() {
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

/** Token bucket per sender. */
class RateGate {
  constructor(perSec, burst) {
    this.perSec = perSec;
    this.burst = burst;
    /** @type {Map<string,{tokens:number, at:number}>} */
    this.b = new Map();
  }
  allow(id, now) {
    let s = this.b.get(id);
    if (!s) {
      if (this.b.size > 256) this.b.clear(); // hostile id spray
      s = { tokens: this.burst, at: now };
      this.b.set(id, s);
    }
    s.tokens = Math.min(this.burst, s.tokens + ((now - s.at) / 1000) * this.perSec);
    s.at = now;
    if (s.tokens < 1) return false;
    s.tokens -= 1;
    return true;
  }
}

function emptyStats() {
  return sanitizeStats(null);
}

/* ------------------------------------ Room ------------------------------------ */

/**
 * @typedef {Object} RoomOptions
 * @property {'mqtt'|'local'} [net]        'local' = LoopbackTransport on the shared cross-tab hub (no internet)
 * @property {(code:string, brokerIndex:number)=>Object} [transportFactory]  custom transport per code (tests)
 * @property {LoopbackHub} [hub]           hub for net:'local'
 * @property {ReadonlyArray<Object>} [brokers]  defaults to BROKERS
 * @property {import('./clock.js').Clock} [clock]
 * @property {Partial<typeof NET_TIMING>} [timing]
 * @property {string} [selfId]
 * @property {boolean} [pagehide]          listen for pagehide → leave() (default true in browsers)
 */

export class Room {
  /** @private use Room.create / Room.join */
  constructor({ transport, code, profile, opts }) {
    this._em = new Emitter();
    this._t = transport;
    this._clock = opts.clock || systemClock;
    this._tm = { ...NET_TIMING, ...(opts.timing || {}), capMs: { ...NET_TIMING.capMs, ...(opts.timing?.capMs || {}) } };
    this.code = code;
    this.selfId = opts.selfId && ID_RE.test(opts.selfId) ? opts.selfId : randomId();
    this.brokerName = transport.name || '';
    this.hostId = '';
    this.phase = Phase.LOBBY;
    /** @type {import('../contracts.js').PlayerInfo[]} */
    this.players = [];
    this.settings = { ...DEFAULT_SETTINGS };
    /** Current/last race: {raceId, seed, settings, goAtLocalMs, ids} (additive). null in lobby. */
    this.race = null;
    /** Last RaceResults (additive). */
    this.results = null;
    this.status = transport.status || 'online';
    this.shareUrl = typeof location !== 'undefined' ? `${location.origin}${location.pathname}?room=${code}` : `?room=${code}`;

    this._profile = { name: sanitizeName(profile?.name), colorIndex: sanitizeColor(profile?.colorIndex) };
    this._base = TOPIC_PREFIX + code + '/';
    this._ctl = this._base + 'ctl';
    this._meta = this._base + 'meta';
    this._epoch = 0;
    this._version = 0;
    /** @type {{id:string,name:string,colorIndex:number,connected:boolean,ready:boolean}[]} */
    this._roster = [];
    this._raceCounter = 0;
    this._raceTimers = [];
    this._timers = new Set();
    this._sync = new ClockSync(8);
    this._lastRtt = NaN;
    this._lastSeen = new Map();
    this._suspect = new Map();
    this._hostGone = false;
    this._lastX = new Map();
    this._span = null;
    this._dnfProvider = null;
    this._pendingFins = new Map();
    this._localBotFins = new Map();
    this._myFinish = null;
    this._ctlGate = new RateGate(20, 40);
    this._stateGate = new RateGate(30, 45);
    this._peerStats = new Map();
    this._peerRtt = new Map();
    this._emitted = { players: '', settings: '', phase: '' };
    this._lastMetaKey = '';
    this._closed = false;
    this._joinedAt = this._clock.now();
    this._wasOffline = false;
    this._statePublishes = 0;

    this._unsubStatus = transport.on('status', (s) => this._onStatus(s));
    this._onPageHide = () => this.leave('pagehide');
    if ((opts.pagehide ?? true) && typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', this._onPageHide);
    }
  }

  /* ------------------------------ public API ------------------------------ */

  get isHost() {
    return this.hostId === this.selfId;
  }

  /** True when the local player is a participant of the current race (additive). */
  get isRacing() {
    return !!this.race && this.race.ids.includes(this.selfId);
  }

  /** Host clock estimate in local time (additive). */
  hostNow() {
    return this._sync.toHost(this._clock.now());
  }

  on(event, cb) {
    return this._em.on(event, cb);
  }

  /**
   * Create a room as host. With MQTT, connections to all brokers are raced and the
   * best-ranked one that connects within ~3 s wins; rejects Error('offline') if none does.
   * @param {{name:string,colorIndex:number}} profile
   * @param {RoomOptions} [opts]
   */
  static async create(profile, opts = {}) {
    const brokers = opts.brokers || BROKERS;
    let transport, code;
    if (opts.transportFactory || opts.net === 'local') {
      code = makeRoomCode(0, brokers);
      transport = makeTransport(opts, code, 0, brokers);
      const selfId = opts.selfId && ID_RE.test(opts.selfId) ? opts.selfId : randomId();
      transport.setLastWill?.(TOPIC_PREFIX + code + '/ctl', { t: 'bye', f: selfId, r: 'lost' });
      try {
        await transport.connect();
      } catch {
        throw new Error('offline');
      }
      opts = { ...opts, selfId };
    } else {
      const selfId = opts.selfId && ID_RE.test(opts.selfId) ? opts.selfId : randomId();
      ({ transport, code } = await raceBrokers(brokers, selfId, opts));
      opts = { ...opts, selfId };
    }
    const room = new Room({ transport, code, profile, opts });
    await room._startAsHost();
    return room;
  }

  /**
   * Join by code. Resolves once the host's roster contains us.
   * Rejects Error('not-found') (bad code / no host answer in ~4 s), Error('full'), or
   * Error('offline') (the code's broker is unreachable from this network).
   * @param {string} code
   * @param {{name:string,colorIndex:number}} profile
   * @param {RoomOptions} [opts]
   */
  static async join(code, profile, opts = {}) {
    const brokers = opts.brokers || BROKERS;
    const c = normalizeCode(code);
    if (!c) throw new Error('not-found');
    const idx = brokerIndexForCode(c, brokers);
    const transport = makeTransport(opts, c, idx, brokers);
    const selfId = opts.selfId && ID_RE.test(opts.selfId) ? opts.selfId : randomId();
    transport.setLastWill?.(TOPIC_PREFIX + c + '/ctl', { t: 'bye', f: selfId, r: 'lost' });
    try {
      await transport.connect();
    } catch {
      try {
        transport.close();
      } catch {
        /* ignore */
      }
      throw new Error('offline');
    }
    const room = new Room({ transport, code: c, profile, opts: { ...opts, selfId } });
    try {
      await room._joinFlow();
    } catch (err) {
      room._shutdown();
      throw err;
    }
    return room;
  }

  setProfile(profile) {
    if (this._closed || !isObj(profile)) return;
    const next = {
      name: 'name' in profile ? sanitizeName(profile.name) : this._profile.name,
      colorIndex: 'colorIndex' in profile ? sanitizeColor(profile.colorIndex) : this._profile.colorIndex,
    };
    this._profile = next;
    if (this.isHost) {
      this._applyProfile(this.selfId, next.name, next.colorIndex);
      this._commit();
    } else this._send('prof', { n: next.name, c: next.colorIndex }, true);
  }

  /** Host only. Invalid values are ignored. */
  setSettings(partial) {
    if (!this.isHost || this._closed) return;
    const s = sanitizeSettings(partial, this.settings);
    if (!s) return;
    this.settings = s;
    this._commit();
  }

  /** Host only, from LOBBY or RESULTS. Everyone (connected) in the roster races. */
  startRace() {
    if (!this.isHost || this._closed) return;
    if (this.phase !== Phase.LOBBY && this.phase !== Phase.RESULTS) return;
    const now = this._clock.now();
    for (const p of this._roster) if (p.connected) p.ready = true;
    const ids = this._roster.filter((p) => p.connected).map((p) => p.id);
    const names = {};
    for (const p of this._roster) names[p.id] = { name: p.name, colorIndex: p.colorIndex };
    this._raceCounter += 1;
    this._newRace({ raceId: this._raceCounter, seed: randomUint32(), settings: { ...this.settings }, goAtLocalMs: now + COUNTDOWN_MS, ids, names });
    this.results = null;
    this._myFinish = null;
    this._pendingFins.clear();
    this._localBotFins.clear();
    this.phase = Phase.COUNTDOWN;
    this._commit({ start: true });
    this._armHostRace();
  }

  /** Unreliable, latest-wins. Dropped (not queued) while offline. */
  sendState(net) {
    if (this._closed || this.status !== 'online' || !validNet(net)) return;
    this._lastX.set(this.selfId, net[1]);
    if (this._t.publish(this._base + 's/' + this.selfId, net, { reliable: false })) this._statePublishes++;
  }

  /**
   * Report a finish. For the local rider (report.id === selfId) it is sent to the host.
   * Bot reports (id 'bot:*') are published only by the host; on other clients they are kept
   * locally and used if this client later becomes host (so the game may call it everywhere).
   */
  reportFinish(report) {
    if (this._closed || !this.race) return;
    const r = sanitizeReport(report);
    if (!r || r.timeMs < 0) return;
    if (r.id === this.selfId) {
      this._myFinish = r;
      if (this.isHost) this._hostAcceptFinish(r, this.selfId);
      else this._send('fin', { rid: this.race.raceId, r }, true);
    } else if (BOT_RE.test(r.id)) {
      if (this.isHost) this._hostAcceptFinish(r, this.selfId);
      else this._localBotFins.set(r.id, r);
    }
  }

  /** Host only → phase LOBBY for everyone (also aborts a running race). */
  backToLobby() {
    if (!this.isHost || this._closed) return;
    this._clearRaceTimers();
    this.race = null;
    this.phase = Phase.LOBBY;
    this._roster = this._roster.filter((p) => p.connected);
    for (const p of this._roster) p.ready = true;
    this._commit();
  }

  /** x of the start and finish lines, used to turn NetState x into progress for DNF ordering (additive). */
  setCourseSpan(startX, finishX) {
    if (fin(startX) && fin(finishX) && finishX > startX) this._span = { startX, finishX };
  }

  /**
   * Additive: fn() → FinishReport[] for riders the room cannot see (bots) that have not
   * finished; called by the host when it builds results. Set it on every client (any may become host).
   */
  setDnfProvider(fn) {
    this._dnfProvider = typeof fn === 'function' ? fn : null;
  }

  /** Additive diagnostics for dev tools. */
  netStats() {
    const now = this._clock.now();
    const peers = {};
    for (const [id, s] of this._peerStats) {
      const iv = s.intervals;
      const mean = iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : NaN;
      const sd = iv.length ? Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length) : NaN;
      const recent = s.times.filter((t) => now - t < 2000).length / 2;
      peers[id] = { rateHz: recent, meanIntervalMs: mean, jitterMs: sd, received: s.count, rttMs: this._peerRtt.get(id) ?? NaN, ageMs: now - s.last };
    }
    return { broker: this.brokerName, rttMs: this.isHost ? 0 : this._lastRtt, minRttMs: this.isHost ? 0 : this._sync.rtt, offsetMs: this._sync.offset, epoch: this._epoch, statesSent: this._statePublishes, peers };
  }

  /** Publish bye, close the transport gracefully (no will), emit 'closed'. */
  leave(reason = 'left') {
    if (this._closed) return;
    const others = this._roster.filter((p) => p.id !== this.selfId && p.connected);
    if (this.isHost && others.length === 0) this._t.publish(this._meta, null, { retain: true, reliable: true });
    this._send('bye', { r: 'leave' }, true);
    this._shutdown();
    this._em.emit('closed', { reason });
  }

  /* ------------------------------ lifecycle ------------------------------ */

  async _subscribeAll() {
    await Promise.all([
      this._t.subscribe(this._ctl, (_t, m) => this._onCtl(m)),
      this._t.subscribe(this._meta, (_t, m) => this._onMeta(m)),
      this._t.subscribe(this._base + 's/+', (topic, m) => this._onState(topic, m)),
    ]);
  }

  async _startAsHost() {
    this.hostId = this.selfId;
    this._epoch = 1;
    this._roster = [{ id: this.selfId, name: this._profile.name, colorIndex: this._profile.colorIndex, connected: true, ready: true }];
    await this._subscribeAll();
    this._startLoops();
    this._commit();
  }

  _joinFlow() {
    return new Promise((resolve, reject) => {
      this._joinWait = { resolve, reject, meta: null };
      const hello = () => this._send('hello', { n: this._profile.name, c: this._profile.colorIndex }, true);
      this._subscribeAll().then(() => {
        if (!this._joinWait) return;
        hello();
        let tries = 0;
        const iv = this._clock.setInterval(() => {
          if (!this._joinWait) return this._clock.clearInterval(iv);
          if (++tries < 5) hello();
        }, this._tm.helloRetryMs);
        this._timers.add({ iv });
        this._after(() => {
          const jw = this._joinWait;
          if (!jw) return;
          this._joinWait = null;
          this._clock.clearInterval(iv);
          jw.reject(new Error(jw.meta && jw.meta.n >= MAX_PLAYERS ? 'full' : 'not-found'));
        }, this._tm.joinTimeoutMs);
      }, () => {
        this._joinWait = null;
        reject(new Error('offline'));
      });
    });
  }

  _joined() {
    const jw = this._joinWait;
    if (!jw) return;
    this._joinWait = null;
    this._joinedAt = this._clock.now();
    this._startLoops();
    this._syncBurst();
    jw.resolve();
  }

  _startLoops() {
    if (this._loopsStarted) return;
    this._loopsStarted = true;
    this._every(() => this._heartbeat(), this._tm.heartbeatMs);
    this._every(() => !this.isHost && this._ping(), this._tm.syncEveryMs);
    this._every(() => this.isHost && this._publishMeta(true), this._tm.metaEveryMs);
  }

  _shutdown() {
    if (this._closed) return;
    this._closed = true;
    this._clearRaceTimers();
    for (const h of this._timers) {
      if (h.iv !== undefined) this._clock.clearInterval(h.iv);
      if (h.to !== undefined) this._clock.clearTimeout(h.to);
    }
    this._timers.clear();
    this._unsubStatus?.();
    if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('pagehide', this._onPageHide);
    try {
      this._t.close();
    } catch {
      /* ignore */
    }
    this.status = 'offline';
  }

  _every(fn, ms) {
    const h = { iv: this._clock.setInterval(() => !this._closed && fn(), ms) };
    this._timers.add(h);
    return h;
  }

  _after(fn, ms) {
    const h = {};
    h.to = this._clock.setTimeout(() => {
      this._timers.delete(h);
      if (!this._closed) fn();
    }, ms);
    this._timers.add(h);
    return h;
  }

  _onStatus(s) {
    if (this._closed) return;
    const prev = this.status;
    this.status = s;
    if (s !== prev) this._em.emit('status', s);
    if (s !== 'online') {
      this._wasOffline = true;
      return;
    }
    if (prev !== 'online' && this._wasOffline) {
      this._wasOffline = false;
      // Reconnected: we heard nobody while away, so restart everyone's liveness clock.
      const now = this._clock.now();
      for (const p of this._roster) this._lastSeen.set(p.id, now);
      this._suspect.clear();
      this._hostGone = false;
      if (this.isHost) {
        this._version++;
        this._broadcastSnapshot();
        this._publishMeta(true);
      } else {
        this._send('hello', { n: this._profile.name, c: this._profile.colorIndex }, true);
        this._syncBurst();
      }
    }
  }

  /* ------------------------------ sending ------------------------------ */

  _send(t, body, reliable) {
    return this._t.publish(this._ctl, { t, f: this.selfId, ...body }, { reliable: !!reliable });
  }

  _snapshotMsg() {
    const r = this.race;
    return {
      e: this._epoch,
      v: this._version,
      ph: this.phase,
      s: this.settings,
      p: this._roster.map((p) => [p.id, p.name, p.colorIndex, p.connected ? 1 : 0, p.ready ? 1 : 0]),
      rc: this._raceCounter,
      race: r ? { id: r.raceId, seed: r.seed, s: r.settings, go: r.goAtLocalMs, ids: r.ids, fin: [...r.finished.values()] } : null,
      res: this.phase === Phase.RESULTS ? this.results : null,
      now: this._clock.now(),
    };
  }

  _broadcastSnapshot() {
    this._send('snap', this._snapshotMsg(), true);
  }

  _publishMeta(force = false) {
    if (!this.isHost) return;
    const meta = { h: this.selfId, e: this._epoch, ph: this.phase, n: this._roster.length, s: this.settings };
    const key = JSON.stringify(meta);
    if (!force && key === this._lastMetaKey) return;
    this._lastMetaKey = key;
    this._t.publish(this._meta, { ...meta, at: Date.now() }, { retain: true, reliable: true });
  }

  /** Host: state changed → version++, local events, snapshot (+ meta when relevant). */
  _commit(flags = {}) {
    this._version++;
    this._emitChanges(flags);
    this._broadcastSnapshot();
    this._publishMeta();
  }

  _emitChanges({ start = false, results = false } = {}) {
    const players = this._roster.map((p) => ({ id: p.id, name: p.name, colorIndex: p.colorIndex, isHost: p.id === this.hostId, connected: p.connected, ready: p.ready }));
    const pk = JSON.stringify(players);
    if (pk !== this._emitted.players) {
      this._emitted.players = pk;
      this.players = players;
      this._em.emit('players', players);
    }
    const sk = JSON.stringify(this.settings);
    if (sk !== this._emitted.settings) {
      this._emitted.settings = sk;
      this._em.emit('settings', { ...this.settings });
    }
    if (start && this.race && this.isRacing) {
      const r = this.race;
      this._em.emit('start', { seed: r.seed, settings: { ...r.settings }, goAtLocalMs: r.goAtLocalMs, raceId: r.raceId });
    }
    if (results && this.results) this._em.emit('results', this.results);
    if (this.phase !== this._emitted.phase) {
      this._emitted.phase = this.phase;
      this._em.emit('phase', this.phase);
    }
  }

  /* ------------------------------ receiving ------------------------------ */

  _touch(id) {
    this._lastSeen.set(id, this._clock.now());
    this._suspect.delete(id);
  }

  _inRoster(id) {
    return this._roster.some((p) => p.id === id);
  }

  _onCtl(m) {
    if (this._closed || !isObj(m) || typeof m.t !== 'string' || !CTL_TYPES.has(m.t) || typeof m.f !== 'string' || !ID_RE.test(m.f)) return;
    const f = m.f;
    if (f === this.selfId) {
      // Our own last will arriving after we reconnected (session takeover): re-announce.
      if (m.t === 'bye' && m.r === 'lost' && this.status === 'online' && !this._joinWait) {
        if (this.isHost) {
          this._version++;
          this._broadcastSnapshot();
        } else this._send('hello', { n: this._profile.name, c: this._profile.colorIndex }, true);
      }
      return;
    }
    const now = this._clock.now();
    if (!this._ctlGate.allow(f, now)) return;
    if (m.t === 'snap') return this._onSnapshot(m);
    if (m.t === 'deny') {
      if (m.to === this.selfId && f === (this._joinWait?.meta?.h || f) && this._joinWait) {
        const jw = this._joinWait;
        this._joinWait = null;
        jw.reject(new Error(m.r === 'full' ? 'full' : 'not-found'));
      }
      return;
    }
    if (this._joinWait) return; // not in the room yet
    const known = this._inRoster(f);
    if (HOST_ONLY.has(m.t) && f !== this.hostId) return;
    if (m.t === 'hello') {
      if (known) this._touch(f);
      if (this.isHost) this._hostHello(f, m);
      return;
    }
    if (!known) return;
    this._touch(f);
    switch (m.t) {
      case 'hb':
        if (fin(m.rtt) && m.rtt >= 0 && m.rtt < 60000) this._peerRtt.set(f, m.rtt);
        if (!this.isHost && f === this.hostId && m.e === this._epoch && Number.isInteger(m.v) && m.v > this._version) {
          this._send('hello', { n: this._profile.name, c: this._profile.colorIndex }, true); // missed an update
        }
        if (this.isHost) this._hostMarkAlive(f);
        break;
      case 'prof':
        if (this.isHost) {
          this._applyProfile(f, m.n, m.c);
          this._commit();
        }
        break;
      case 'ping':
        if (this.isHost && m.to === this.selfId && fin(m.a)) this._send('pong', { to: f, a: m.a, b: now }, false);
        break;
      case 'pong':
        if (m.to === this.selfId && fin(m.a) && fin(m.b) && this._sync.addSample(m.a, m.b, now)) this._lastRtt = now - m.a;
        break;
      case 'fin':
        this._onFin(f, m);
        break;
      case 'fok':
        this._onFok(m);
        break;
      case 'bye':
        this._onBye(f, m.r === 'lost' ? 'lost' : 'leave');
        break;
    }
  }

  _onMeta(m) {
    if (this._closed || (m !== null && !isObj(m))) return;
    if (this._joinWait) {
      if (m && typeof m.h === 'string' && Number.isInteger(m.n)) this._joinWait.meta = m;
      return;
    }
    // Another (older) host overwrote the retained meta → restore ours.
    if (this.isHost && (m === null || m.h !== this.selfId || m.e !== this._epoch) && !(m && Number.isInteger(m.e) && m.e > this._epoch)) {
      this._publishMeta(true);
    }
  }

  _onState(topic, net) {
    if (this._closed || this._joinWait) return;
    const id = topic.slice(topic.lastIndexOf('/') + 1);
    if (id === this.selfId || !ID_RE.test(id) || !this._inRoster(id) || !validNet(net)) return;
    const now = this._clock.now();
    if (!this._stateGate.allow(id, now)) return;
    this._touch(id);
    if (this.isHost) this._hostMarkAlive(id);
    this._lastX.set(id, net[1]);
    let s = this._peerStats.get(id);
    if (!s) this._peerStats.set(id, (s = { count: 0, last: now, intervals: [], times: [] }));
    if (s.count > 0) {
      s.intervals.push(now - s.last);
      if (s.intervals.length > 60) s.intervals.shift();
    }
    s.times.push(now);
    while (s.times.length && now - s.times[0] > 2000) s.times.shift();
    s.count++;
    s.last = now;
    this._em.emit('state', { id, net, recvMs: now });
  }

  /** Validate a snapshot and decide whether it comes from the legitimate host. */
  _onSnapshot(m) {
    const f = m.f;
    if (!Number.isInteger(m.e) || m.e < 1 || !Number.isInteger(m.v) || !PHASES.has(m.ph) || m.ph === Phase.HOME) return;
    if (!Array.isArray(m.p) || m.p.length < 1 || m.p.length > MAX_PLAYERS) return;
    const roster = [];
    const seen = new Set();
    for (const e of m.p) {
      if (!Array.isArray(e) || e.length !== 5 || typeof e[0] !== 'string' || !ID_RE.test(e[0]) || seen.has(e[0])) return;
      seen.add(e[0]);
      roster.push({ id: e[0], name: sanitizeName(e[1]), colorIndex: sanitizeColor(e[2]), connected: !!e[3], ready: !!e[4] });
    }
    if (!seen.has(f)) return;
    const settings = sanitizeSettings(m.s);
    if (!settings) return;
    let race = null;
    if (m.race !== null && m.race !== undefined) {
      const r = m.race;
      if (!isObj(r) || !Number.isInteger(r.id) || r.id < 1 || !Number.isInteger(r.seed) || !fin(r.go) || !Array.isArray(r.ids) || r.ids.length > MAX_PLAYERS) return;
      const rs = sanitizeSettings(r.s);
      if (!rs || !r.ids.every((id) => typeof id === 'string' && ID_RE.test(id))) return;
      const fins = [];
      if (Array.isArray(r.fin) && r.fin.length <= 32) {
        for (const x of r.fin) {
          const c = sanitizeReport(x);
          if (c && c.timeMs >= 0) fins.push(c);
        }
      }
      race = { raceId: r.id, seed: r.seed >>> 0, settings: rs, goHost: r.go, ids: r.ids.slice(), fin: fins };
    }
    const results = m.res ? sanitizeResults(m.res) : null;

    // --- authority ---
    if (this._joinWait) {
      const mh = this._joinWait.meta?.h;
      if (mh && mh !== f && this._joinWait.meta.e >= m.e) return;
    } else if (f !== this.hostId) {
      if (!this._inRoster(f)) return; // only a known member may claim the room
      const newer = m.e > this._epoch && m.e <= this._epoch + 5;
      const tie = m.e === this._epoch && f < this.hostId;
      if (!newer && !tie) {
        if (this.isHost && m.e <= this._epoch) {
          this._version++;
          this._broadcastSnapshot(); // remind the stale claimant who is host
        }
        return;
      }
    } else if (m.e < this._epoch || (m.e === this._epoch && m.v <= this._version)) return;

    const wasHost = this.isHost;
    const hostChanged = f !== this.hostId;
    if (wasHost) this._clearRaceTimers(); // demoted
    if (hostChanged) {
      this._sync.reset();
      this._hostGone = false;
    }
    this.hostId = f;
    this._epoch = m.e;
    this._version = m.v;
    this._roster = roster;
    this.settings = settings;
    if (Number.isInteger(m.rc)) this._raceCounter = Math.max(this._raceCounter, m.rc);
    this._touch(f);
    this._hostGone = false;
    if (fin(m.now)) this._sync.setRough(m.now - (this._clock.now() - 80)); // assume ~80 ms one-way until ping/pong

    let start = false;
    if (race) {
      if (!this.race || this.race.raceId !== race.raceId) {
        const names = {};
        for (const p of roster) names[p.id] = { name: p.name, colorIndex: p.colorIndex };
        this._newRace({ ...race, goAtLocalMs: this._sync.toLocal(race.goHost), names });
        start = m.ph === Phase.COUNTDOWN || m.ph === Phase.RACING;
        this._myFinish = null;
        this._pendingFins.clear();
        this._localBotFins.clear();
      } else {
        this.race.ids = race.ids;
      }
    } else if (m.ph === Phase.LOBBY) {
      this._clearRaceTimers();
      this.race = null;
    }

    let resultsNew = false;
    if (results && m.ph === Phase.RESULTS && (!this.results || this.results.raceId !== results.raceId)) {
      this.results = results;
      resultsNew = true;
    }
    // Keep the local GO transition: never jump to RACING before our own GO time.
    let ph = m.ph;
    if (ph === Phase.RACING && this.race && this._clock.now() < this.race.goAtLocalMs) ph = Phase.COUNTDOWN;
    this.phase = ph;
    if (this.race) {
      this._armLocalGo();
      if (race) for (const rep of race.fin) if (!this.race.finished.has(rep.id)) this._recordFinish(rep);
    }

    const joining = !!this._joinWait;
    const inRoster = this._inRoster(this.selfId);
    if (joining && !inRoster) return; // not acknowledged yet — wait (hello retries)
    if (joining) this._joined();
    this._emitChanges({ start, results: resultsNew });
    if (!joining && !inRoster && this.status === 'online') {
      this._send('hello', { n: this._profile.name, c: this._profile.colorIndex }, true);
    }
    if (hostChanged && !joining) {
      this._syncBurst();
      // The new host may not have seen our finish.
      if (this._myFinish && this.race && !this.race.finished.has(this.selfId)) this._send('fin', { rid: this.race.raceId, r: this._myFinish }, true);
    }
  }

  _newRace(r) {
    this._clearRaceTimers();
    this.race = { raceId: r.raceId, seed: r.seed, settings: r.settings, goAtLocalMs: r.goAtLocalMs, ids: r.ids, names: r.names, finished: new Map(), firstFinishLocal: NaN };
    this._lastX.clear();
    this._armLocalGo();
  }

  _armLocalGo() {
    const r = this.race;
    if (!r || r._goArmed) return;
    r._goArmed = true;
    const fire = () => {
      if (this.race !== r || this.phase !== Phase.COUNTDOWN) return;
      this.phase = Phase.RACING;
      if (this.isHost) this._commit();
      else this._emitChanges();
    };
    const dt = r.goAtLocalMs - this._clock.now();
    if (dt <= 0) queueMicrotask(fire);
    else this._raceTimers.push(this._clock.setTimeout(fire, dt));
  }

  _clearRaceTimers() {
    for (const h of this._raceTimers) this._clock.clearTimeout(h);
    this._raceTimers = [];
    if (this.race) this.race._goArmed = false;
  }

  /* ------------------------------ host logic ------------------------------ */

  _dedupeName(name, id) {
    const taken = new Set(this._roster.filter((p) => p.id !== id).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let k = 2; k < 100; k++) {
      const suffix = ' ' + k;
      const base = [...name].slice(0, NAME_MAX - suffix.length).join('').trim();
      const cand = base + suffix;
      if (!taken.has(cand.toLowerCase())) return cand;
    }
    return name;
  }

  _applyProfile(id, n, c) {
    const p = this._roster.find((x) => x.id === id);
    if (!p) return;
    p.name = this._dedupeName(sanitizeName(n), id);
    p.colorIndex = sanitizeColor(c);
  }

  _hostHello(f, m) {
    const existing = this._roster.find((p) => p.id === f);
    if (existing) {
      existing.connected = true;
      this._applyProfile(f, m.n, m.c);
      this._commit(); // always resend: the sender is asking for the snapshot
      this._checkEnd();
      return;
    }
    if (this._roster.length >= MAX_PLAYERS && (this.phase === Phase.LOBBY || this.phase === Phase.RESULTS)) {
      this._roster = this._roster.filter((p) => p.connected); // make room by dropping ghosts
    }
    if (this._roster.length >= MAX_PLAYERS) {
      this._send('deny', { to: f, r: 'full' }, true);
      return;
    }
    this._roster.push({ id: f, name: this._dedupeName(sanitizeName(m.n), f), colorIndex: sanitizeColor(m.c), connected: true, ready: this.phase === Phase.LOBBY });
    if (this.race) this.race.names[f] = { name: this._roster.at(-1).name, colorIndex: this._roster.at(-1).colorIndex };
    this._touch(f);
    this._commit();
  }

  _hostMarkAlive(id) {
    const p = this._roster.find((x) => x.id === id);
    if (p && !p.connected) {
      p.connected = true;
      this._commit();
    }
  }

  _onBye(f, kind) {
    if (kind === 'lost') {
      this._suspect.set(f, this._clock.now());
      this._after(() => this._heartbeat(true), this._tm.suspectMs + 10);
      return;
    }
    // explicit leave
    this._lastSeen.set(f, -Infinity);
    if (f === this.hostId) {
      this._hostGone = true;
      this._elect();
      return;
    }
    if (this.isHost) {
      const inRace = this.phase === Phase.COUNTDOWN || this.phase === Phase.RACING;
      if (inRace) {
        const p = this._roster.find((x) => x.id === f);
        if (p) p.connected = false;
      } else this._roster = this._roster.filter((p) => p.id !== f);
      this._commit();
      this._checkEnd();
    }
  }

  _isDead(id, now) {
    if (id === this.selfId) return false;
    const seen = this._lastSeen.get(id) ?? this._joinedAt;
    if (now - seen > this._tm.staleMs) return true;
    const sus = this._suspect.get(id);
    return sus !== undefined && now - sus >= this._tm.suspectMs;
  }

  /** Periodic: heartbeat + liveness (+ host election when the host is gone). */
  _heartbeat(checkOnly = false) {
    if (this._closed || this.status !== 'online' || this._joinWait) return;
    const now = this._clock.now();
    if (!checkOnly) {
      const hb = { rtt: this.isHost ? 0 : fin(this._lastRtt) ? Math.round(this._lastRtt) : -1 };
      if (this.isHost) Object.assign(hb, { e: this._epoch, v: this._version, ph: this.phase });
      this._send('hb', hb, false);
    }
    if (this.isHost) {
      let changed = false;
      const lobbyish = this.phase === Phase.LOBBY || this.phase === Phase.RESULTS;
      for (const p of this._roster) {
        if (p.id === this.selfId) continue;
        if (p.connected && this._isDead(p.id, now)) {
          p.connected = false;
          changed = true;
        }
      }
      if (lobbyish) {
        const before = this._roster.length;
        this._roster = this._roster.filter((p) => p.connected || now - (this._lastSeen.get(p.id) ?? 0) < this._tm.removeMs);
        changed = changed || before !== this._roster.length;
      }
      if (changed) this._commit();
      this._checkEnd();
    } else {
      if (this._hostGone || this._isDead(this.hostId, now)) this._elect();
      if (!this._inRoster(this.selfId) && !checkOnly) this._send('hello', { n: this._profile.name, c: this._profile.colorIndex }, true);
    }
  }

  /** Deterministic successor: first live player in join order, excluding the dead host. */
  _elect() {
    if (this.isHost || this.status !== 'online' || this._closed) return;
    this._hostGone = true;
    const now = this._clock.now();
    const cand = this._roster.find((p) => p.id !== this.hostId && (p.id === this.selfId || (p.connected && !this._isDead(p.id, now))));
    if (cand && cand.id === this.selfId) this._becomeHost();
  }

  _becomeHost() {
    const old = this.hostId;
    const now = this._clock.now();
    this.hostId = this.selfId;
    this._epoch += 1;
    this._hostGone = false;
    this._sync.reset();
    const oldP = this._roster.find((p) => p.id === old);
    if (oldP) oldP.connected = false;
    if ((this.phase === Phase.LOBBY || this.phase === Phase.RESULTS) && this._lastSeen.get(old) === -Infinity) {
      this._roster = this._roster.filter((p) => p.id !== old);
    }
    for (const p of this._roster) {
      if (p.id === this.selfId) {
        p.connected = true;
        continue;
      }
      if (this._isDead(p.id, now)) p.connected = false;
      if (!this._lastSeen.has(p.id)) this._lastSeen.set(p.id, now);
    }
    // Take over a running race: everything we saw becomes authoritative now.
    if (this.race && (this.phase === Phase.COUNTDOWN || this.phase === Phase.RACING)) {
      for (const r of this._localBotFins.values()) this._hostAcceptFinish(r, this.selfId, true);
      for (const { r, from } of this._pendingFins.values()) this._hostAcceptFinish(r, from, true);
      if (this._myFinish) this._hostAcceptFinish(this._myFinish, this.selfId, true);
      this._armHostRace();
    }
    this._commit();
    this._publishMeta(true);
    this._checkEnd();
  }

  _armHostRace() {
    const r = this.race;
    if (!r) return;
    this._armLocalGo();
    const now = this._clock.now();
    const cap = this._tm.capMs[r.settings.length] ?? this._tm.capMs.classic;
    this._raceTimers.push(this._clock.setTimeout(() => this._endRace('cap'), Math.max(0, r.goAtLocalMs + cap - now)));
    if (Number.isFinite(r.firstFinishLocal)) this._armGrace();
  }

  _armGrace() {
    const r = this.race;
    if (!r || r._graceArmed || !this.isHost) return;
    r._graceArmed = true;
    const dt = Math.max(0, r.firstFinishLocal + this._tm.graceMs - this._clock.now());
    this._raceTimers.push(this._clock.setTimeout(() => this._endRace('grace'), dt));
  }

  /** Non-host: a raw finish report seen on ctl (kept in case we become host). */
  _onFin(f, m) {
    if (!this.race || m.rid !== this.race.raceId) return;
    const r = sanitizeReport(m.r);
    if (!r) return;
    if (this.isHost) this._hostAcceptFinish(r, f);
    else if (!this._pendingFins.has(r.id)) this._pendingFins.set(r.id, { r, from: f });
  }

  /** Host acceptance rules for a FinishReport. */
  _hostAcceptFinish(r, from, quiet = false) {
    const race = this.race;
    if (!race || !this.isHost || (this.phase !== Phase.COUNTDOWN && this.phase !== Phase.RACING)) return;
    if (race.finished.has(r.id) || r.timeMs < this._tm.minFinishMs) return;
    const cap = this._tm.capMs[race.settings.length] ?? this._tm.capMs.classic;
    if (r.timeMs > cap + 60000) return;
    let rep;
    if (BOT_RE.test(r.id)) {
      if (from !== this.selfId) return; // bots only from the host's own client
      rep = { ...r, progress: 1 };
    } else {
      if (r.id !== from || !race.ids.includes(r.id)) return;
      const who = race.names[r.id] || this._roster.find((p) => p.id === r.id) || r;
      rep = { ...r, name: who.name, colorIndex: who.colorIndex, progress: 1 };
    }
    this._recordFinish(rep);
    this._send('fok', { rid: race.raceId, r: rep }, true);
    if (!quiet) this._checkEnd();
  }

  _recordFinish(rep) {
    const race = this.race;
    if (race.finished.has(rep.id)) return;
    race.finished.set(rep.id, rep);
    if (!Number.isFinite(race.firstFinishLocal)) {
      race.firstFinishLocal = this._clock.now();
      this._armGrace();
    }
    this._em.emit('finish', rep);
  }

  _onFok(m) {
    if (!this.race || m.rid !== this.race.raceId) return;
    const r = sanitizeReport(m.r);
    if (!r || r.timeMs < 0) return;
    this._recordFinish(r);
  }

  _checkEnd() {
    const race = this.race;
    if (!this.isHost || !race || (this.phase !== Phase.COUNTDOWN && this.phase !== Phase.RACING)) return;
    const now = this._clock.now();
    const connected = new Set(this._roster.filter((p) => p.connected).map((p) => p.id));
    const humansLeft = race.ids.filter((id) => connected.has(id) && !race.finished.has(id));
    if (humansLeft.length > 0) return;
    const botsDone = [...race.finished.keys()].filter((id) => BOT_RE.test(id)).length >= (race.settings.bots || 0);
    const anyFinished = race.finished.size > 0;
    // Everyone still connected is done. Wait for outstanding bots (bounded by the grace timer).
    if (botsDone || !anyFinished || now - race.firstFinishLocal >= this._tm.graceMs) this._endRace('all');
  }

  _endRace(reason) {
    const race = this.race;
    if (!this.isHost || !race || (this.phase !== Phase.COUNTDOWN && this.phase !== Phase.RACING)) return;
    this._clearRaceTimers();
    const finishers = [...race.finished.values()].sort((a, b) => a.timeMs - b.timeMs);
    const dnfs = [];
    const span = this._span;
    for (const id of race.ids) {
      if (race.finished.has(id)) continue;
      const who = race.names[id] || { name: 'Rider', colorIndex: 0 };
      const x = this._lastX.get(id);
      const progress = span && fin(x) ? clamp((x - span.startX) / (span.finishX - span.startX), 0, 1) : 0;
      dnfs.push({ id, name: who.name, colorIndex: who.colorIndex, timeMs: -1, progress, stats: emptyStats() });
    }
    if (this._dnfProvider) {
      let extra = [];
      try {
        extra = this._dnfProvider() || [];
      } catch (err) {
        console.error('[snowline] dnf provider failed', err);
      }
      for (const e of Array.isArray(extra) ? extra.slice(0, 16) : []) {
        const r = sanitizeReport({ ...e, timeMs: -1 });
        if (r && BOT_RE.test(r.id) && !race.finished.has(r.id) && !dnfs.some((d) => d.id === r.id)) dnfs.push(r);
      }
    }
    dnfs.sort((a, b) => b.progress - a.progress);
    this.results = { raceId: race.raceId, seed: race.seed, settings: { ...race.settings }, ranking: [...finishers, ...dnfs], reason };
    this.phase = Phase.RESULTS;
    for (const p of this._roster) p.ready = false;
    this._commit({ results: true });
  }

  _syncBurst() {
    for (let i = 0; i < 5; i++) this._after(() => this._ping(), 50 + i * 200);
  }

  _ping() {
    if (this.isHost || !this.hostId || this.status !== 'online') return;
    this._send('ping', { to: this.hostId, a: this._clock.now() }, false);
  }
}

/* ------------------------------ transport selection ------------------------------ */

function makeTransport(opts, code, idx, brokers) {
  if (opts.transportFactory) return opts.transportFactory(code, idx);
  if (opts.net === 'local') return new LoopbackTransport({ hub: opts.hub || LoopbackHub.shared });
  return new MqttTransport({ broker: brokers[idx], timeoutMs: opts.timing?.connectTimeoutMs ?? NET_TIMING.connectTimeoutMs });
}

/**
 * Connect to every broker at once; take the best-ranked one that is up within
 * createRaceMs (or the first to connect after that, up to connectTimeoutMs + 2 s).
 */
function raceBrokers(brokers, selfId, opts) {
  const waitBest = opts.timing?.createRaceMs ?? NET_TIMING.createRaceMs;
  const hardMs = (opts.timing?.connectTimeoutMs ?? NET_TIMING.connectTimeoutMs) + 2000;
  return new Promise((resolve, reject) => {
    const state = brokers.map(() => 'pending');
    const entries = brokers.map((b, i) => {
      const code = makeRoomCode(i, brokers);
      const t = new MqttTransport({ broker: b, timeoutMs: hardMs - 500 });
      t.setLastWill(TOPIC_PREFIX + code + '/ctl', { t: 'bye', f: selfId, r: 'lost' });
      return { t, code };
    });
    let done = false;
    let deadlinePassed = false;
    const finish = (i) => {
      done = true;
      clearTimeout(t1);
      clearTimeout(t2);
      entries.forEach((e, j) => j !== i && e.t.close());
      if (i < 0) reject(new Error('offline'));
      else resolve({ transport: entries[i].t, code: entries[i].code });
    };
    const decide = () => {
      if (done) return;
      for (let i = 0; i < state.length; i++) {
        if (state[i] === 'up') return finish(i);
        if (state[i] === 'pending' && !deadlinePassed) return; // a better one may still come
      }
      if (state.every((s) => s === 'failed')) finish(-1);
    };
    const t1 = setTimeout(() => {
      deadlinePassed = true;
      decide();
    }, waitBest);
    const t2 = setTimeout(() => !done && finish(-1), hardMs);
    entries.forEach((e, i) =>
      e.t.connect().then(
        () => {
          state[i] = 'up';
          decide();
        },
        () => {
          state[i] = 'failed';
          decide();
        },
      ),
    );
  });
}
