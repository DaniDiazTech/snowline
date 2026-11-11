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
/**
 * Catch-up policy. A slow frame (or a machine that is busy for a while) is caught up quickly: at least
 * half of the backlog runs every frame, so the race never drifts behind the clock. A stall longer than
 * MAX_TICKS_PER_FRAME (a hidden tab) runs on a time budget instead, spread over a few frames rather
 * than freezing one frame for hundreds of milliseconds, and is flagged as a silent catch-up.
 */
const CATCHUP_FREE_TICKS = 8;
const CATCHUP_BUDGET_MS = 10;
/** A backlog this long (1 s) is a stall: its events are not replayed as sounds and toasts. */
const SILENT_BACKLOG_TICKS = 60;
/**
 * Catch-up assist (RiderInput.assist): riders well behind the leader get a small cruise bonus. 0 for the
 * leader, ramping from 0 at 4% of the course behind to 1 at 7% behind, and 0 in the last 10% of the
 * course so the finish is earned. Deterministic per tick for the local rider and the bots (it only reads
 * the riders' progress as this client sees it).
 */
const ASSIST_FROM = 0.04;
const ASSIST_FULL = 0.07;
const ASSIST_END = 0.9;
export function assistFor(progress, leader) {
  if (progress >= ASSIST_END) return 0;
  return clamp((leader - progress - ASSIST_FROM) / (ASSIST_FULL - ASSIST_FROM), 0, 1);
}
/** Ticks after GO at which the "started Nth" position is taken (the start grid has spread out by then). */
const START_POS_TICK = 90;
const clockNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const START_SLOT_PX = 30;
/** After GO the start-line stagger melts away over this long instead of snapping. */
const SLOT_FADE_MS = 700;
const slotFade = (idle, raceMs) => (idle ? 1 : clamp(1 - raceMs / SLOT_FADE_MS, 0, 1));

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
      x: lerp(this.prev.x, s.x, a) - slot * START_SLOT_PX * slotFade(idle, s.tick * TICK_MS),
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
    if (autopilot) {
      // Seeded per rider so several autopilots in one room do not ride identically.
      let h = seed ^ 0x51ed;
      for (const ch of self.id) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
      this.local.bot = new Bot(this.course, h, autopilot === true ? 0.8 : autopilot);
    }
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
    /** timestamped button edges not yet consumed by the simulation: [{t, held}] */
    this.inputQueue = [];
    this.alpha = 1;
    /** true while a backlog bigger than a slow frame is being caught up (Game keeps that silent) */
    this.catchingUp = false;
    /** local events since the last drain() */
    this.events = [];
    /** FinishReports of bots that crossed the line since the last drain */
    this.botFinishes = [];
    /** id → timeMs of every finish we know about (ours, bots, remote) */
    this.finishTimes = new Map();
    /** catch-up assist on (RaceSettings.catchUp, default on) and the local rider's current value */
    this.catchUp = settings.catchUp !== false;
    this.localAssist = 0;
    /** remote riders' leading progress, refreshed once per update() (ghost data changes per frame, not per tick) */
    this.remoteLead = 0;
    /** id → {start, best, worst, last} positions as this client sees them (for the results awards) */
    this.positions = new Map();
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

  /**
   * Button edge at time `t` (performance.now() timebase; pass the DOM event's timeStamp). Edges are
   * replayed at the tick they happened on, so a slow frame can neither stretch a tap into a hold nor
   * swallow it. An edge older than the last simulated tick goes to the next one (never lost).
   */
  setInput(held, t = clockNow()) {
    const q = this.inputQueue;
    // Keep the queue ordered even if timestamps from different sources disagree slightly.
    const last = q.length ? q[q.length - 1].t : -Infinity;
    q.push({ t: Number.isFinite(t) ? Math.max(t, last) : Math.max(clockNow(), last), held: !!held });
  }

  /** Button state for the tick that ends at `tickEndMs`. */
  inputAt(tickEndMs) {
    const q = this.inputQueue;
    let pressed = false;
    while (q.length && q[0].t <= tickEndMs) {
      const edge = q.shift();
      if (edge.held && !this.held) pressed = true;
      this.held = edge.held;
    }
    // Down and up inside the same tick: still one tick of "held".
    return this.held || pressed;
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

  /**
   * Advances the simulation to `nowMs`. Returns the number of ticks run.
   *
   * The tick that *contains* `nowMs` is simulated (tick n covers ((n-1)·T, n·T] after GO), not only the
   * last completed one: a press that arrived before this frame is applied in this frame, and the drawn
   * pose (interpolated between the last two ticks) is the pose at `nowMs`, not one tick in the past.
   * Edges that arrive after their tick was simulated go to the next tick (≤ 1 tick of skew).
   */
  update(nowMs) {
    if (nowMs < this.goAtMs) return 0;
    if (!this.started) {
      this.started = true;
      this.local.sim.start();
      for (const b of this.bots) b.sim.start();
    }
    const elapsed = nowMs - this.goAtMs;
    const target = Math.floor(elapsed / TICK_MS) + 1;
    const due = target - this.tick;
    const n = Math.min(due, MAX_TICKS_PER_FRAME);
    const stall = due > MAX_TICKS_PER_FRAME;
    const free = stall ? CATCHUP_FREE_TICKS : Math.max(CATCHUP_FREE_TICKS, Math.ceil(due / 2));
    const t0 = due > free ? clockNow() : 0;
    this.remoteLead = this.catchUp ? this.remoteLeadProgress() : 0;
    let ran = 0;
    for (; ran < n; ran++) {
      if (ran >= free && clockNow() - t0 > CATCHUP_BUDGET_MS) break;
      this.stepTick();
    }
    this.catchingUp = due > SILENT_BACKLOG_TICKS;
    this.alpha = this.tick < target ? 1 : clamp(elapsed / TICK_MS - (target - 1), 0, 1);
    return ran;
  }

  /** One fixed tick for the local rider and every bot. */
  /** Leading progress among remote riders (finished = 1; riders who left are ignored). */
  remoteLeadProgress() {
    const { startX, length } = this.course;
    let lead = 0;
    for (const [id, r] of this.remotes) {
      if (this.finishTimes.has(id)) return 1;
      if (r.gone || !r.ghost.last) continue;
      lead = Math.max(lead, clamp((r.ghost.x - startX) / length, 0, 1));
    }
    return lead;
  }

  stepTick() {
    this.tick++;
    // Catch-up assist, from progress at the start of this tick.
    let leader = this.remoteLead;
    if (this.catchUp) {
      leader = Math.max(leader, this.state.finishTick >= 0 ? 1 : this.state.progress);
      for (const b of this.bots) leader = Math.max(leader, b.sim.state.finishTick >= 0 ? 1 : b.sim.state.progress);
    }
    const assistOf = (st) => (this.catchUp && st.finishTick < 0 ? assistFor(st.progress, leader) : 0);
    const held = this.inputAt(this.goAtMs + this.tick * TICK_MS);
    this.localAssist = assistOf(this.state);
    const input = this.local.bot ? { held: !!this.local.bot.decide(this.state)?.held, assist: this.localAssist } : { held, assist: this.localAssist };
    const events = this.local.step(input);
    for (const e of events) {
      this.events.push(e);
      if (e.type === SimEvent.FINISH) this.finishTimes.set(this.local.id, Math.round(e.data.timeMs));
    }
    for (const b of this.bots) {
      const was = b.sim.state.finishTick;
      const assist = assistOf(b.sim.state);
      b.step({ held: !!b.bot.decide(b.sim.state)?.held, assist });
      if (was < 0 && b.sim.state.finishTick >= 0) {
        const report = b.report();
        this.finishTimes.set(b.id, report.timeMs);
        this.botFinishes.push(report);
      }
    }
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
      if (this.remotes.get(id).gone) continue;
      const pose = ghost.sample(nowMs, this.course);
      if (!pose) continue;
      pose.x -= (slots.get(id) ?? 0) * START_SLOT_PX * slotFade(pose.mode === RiderMode.IDLE, pose.t);
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
    for (const [id, { info, ghost, gone }] of this.remotes) {
      const finished = this.finishTimes.has(id);
      if (gone && !finished) continue;
      rows.push({ id, name: info.name, color: PLAYER_COLORS[info.colorIndex] ?? PLAYER_COLORS[0], progress: finished ? 1 : clamp((ghost.x - startX) / length, 0, 1), isLocal: false, finished });
    }
    return rows;
  }

  /**
   * Places of every rider in `rows` (finishers by time, then by progress): id → 1-based place.
   * Also records each rider's start / best / worst place (call it a few times a second).
   */
  notePositions(rows = this.standings()) {
    const order = rows
      .map((r) => ({ id: r.id, t: this.finishTimes.get(r.id), p: r.progress }))
      .sort((a, b) => (a.t !== undefined && b.t !== undefined ? a.t - b.t : a.t !== undefined ? -1 : b.t !== undefined ? 1 : b.p - a.p));
    const places = new Map(order.map((r, i) => [r.id, i + 1]));
    if (this.started && this.tick >= START_POS_TICK) {
      for (const [id, place] of places) {
        const rec = this.positions.get(id);
        if (!rec) this.positions.set(id, { start: place, best: place, worst: place, last: place });
        else {
          rec.best = Math.min(rec.best, place);
          rec.worst = Math.max(rec.worst, place);
          rec.last = place;
        }
      }
    }
    return places;
  }

  /**
   * Nearest rider ahead of and behind the local rider, with the gap in seconds at the local rider's
   * current speed (gapS > 0 = ahead). Finished riders are left out. Rows are from standings().
   */
  gaps(rows = this.standings()) {
    const me = rows.find((r) => r.isLocal);
    if (!me || me.finished) return { ahead: null, behind: null };
    const speed = Math.max(150, this.state.speed || 0);
    const len = this.course.length;
    let ahead = null;
    let behind = null;
    for (const r of rows) {
      if (r.isLocal || r.finished) continue;
      const d = (r.progress - me.progress) * len;
      if (d >= 0 && (!ahead || d < ahead.d)) ahead = { id: r.id, name: r.name, d };
      if (d < 0 && (!behind || d > behind.d)) behind = { id: r.id, name: r.name, d };
    }
    for (const g of [ahead, behind]) if (g) g.gapS = g.d / speed;
    return { ahead, behind };
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
