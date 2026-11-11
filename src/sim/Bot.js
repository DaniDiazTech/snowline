/**
 * AI rider. `decide(state)` returns the one-button input for the next tick.
 *
 * The bot plans by simulation: it plays candidate plans forward on a private scratch RiderSim
 * with the exact same physics, so a skill-1 bot never misjudges a jump. A plan is
 * { jumpTick, flips, landAngle, releaseBias, holdFrom }:
 *   - jumpTick   absolute tick at which to tap (ground, grind, or coyote right after a lip)
 *   - flips      backflips to spin in the air (released early enough for the carry to land level)
 *   - holdFrom   first tick the flip may be held (air plans are computed with a fixed latency)
 * The same deterministic controller (`control`) drives the scratch runs and the real rider, so
 * what was predicted is what happens. Skill adds human error: timing jitter, release jitter,
 * caution about flips, how often to jump for style.
 *
 * CPU budget (deterministic — counted in scratch-sim steps, never in time):
 *   planning runs as resumable jobs (generators). Each decide() advances the current job by at
 *   most BOT.STEP_BUDGET scratch steps, so a search that used to cost 5-10 ms in one frame is
 *   spread over a few ticks. The real rider keeps riding with no input meanwhile; the sim is
 *   deterministic, so a plan computed from a snapshot a few ticks old is still exact (candidate
 *   jump ticks that have already passed are discarded).
 */
import { RiderMode, SimEvent, FeatureType, GrindKind, TICK_DT } from '../contracts.js';
import { createRandom } from '../math/random.js';
import { clamp, lerp, wrapAngle, TAU } from '../math/utils.js';
import { RiderSim } from './RiderSim.js';
import { SIM } from './simConfig.js';

const BOT = Object.freeze({
  REPLAN_TICKS: 6, // no-input look-ahead period on the ground
  BASE_HORIZON: 80, // ticks of no-input look-ahead
  JUMP_SCAN_BACK: 66, // how many ticks before a hazard a jump may be taken
  SCAN_STEP: 3,
  AIR_HORIZON: 220,
  SETTLE_TICKS: 6, // ticks after touchdown that must stay crash-free
  STEP_BUDGET: 150, // scratch-sim steps per decide() call (≈ 0.3 ms)
  RUN_COST: 8, // budget charged for setting up a planning run (state copy)
  AIR_LATENCY: 6, // ticks: an air plan holds from this many ticks after take-off (job finishes first)
});

const BOT_COMMIT_MARGIN = (25 * Math.PI) / 180;

/** Deterministic controller shared by planning runs and the real rider. */
export function control(sim, plan) {
  const st = sim.state;
  const p = sim._p;
  if (st.mode === RiderMode.IDLE || st.mode === RiderMode.FINISHED || st.mode === RiderMode.CRASHED || st.mode === RiderMode.RESCUE) return false;
  const next = st.tick + 1;
  if (p.phys === 'ground' || p.phys === 'grind') return plan.jumpTick === next && !p.prevHeld;
  // air
  if (plan.jumpTick === next && !p.jumped && p.coyoteT > 0 && !p.prevHeld) return true;
  const n = plan.flips | 0;
  if (n <= 0 || next < (plan.holdFrom || 0)) return false;
  const rot = p.takeoffAngle - st.angle;
  if (rot > 0.6 && !p.prevHeld) return false; // released once: never re-press (would buffer a jump)
  const landAngle = plan.landAngle ?? Math.atan(sim.course.slopeAt(st.x));
  // Hold until the last flip is committed (tucked), plus a margin; the tuck carries it round and
  // the rider opens up for the landing.
  const target = (n - 1) * TAU + SIM.COMMIT_ANGLE + BOT_COMMIT_MARGIN + wrapAngle(p.takeoffAngle - landAngle) + (plan.releaseBias || 0);
  return rot < target;
}

/** Copy-on-write view of the real rider's consumed set (no per-run copy of hundreds of ids). */
class ConsumedOverlay {
  constructor() {
    this.base = null;
    this.local = new Set();
  }
  has(id) {
    return this.local.has(id) || (this.base !== null && this.base.has(id));
  }
  add(id) {
    this.local.add(id);
  }
  clear() {
    this.local.clear();
  }
}

const NO_PLAN = Object.freeze({ jumpTick: -1, flips: 0 });
const NO_GRINDS = Object.freeze([]);
const FLIP_TRICKS = new Set(['backflip', 'doubleBackflip', 'tripleBackflip', 'multiBackflip']);
const HELD = Object.freeze({ held: true });
const RELEASED = Object.freeze({ held: false });

export class Bot {
  /**
   * @param {import('../contracts.js').Course} course
   * @param {number} seed
   * @param {number} skill  0 = cautious beginner, 1 = very good human
   * @param {{flips?:boolean, grinds?:boolean, tricks?:boolean, maxFlips?:number}} [options]  test profiles
   *        (e.g. {flips:false, grinds:false, tricks:false} = "only jump over obstacles")
   */
  constructor(course, seed, skill, options = {}) {
    this.course = course;
    this.skill = clamp(Number.isFinite(skill) ? skill : 0.5, 0, 1);
    this.rng = createRandom((seed >>> 0) ^ 0x6a09e667);
    this.opts = { flips: true, grinds: true, tricks: true, ...options };
    this.scratch = new RiderSim(course);
    this.overlay = new ConsumedOverlay();
    this.scratch.consumed = this.overlay;
    this.snap = new RiderSim(course); // state the current job plans from
    this.inHeld = { held: true, assist: 0 }; // planning inputs replay the real rider's assist
    this.inFree = { held: false, assist: 0 };
    this.job = null;
    this.jobKind = '';
    this.budget = 0;
    this.real = null;
    this.skipped = new Map(); // pit id → decided to (not) jump it
    this.plan = NO_PLAN;
    this.nextLook = 0;
    this.nextTrickTick = 0;
    this.lastPhys = '';
    this.airPlanned = false;
    this.lastJumped = false;
    this.grindPlannedFor = -1;
    this.maxFlips = !this.opts.flips ? 0 : this.opts.maxFlips ?? (this.skill >= 0.85 ? 3 : this.skill >= 0.5 ? 2 : 1);
    this.jitterTicks = Math.round((1 - this.skill) * 4);
    this.releaseErr = (1 - this.skill) * 0.3; // rad
    this.lateChance = (1 - this.skill) * 0.22; // chance of reacting late to a hazard
  }

  /**
   * @param {import('../contracts.js').RiderState} state
   * @returns {import('../contracts.js').RiderInput}
   */
  decide(state) {
    const sim = state && state._sim;
    if (!sim || state.mode === RiderMode.IDLE || state.mode === RiderMode.FINISHED) return RELEASED;
    this.real = sim;
    const p = sim._p;
    const phys = p.phys;
    if (phys === 'air' && (this.lastPhys !== 'air' || p.jumped !== this.lastJumped)) {
      this.airPlanned = false;
      if (this.jobKind === 'air') this.dropJob();
    }
    this.lastJumped = p.jumped;
    if (phys === 'grind' && this.lastPhys !== 'grind') this.grindPlannedFor = -1;
    if (phys !== this.lastPhys) {
      if (this.job && this.jobKind !== phys) this.dropJob(); // the situation changed under the job
      if (phys === 'ground' && (this.lastPhys === 'air' || this.lastPhys === 'grind' || this.lastPhys === 'crashed' || this.lastPhys === 'rescue')) {
        this.nextLook = state.tick; // look again right after touching down
        this.scheduleTrick(state.tick);
      }
      this.lastPhys = phys;
    }
    if (phys === 'crashed' || phys === 'rescue') {
      this.plan = NO_PLAN;
      this.dropJob();
      return RELEASED;
    }
    this.budget = BOT.STEP_BUDGET;
    if (!this.job) this.maybeStartJob(sim, phys);
    if (this.job) {
      const r = this.job.next();
      if (r.done) this.dropJob();
    }
    return control(sim, this.plan) ? HELD : RELEASED;
  }

  dropJob() {
    this.job = null;
    this.jobKind = '';
  }

  maybeStartJob(real, phys) {
    const st = real.state;
    const p = real._p;
    if (phys === 'ground') {
      if (this.plan.jumpTick > st.tick) return; // a jump is scheduled
      if (st.tick < this.nextLook) return;
      this.nextLook = st.tick + BOT.REPLAN_TICKS;
      this.plan = NO_PLAN;
      this.startJob('ground', this.groundJob());
    } else if (phys === 'air') {
      if (this.airPlanned) return;
      if (this.plan.jumpTick > st.tick && !p.jumped) return; // a coyote jump is pending: plan after it
      this.airPlanned = true;
      this.startJob('air', this.airJob());
    } else if (phys === 'grind') {
      const g = p.grind;
      if (!g || this.grindPlannedFor === g.id) return;
      this.grindPlannedFor = g.id;
      this.plan = NO_PLAN;
      if (g.kind === GrindKind.ICE) return;
      this.startJob('grind', this.grindJob(g));
    }
  }

  startJob(kind, gen) {
    this.snap.copyFrom(this.real, false);
    this.inHeld.assist = this.inFree.assist = this.real._p.assistTarget;
    this.overlay.base = this.real.consumed;
    this.jobKind = kind;
    this.job = gen;
  }

  scheduleTrick(tick) {
    const delay = lerp(3.5, 0.3, this.skill) * this.rng.range(0.6, 1.5);
    this.nextTrickTick = tick + Math.round(delay / TICK_DT);
  }

  /* ------------------------------------------------------------ planning runs */

  /** Plays `plan` forward from the job snapshot on the scratch sim; yields when the step budget is spent. */
  *run(plan, maxTicks, stopAfterLanding) {
    const sc = this.scratch;
    this.budget -= BOT.RUN_COST;
    if (this.budget <= 0) yield;
    sc.copyFrom(this.snap, false);
    this.overlay.clear();
    // A fresh small result per run (callers keep a few at once); grind ids rarely needed → lazy.
    const r = { crash: false, crashTick: -1, pit: -1, points: 0, grinds: NO_GRINDS, leftGround: false, landTick: -1, landSlope: null, firstAirTick: -1, clean: false, sketchy: false, flips: 0 };
    const startPhys = sc._p.phys;
    for (let k = 1; k <= maxTicks; k++) {
      if (--this.budget <= 0) yield;
      const evs = sc.step(control(sc, plan) ? this.inHeld : this.inFree);
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        if (e.type === SimEvent.CRASH || e.type === SimEvent.RESCUE_START) {
          r.crash = true;
          r.crashTick = k;
          r.pit = e.type === SimEvent.RESCUE_START ? e.data.featureId : -1;
          return r;
        }
        if (e.type === SimEvent.TRICK) {
          r.points += e.data.points;
          if (FLIP_TRICKS.has(e.data.name)) r.flips++;
        } else if (e.type === SimEvent.GRIND_START) (r.grinds === NO_GRINDS ? (r.grinds = []) : r.grinds).push(e.data.featureId);
        else if (e.type === SimEvent.LAND && !e.data.clean) r.sketchy = true;
        else if (e.type === SimEvent.LAND && e.data.clean) {
          r.landTick = k;
          r.clean = true;
          r.landSlope = Math.atan(sc.course.slopeAt(sc.state.x));
        }
      }
      const ph = sc._p.phys;
      if (ph === 'air' && r.firstAirTick < 0) r.firstAirTick = k;
      if (ph === 'air' || (startPhys !== 'ground' && ph !== startPhys)) r.leftGround = true;
      if (sc.state.finishTick >= 0) return r;
      if (stopAfterLanding && r.leftGround && ph === 'ground' && r.landTick > 0 && k >= r.landTick + BOT.SETTLE_TICKS) return r;
    }
    return r;
  }

  /** Picks a tick inside the first contiguous window of still-valid candidates (offsets from the snapshot). */
  pickFromWindow(goodKs, t0) {
    const now = this.real.state.tick;
    const valid = goodKs.filter((k) => t0 + k > now);
    if (!valid.length) return -1;
    const win = [valid[0]];
    for (let i = 1; i < valid.length && valid[i] - valid[i - 1] <= BOT.SCAN_STEP; i++) win.push(valid[i]);
    const mid = win[Math.floor((win.length - 1) / 2)];
    let jitter = this.jitterTicks ? this.rng.int(-this.jitterTicks, this.jitterTicks) : 0;
    if (this.lateChance > 0 && this.rng.chance(this.lateChance)) jitter += this.rng.int(4, 12);
    return Math.max(now - t0 + 1, mid + jitter);
  }

  /* ------------------------------------------------------------ ground */

  *groundJob() {
    const st = this.snap.state;
    const t0 = st.tick;

    // 1. Hazard ahead if we do nothing?
    const base = yield* this.run(NO_PLAN, BOT.BASE_HORIZON, false);
    // Beginners sometimes misjudge a wide pit and ride straight in (skilled never).
    if (base.crash && base.pit >= 0 && !this.skipped.has(base.pit)) {
      const pit = this.course.features[base.pit];
      this.skipped.set(base.pit, pit.x1 - pit.x0 >= 200 && this.rng.chance((1 - this.skill) * 0.35));
    }
    if (base.crash && base.pit >= 0 && this.skipped.get(base.pit)) return;
    if (base.crash) {
      const good = [];
      const from = Math.max(1, base.crashTick - BOT.JUMP_SCAN_BACK);
      for (let k = from; k < base.crashTick; k += BOT.SCAN_STEP) {
        const r = yield* this.run({ jumpTick: t0 + k, flips: 0 }, k + BOT.AIR_HORIZON, true);
        if (!r.crash) good.push(k);
      }
      let k = this.pickFromWindow(good, t0);
      const now = this.real.state.tick;
      if (k < 0) {
        if (t0 + base.crashTick - now > 20) return; // nothing works yet; look again soon
        k = now - t0 + 1; // panic jump
      }
      this.plan = { jumpTick: t0 + k, flips: 0 };
      return;
    }

    const course = this.course;
    const lookPx = Math.max(300, st.speed * 1.4);

    // 2. Grind line coming up?
    if (this.opts.grinds) {
      for (const f of course.featuresIn(st.x + 40, st.x + lookPx)) {
        if (f.type !== FeatureType.GRIND || f.kind === GrindKind.ICE || f.x0 < st.x + 40) continue;
        const good = [];
        for (let k = 1; k <= 70; k += BOT.SCAN_STEP) {
          const r = yield* this.run({ jumpTick: t0 + k, flips: 0 }, k + 90, true);
          if (!r.crash && r.grinds.includes(f.id)) good.push(k);
          if (st.x + st.speed * k * TICK_DT > f.x1) break;
        }
        const k = this.pickFromWindow(good, t0);
        if (k > 0 && this.rng.chance(0.55 + 0.45 * this.skill)) {
          this.plan = { jumpTick: t0 + k, flips: 0 };
          return;
        }
        break;
      }
    }

    // 3. Style jump (flips), preferring ramp lips.
    if (!this.opts.tricks || this.maxFlips === 0 || t0 < this.nextTrickTick) return;
    let jumpK = 1;
    if (base.firstAirTick > 0 && base.firstAirTick < 60) {
      // The terrain launches us soon (kicker / crest): jump right at the lip (coyote).
      jumpK = base.firstAirTick + 1;
    } else {
      for (const f of course.featuresIn(st.x, st.x + lookPx)) if (f.type === FeatureType.GRIND && f.kind !== GrindKind.ICE) return; // wait for the grind
    }
    const r = yield* this.run({ jumpTick: t0 + jumpK, flips: 1, holdFrom: t0 + jumpK + BOT.AIR_LATENCY }, jumpK + BOT.AIR_HORIZON, true);
    const now = this.real.state.tick;
    if (!r.crash && r.clean && !r.sketchy && t0 + jumpK > now) {
      this.plan = { jumpTick: t0 + jumpK, flips: 0 };
      this.scheduleTrick(t0 + jumpK + 30);
    } else if (jumpK === 1) {
      this.nextTrickTick = now + 6;
    }
  }

  /* ------------------------------------------------------------ air */

  *airJob() {
    const st = this.snap.state;
    const p = this.snap._p;
    const keepJump = this.plan.jumpTick;
    const holdFrom = st.tick + BOT.AIR_LATENCY;
    let best = { jumpTick: keepJump, flips: 0 };
    if (this.maxFlips > 0) {
      for (let n = this.maxFlips; n >= 1; n--) {
        const plan = { jumpTick: keepJump, flips: n, landAngle: undefined, releaseBias: 0, holdFrom };
        let r = yield* this.run(plan, BOT.AIR_HORIZON, true);
        if (r.landSlope !== null) {
          plan.landAngle = r.landSlope;
          r = yield* this.run(plan, BOT.AIR_HORIZON, true);
        }
        if (r.crash || !r.clean || r.sketchy || r.flips < n) continue;
        if (this.releaseErr > 0) {
          const lo = yield* this.run({ ...plan, releaseBias: -this.releaseErr }, BOT.AIR_HORIZON, true);
          const hi = yield* this.run({ ...plan, releaseBias: this.releaseErr }, BOT.AIR_HORIZON, true);
          if (lo.crash || hi.crash) continue;
        }
        best = plan;
        break;
      }
      // Beginners sometimes get greedy.
      if (best.flips < this.maxFlips && this.rng.chance((1 - this.skill) * 0.12) && st.airTime < 0.1 && p.jumped) best = { ...best, flips: best.flips + 1, holdFrom };
      if (this.releaseErr > 0) best.releaseBias = this.rng.range(-1.3, 1.3) * this.releaseErr;
    }
    // The plan was simulated holding from `holdFrom`; if the search ran past it, the real rider
    // could no longer match it — fly it out without flipping.
    if (best.flips > 0 && this.real.state.tick + 1 > holdFrom) best = { jumpTick: keepJump, flips: 0 };
    this.plan = best;
  }

  /* ------------------------------------------------------------ grind */

  *grindJob(g) {
    const st = this.snap.state;
    const t0 = st.tick;
    const base = yield* this.run(NO_PLAN, BOT.AIR_HORIZON, true);
    let bestScore = base.crash ? -1000 : base.points;
    let good = [];
    const remainTicks = Math.ceil((g.x1 - st.x) / Math.max(60, st.speed) / TICK_DT);
    if (this.opts.grinds) {
      for (let k = 2; k <= remainTicks; k += BOT.SCAN_STEP) {
        const r = yield* this.run({ jumpTick: t0 + k, flips: 0 }, k + BOT.AIR_HORIZON, true);
        if (r.crash) continue;
        const score = r.points + (r.grinds.some((id) => id !== g.id) ? 100 : 0);
        if (score > bestScore + 5) {
          bestScore = score;
          good = [k];
        } else if (good.length && Math.abs(score - bestScore) <= 5) good.push(k);
      }
    }
    const k = this.pickFromWindow(good, t0);
    if (k > 0 && this.rng.chance(0.4 + 0.6 * this.skill)) this.plan = { jumpTick: t0 + k, flips: 0 };
  }
}
