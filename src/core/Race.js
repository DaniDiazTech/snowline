/**
 * Race — one run down one course, as seen by this client.
 *
 * Owns the local RiderSim (the only rider this client is authoritative for),
 * the deterministic bots, and the ghosts of remote players. It advances the
 * simulation on the fixed tick, and turns everything into RiderViews for the
 * renderer and rows for the HUD. It knows nothing about rooms or the DOM.
 */
import { PLAYER_COLORS, RiderMode, SimEvent, TICK_MS } from '../contracts.js';
import { generateCourse } from '../world/Course.js';
import { RiderSim } from '../sim/RiderSim.js';
import { Bot } from '../sim/Bot.js';
import { encodeNetState } from '../sim/netState.js';
import { clamp, lerp } from '../math/utils.js';
import { Ghost } from './Ghost.js';

const BOT_NAMES = ['Maya', 'Paz', 'Izel', 'Felipe', 'Tupa', 'Sumara'];
const BOT_COLORS = [8, 4, 1, 6, 3, 10];
const BOT_SKILLS = [0.55, 0.3, 0.75, 0.42, 0.65, 0.2];
/** Never simulate more than this per frame; a longer backlog is spread over the next frames. */
const MAX_TICKS_PER_FRAME = 240;
const START_SLOT_PX = 30;

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** A simulated rider (local or bot) plus the previous tick's pose for render interpolation. */
class Runner {
  constructor(id, name, colorIndex, course, isLocal) {
    this.id = id;
    this.name = name;
    this.colorIndex = colorIndex;
    this.isLocal = isLocal;
    this.sim = new RiderSim(course);
    this.bot = null;
    this.prev = { x: this.sim.state.x, y: this.sim.state.y, angle: this.sim.state.angle };
    this.reported = false;
  }

  step(input) {
    const s = this.sim.state;
    this.prev.x = s.x;
    this.prev.y = s.y;
    this.prev.angle = s.angle;
    return this.sim.step(input);
  }

  view(alpha, slot) {
    const s = this.sim.state;
    // A respawn teleports the rider: don't sweep it across the screen for one tick.
    const jumped = Math.abs(s.x - this.prev.x) > 120 || Math.abs(s.y - this.prev.y) > 120;
    const a = jumped ? 1 : alpha;
    const idle = s.mode === RiderMode.IDLE;
    return {
      id: this.id,
      name: this.name,
      color: PLAYER_COLORS[this.colorIndex] ?? PLAYER_COLORS[0],
      isLocal: this.isLocal,
      x: lerp(this.prev.x, s.x, a) - (idle ? slot * START_SLOT_PX : 0),
      y: lerp(this.prev.y, s.y, a),
      vx: s.vx,
      vy: s.vy,
      angle: lerpAngle(this.prev.angle, s.angle, a),
      mode: s.mode,
      crouch: s.crouch,
      scarf: s.scarf,
      boostLevel: s.boostT > 0 ? s.boostLevel : 0,
      shield: s.shield,
      hover: s.hoverT > 0,
    };
  }

  report() {
    const s = this.sim.state;
    return {
      id: this.id,
      name: this.name,
      colorIndex: this.colorIndex,
      timeMs: s.finishTick >= 0 ? Math.round(s.finishTick * TICK_MS) : -1,
      progress: clamp(s.progress, 0, 1),
      stats: { ...s.stats },
    };
  }
}

export class Race {
  /**
   * @param {Object} o
   * @param {number} o.seed
   * @param {import('../contracts.js').RaceSettings} o.settings
   * @param {number} o.goAtMs                 performance.now() time of GO
   * @param {{id:string,name:string,colorIndex:number}} o.self
   * @param {Array<{id:string,name:string,colorIndex:number}>} [o.remotes]  other human players
   * @param {boolean} [o.autopilot]           drive the local rider with a Bot (tests, attract mode)
   */
  constructor({ seed, settings, goAtMs, self, remotes = [], autopilot = false }) {
    this.seed = seed;
    this.settings = settings;
    this.goAtMs = goAtMs;
    this.course = generateCourse(seed, settings);
    this.local = new Runner(self.id, self.name, self.colorIndex, this.course, true);
    if (autopilot) this.local.bot = new Bot(this.course, seed ^ 0x51ed, autopilot === true ? 0.8 : autopilot);
    this.bots = [];
    for (let i = 0; i < clamp(settings.bots | 0, 0, 6); i++) {
      const runner = new Runner(`bot:${i}`, BOT_NAMES[i], BOT_COLORS[i], this.course, false);
      runner.bot = new Bot(this.course, (seed + 7919 * (i + 1)) >>> 0, BOT_SKILLS[i]);
      this.bots.push(runner);
    }
    /** @type {Map<string, {info:Object, ghost:Ghost}>} */
    this.remotes = new Map();
    for (const info of remotes) this.remotes.set(info.id, { info, ghost: new Ghost() });
    this.started = false;
    /** ticks simulated since GO (keeps counting after the local rider finishes) */
    this.tick = 0;
    this.held = false;
    this.alpha = 1;
    /** local events since the last drain() */
    this.events = [];
    /** FinishReports of bots that crossed the line since the last drain */
    this.botFinishes = [];
    /** id → timeMs of every finish we know about (ours, bots, remote) */
    this.finishTimes = new Map();
  }

  get state() {
    return this.local.sim.state;
  }

  get finished() {
    return this.state.finishTick >= 0;
  }

  /** Race clock in ms (0 during the countdown). */
  get timeMs() {
    return this.tick * TICK_MS;
  }

  setInput(held) {
    this.held = held;
  }

  addRemote(info) {
    if (!this.remotes.has(info.id)) this.remotes.set(info.id, { info, ghost: new Ghost() });
    else this.remotes.get(info.id).info = info;
  }

  removeRemote(id) {
    this.remotes.delete(id);
  }

  pushRemoteState(id, net, recvMs) {
    this.remotes.get(id)?.ghost.push(net, recvMs);
  }

  noteFinish(id, timeMs) {
    if (timeMs >= 0) this.finishTimes.set(id, timeMs);
  }

  /** Advances the simulation to `nowMs`. Returns the number of ticks run. */
  update(nowMs) {
    if (nowMs < this.goAtMs) return 0;
    if (!this.started) {
      this.started = true;
      this.local.sim.start();
      for (const b of this.bots) b.sim.start();
    }
    const elapsed = nowMs - this.goAtMs;
    const target = Math.floor(elapsed / TICK_MS);
    const due = target - this.tick;
    const n = Math.min(due, MAX_TICKS_PER_FRAME);
    for (let i = 0; i < n; i++) {
      this.tick++;
      const input = this.local.bot ? this.local.bot.decide(this.state) : { held: this.held };
      const events = this.local.step(input);
      for (const e of events) {
        this.events.push(e);
        if (e.type === SimEvent.FINISH) this.finishTimes.set(this.local.id, Math.round(e.data.timeMs));
      }
      for (const b of this.bots) {
        const was = b.sim.state.finishTick;
        b.step(b.bot.decide(b.sim.state));
        if (was < 0 && b.sim.state.finishTick >= 0) {
          const report = b.report();
          this.finishTimes.set(b.id, report.timeMs);
          this.botFinishes.push(report);
        }
      }
    }
    this.alpha = due > n ? 1 : clamp(elapsed / TICK_MS - target, 0, 1);
    return n;
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  drainBotFinishes() {
    const out = this.botFinishes;
    this.botFinishes = [];
    return out;
  }

  netState() {
    return encodeNetState(this.state);
  }

  localReport() {
    return this.local.report();
  }

  /** DNF reports for bots that have not finished (the room cannot see bots). */
  botDnfReports() {
    return this.bots.filter((b) => b.sim.state.finishTick < 0).map((b) => b.report());
  }

  /** RiderViews for the renderer. `slots` maps id → start-line slot. */
  views(nowMs, slots) {
    const local = this.local.view(this.alpha, slots.get(this.local.id) ?? 0);
    const others = [];
    for (const b of this.bots) others.push(b.view(this.alpha, slots.get(b.id) ?? 0));
    for (const [id, { info, ghost }] of this.remotes) {
      const pose = ghost.sample(nowMs, this.course);
      if (!pose) continue;
      if (pose.mode === RiderMode.IDLE) pose.x -= (slots.get(id) ?? 0) * START_SLOT_PX;
      others.push({ id, name: info.name, color: PLAYER_COLORS[info.colorIndex] ?? PLAYER_COLORS[0], isLocal: false, ...pose });
    }
    return { local, others };
  }

  /** Everyone's progress, for the HUD track and the live position. */
  standings() {
    const { startX, length } = this.course;
    const rows = [
      { id: this.local.id, name: this.local.name, color: PLAYER_COLORS[this.local.colorIndex], progress: clamp(this.state.progress, 0, 1), isLocal: true, finished: this.finished },
    ];
    for (const b of this.bots) {
      rows.push({ id: b.id, name: b.name, color: PLAYER_COLORS[b.colorIndex], progress: clamp(b.sim.state.progress, 0, 1), isLocal: false, finished: b.sim.state.finishTick >= 0 });
    }
    for (const [id, { info, ghost }] of this.remotes) {
      const finished = this.finishTimes.has(id);
      rows.push({ id, name: info.name, color: PLAYER_COLORS[info.colorIndex] ?? PLAYER_COLORS[0], progress: finished ? 1 : clamp((ghost.x - startX) / length, 0, 1), isLocal: false, finished });
    }
    return rows;
  }

  /** 1-based live position of the local rider. */
  position(rows = this.standings()) {
    const mine = this.finishTimes.get(this.local.id);
    let ahead = 0;
    for (const r of rows) {
      if (r.isLocal) continue;
      const theirs = this.finishTimes.get(r.id);
      if (mine !== undefined) {
        if (theirs !== undefined && theirs < mine) ahead++;
      } else if (theirs !== undefined || r.progress > rows[0].progress) ahead++;
    }
    return ahead + 1;
  }

  /** Results built locally (practice runs, where there is no room/host). */
  localResults(raceId = 1) {
    const reports = [this.local.report(), ...this.bots.map((b) => b.report())];
    const done = reports.filter((r) => r.timeMs >= 0).sort((a, b) => a.timeMs - b.timeMs);
    const dnf = reports.filter((r) => r.timeMs < 0).sort((a, b) => b.progress - a.progress);
    return { raceId, seed: this.seed, settings: this.settings, ranking: [...done, ...dnf] };
  }
}
