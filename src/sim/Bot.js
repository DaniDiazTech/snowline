/**
 * AI rider. `decide(state)` returns the one-button input for the next tick.
 *
 * The bot plans by simulation: it copies the real RiderSim (reachable through the
 * non-enumerable `state._sim`) into a private scratch sim and plays candidate plans
 * forward with the exact same physics, so a skill-1 bot never misjudges a jump.
 * A plan is { jumpTick, flips, landAngle, releaseBias }:
 *   - jumpTick   absolute tick at which to tap (ground, grind, or coyote right after a lip)
 *   - flips      backflips to spin in the air (released early enough to land level)
 * The same deterministic controller (`control`) drives both the scratch runs and the
 * real rider, so what was predicted is what happens. Skill adds human error on top:
 * jump timing jitter, release jitter, caution about how many flips to try, how often
 * to jump for style at all.
 *
 * Planning cost is bounded: a no-input look-ahead every few ticks; a jump-window
 * search (≈20 short runs) only when that look-ahead hits something or a grind/ramp
 * is coming; a flip choice (≤ 6 runs) once per air phase.
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
});

/** Deterministic controller shared by planning runs and the real rider. */
export function control(sim, plan) {
  const st = sim.state;
  const p = sim._p;
  if (st.mode === RiderMode.IDLE || st.mode === RiderMode.FINISHED || st.mode === RiderMode.CRASHED) return false;
  const next = st.tick + 1;
  if (p.phys === 'ground' || p.phys === 'grind') return plan.jumpTick === next && !p.prevHeld;
  // air
  if (plan.jumpTick === next && !p.jumped && p.coyoteT > 0 && !p.prevHeld) return true;
  const n = plan.flips | 0;
  if (n <= 0) return false;
  const rot = p.takeoffAngle - st.angle;
  if (rot > 0.6 && !p.prevHeld) return false; // released once: never re-press (would buffer a jump)
  const landAngle = plan.landAngle ?? Math.atan(sim.course.slopeAt(st.x));
  const target = n * TAU + wrapAngle(p.takeoffAngle - landAngle); // angles are unwrapped across flips
  const overshoot = Math.abs(st.angVel) / SIM.RELEASE_DAMP + (plan.releaseBias || 0);
  return rot + overshoot < target;
}

export class Bot {
  /**
   * @param {import('../contracts.js').Course} course
   * @param {number} seed
   * @param {number} skill  0 = cautious beginner, 1 = very good human
   * @param {{flips?:boolean, grinds?:boolean, tricks?:boolean}} [options]  test profiles
   *        (e.g. {flips:false, grinds:false, tricks:false} = "only jump over obstacles")
   */
  constructor(course, seed, skill, options = {}) {
    this.course = course;
    this.skill = clamp(Number.isFinite(skill) ? skill : 0.5, 0, 1);
    this.rng = createRandom((seed >>> 0) ^ 0x6a09e667);
    this.opts = { flips: true, grinds: true, tricks: true, ...options };
    this.scratch = new RiderSim(course);
    this.skipped = new Map(); // pit id → decided to (not) jump it
    this.plan = { jumpTick: -1, flips: 0 };
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
    if (!sim || state.mode === RiderMode.IDLE || state.mode === RiderMode.FINISHED) return { held: false };
    const p = sim._p;
    const phys = p.phys;
    if (phys === 'air' && (this.lastPhys !== 'air' || p.jumped !== this.lastJumped)) this.airPlanned = false;
    this.lastJumped = p.jumped;
    if (phys === 'grind' && this.lastPhys !== 'grind') this.grindPlannedFor = -1;
    if (phys !== this.lastPhys) {
      if (phys === 'ground' && (this.lastPhys === 'air' || this.lastPhys === 'grind' || this.lastPhys === 'crashed')) {
        this.nextLook = state.tick; // look again right after touching down
        this.scheduleTrick(state.tick);
      }
      this.lastPhys = phys;
    }
    if (phys === 'crashed') {
      this.plan = { jumpTick: -1, flips: 0 };
      return { held: false };
    }
    if (phys === 'ground') this.thinkGround(sim);
    else if (phys === 'air') this.thinkAir(sim);
    else if (phys === 'grind') this.thinkGrind(sim);
    return { held: control(sim, this.plan) };
  }

  scheduleTrick(tick) {
    const delay = lerp(3.5, 0.3, this.skill) * this.rng.range(0.6, 1.5);
    this.nextTrickTick = tick + Math.round(delay / TICK_DT);
  }

  /* ------------------------------------------------------------ planning runs */

  /** Plays `plan` forward on the scratch sim. */
  run(real, plan, maxTicks, stopAfterLanding) {
    const sc = this.scratch;
    sc.copyFrom(real);
    const r = { crash: false, crashTick: -1, points: 0, grinds: [], leftGround: false, landTick: -1, landSlope: null, firstAirTick: -1, clean: false, flips: 0 };
    const startPhys = sc._p.phys;
    for (let k = 1; k <= maxTicks; k++) {
      const held = control(sc, plan);
      const evs = sc.step({ held });
      for (const e of evs) {
        if (e.type === SimEvent.CRASH || e.type === SimEvent.RESCUE_START) {
          r.crash = true;
          r.crashTick = k;
          r.pit = e.type === SimEvent.RESCUE_START ? e.data.featureId : -1;
          return r;
        }
        if (e.type === SimEvent.TRICK) {
          r.points += e.data.points;
          if (/backflip/i.test(e.data.name)) r.flips++;
        }
        else if (e.type === SimEvent.GRIND_START) r.grinds.push(e.data.featureId);
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

  /** Picks a tick inside the first contiguous window of good candidates. */
  pickFromWindow(goodKs) {
    if (!goodKs.length) return -1;
    const win = [goodKs[0]];
    for (let i = 1; i < goodKs.length && goodKs[i] - goodKs[i - 1] <= BOT.SCAN_STEP; i++) win.push(goodKs[i]);
    const mid = win[Math.floor((win.length - 1) / 2)];
    let jitter = this.jitterTicks ? this.rng.int(-this.jitterTicks, this.jitterTicks) : 0;
    if (this.lateChance > 0 && this.rng.chance(this.lateChance)) jitter += this.rng.int(4, 12);
    return Math.max(1, mid + jitter);
  }

  /* ------------------------------------------------------------ ground */

  thinkGround(real) {
    const st = real.state;
    if (this.plan.jumpTick > st.tick) return; // a jump is scheduled
    if (st.tick < this.nextLook) return;
    this.nextLook = st.tick + BOT.REPLAN_TICKS;
    this.plan = { jumpTick: -1, flips: 0 };

    // 1. Hazard ahead if we do nothing?
    const base = this.run(real, this.plan, BOT.BASE_HORIZON, false);
    // Beginners sometimes misjudge a wide pit and ride straight in (skilled never).
    if (base.crash && base.pit >= 0 && !this.skipped.has(base.pit)) {
      const pit = real.course.features[base.pit];
      this.skipped.set(base.pit, pit.x1 - pit.x0 >= 200 && this.rng.chance((1 - this.skill) * 0.35));
    }
    if (base.crash && base.pit >= 0 && this.skipped.get(base.pit)) return;
    if (base.crash) {
      const good = [];
      const from = Math.max(1, base.crashTick - BOT.JUMP_SCAN_BACK);
      for (let k = from; k < base.crashTick; k += BOT.SCAN_STEP) {
        const r = this.run(real, { jumpTick: st.tick + k, flips: 0 }, k + BOT.AIR_HORIZON, true);
        if (!r.crash) good.push(k);
      }
      let k = this.pickFromWindow(good);
      if (k < 0) {
        if (base.crashTick > 20) return; // nothing works yet; look again soon
        k = 1; // panic jump
      }
      this.plan = { jumpTick: st.tick + k, flips: 0 };
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
          const r = this.run(real, { jumpTick: st.tick + k, flips: 0 }, k + 90, true);
          if (!r.crash && r.grinds.includes(f.id)) good.push(k);
          if (st.x + st.speed * k * TICK_DT > f.x1) break;
        }
        const k = this.pickFromWindow(good);
        if (k > 0 && this.rng.chance(0.55 + 0.45 * this.skill)) {
          this.plan = { jumpTick: st.tick + k, flips: 0 };
          return;
        }
        break;
      }
    }

    // 3. Style jump (flips), preferring ramp lips.
    if (!this.opts.tricks || this.maxFlips === 0 || st.tick < this.nextTrickTick) return;
    let jumpK = 1;
    if (base.firstAirTick > 0 && base.firstAirTick < 60) {
      // The terrain launches us soon (kicker / crest): jump right at the lip (coyote).
      jumpK = base.firstAirTick + 1;
    } else {
      for (const f of course.featuresIn(st.x, st.x + lookPx)) if (f.type === FeatureType.GRIND && f.kind !== GrindKind.ICE) return; // wait for the grind
    }
    const r = this.run(real, { jumpTick: st.tick + jumpK, flips: 1 }, jumpK + BOT.AIR_HORIZON, true);
    if (!r.crash && r.clean && !r.sketchy) {
      this.plan = { jumpTick: st.tick + jumpK, flips: 0 };
      this.scheduleTrick(st.tick + jumpK + 30);
    } else if (jumpK === 1) {
      this.nextTrickTick = st.tick + 6;
    }
  }

  /* ------------------------------------------------------------ air */

  thinkAir(real) {
    const st = real.state;
    const p = real._p;
    if (this.airPlanned) return;
    // Plan flips once per air phase (after the coyote jump, if one is pending).
    if (this.plan.jumpTick > st.tick && !p.jumped) return;
    this.airPlanned = true;
    const keepJump = this.plan.jumpTick;
    let best = { jumpTick: keepJump, flips: 0 };
    if (this.maxFlips > 0) {
      for (let n = this.maxFlips; n >= 1; n--) {
        const plan = { jumpTick: keepJump, flips: n, landAngle: undefined, releaseBias: 0 };
        let r = this.run(real, plan, BOT.AIR_HORIZON, true);
        if (r.landSlope !== null) {
          plan.landAngle = r.landSlope;
          r = this.run(real, plan, BOT.AIR_HORIZON, true);
        }
        if (r.crash || !r.clean || r.sketchy || r.flips < n) continue;
        if (this.releaseErr > 0) {
          const lo = this.run(real, { ...plan, releaseBias: -this.releaseErr }, BOT.AIR_HORIZON, true);
          const hi = this.run(real, { ...plan, releaseBias: this.releaseErr }, BOT.AIR_HORIZON, true);
          if (lo.crash || hi.crash) continue;
        }
        best = plan;
        break;
      }
      // Beginners sometimes get greedy.
      if (best.flips < this.maxFlips && this.rng.chance((1 - this.skill) * 0.12) && st.airTime < 0.1 && p.jumped) best = { ...best, flips: best.flips + 1 };
      if (this.releaseErr > 0) best.releaseBias = this.rng.range(-1.3, 1.3) * this.releaseErr;
    }
    this.plan = best;
  }

  /* ------------------------------------------------------------ grind */

  thinkGrind(real) {
    const st = real.state;
    const g = real._p.grind;
    if (!g || this.grindPlannedFor === g.id) return;
    this.grindPlannedFor = g.id;
    this.plan = { jumpTick: -1, flips: 0 };
    if (g.kind === GrindKind.ICE) return;
    const base = this.run(real, this.plan, BOT.AIR_HORIZON, true);
    let bestScore = base.crash ? -1000 : base.points;
    let good = [];
    const remainTicks = Math.ceil((g.x1 - st.x) / Math.max(60, st.speed) / TICK_DT);
    if (this.opts.grinds) {
      for (let k = 2; k <= remainTicks; k += BOT.SCAN_STEP) {
        const r = this.run(real, { jumpTick: st.tick + k, flips: 0 }, k + BOT.AIR_HORIZON, true);
        if (r.crash) continue;
        const score = r.points + (r.grinds.some((id) => id !== g.id) ? 100 : 0);
        if (score > bestScore + 5) {
          bestScore = score;
          good = [k];
        } else if (good.length && Math.abs(score - bestScore) <= 5) good.push(k);
      }
    }
    const k = this.pickFromWindow(good);
    if (k > 0 && this.rng.chance(0.4 + 0.6 * this.skill)) this.plan = { jumpTick: st.tick + k, flips: 0 };
  }
}
