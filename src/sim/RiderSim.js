/**
 * Deterministic simulation of ONE rider on a Course. One `step()` = one tick (TICK_DT).
 *
 * Physics model
 *  - GROUND: the rider is a point glued to the surface with a signed speed `s` along the
 *    tangent: a = g·sinθ − k·s² (+ boost push, + a 'get back to pace' push below RECOVER_BELOW × cruise). Scarf and
 *    boost divide the drag by M², which raises the cruising (terminal) speed by M.
 *    Each tick a short ballistic look-ahead decides whether the ground falls away faster
 *    than a free arc (crests, ramp lips, chasm edges) — then the rider becomes airborne.
 *    The look-ahead needs the surface to curve ≈30% harder than gravity, so gentle bumps
 *    never jitter between ground and air.
 *  - AIR: ballistic with light quadratic drag. Holding the button spins a backflip
 *    (counter-clockwise, angle decreases) with a quick ease-in; releasing damps the spin
 *    and levels the board only a little toward the slope below.
 *  - GRIND: like ground but on a grind line (bunting / roof / ice); mild speed gain.
 *  - CRASHED: tumble while still sliding along the slope (thrown over obstacles), then get up
 *    in place already moving (≥ RESPAWN_MIN_FRAC × cruise) with brief invulnerability.
 *  - RESCUE: fell into a pit — a 3 s lift carries the rider across to the far lip.
 *
 * The internal physics mode (`_p.phys`) is separate from the reported `state.mode`
 * (which adds IDLE / FINISHED / CRASHED precedence).
 *
 * `state._sim` (non-enumerable) points back to this sim so a Bot can clone it for planning.
 */
import { RiderMode, SimEvent, FeatureType, GrindKind, PickupKind, TICK_DT, TICK_MS } from '../contracts.js';
import { clamp, damp, smoothstep, wrapAngle, TAU } from '../math/utils.js';
import { SIM, TRICKS, GRINDS, GRAVITY, JUMP_VY, DRAG_K, REF_SPEED, rampPop, BODY_CENTER, RIDER_HEIGHT, terminalSpeed } from './simConfig.js';

const dt = TICK_DT;
const CHAIN_LABEL = ['', '', ' ×2', ' ×3', ' ×4', ' ×5'];
const FLIP_NAMES = ['', 'backflip', 'doubleBackflip', 'tripleBackflip'];
const NO_EVENTS = Object.freeze([]);

/**
 * Sorted index over one category of features with their horizontal extents, for cheap,
 * allocation-free range queries (the course-wide index must scan back by the longest feature).
 */
class SpanIndex {
  constructor(list, extent) {
    this.items = list.slice().sort((a, b) => extent(a)[0] - extent(b)[0]);
    this.start = new Float64Array(this.items.length);
    this.end = new Float64Array(this.items.length);
    this.maxSpan = 0;
    this.items.forEach((f, i) => {
      const [a, b] = extent(f);
      this.start[i] = a;
      this.end[i] = b;
      this.maxSpan = Math.max(this.maxSpan, b - a);
    });
  }
  /** Items overlapping [x0, x1], written into `out`. */
  query(x0, x1, out) {
    out.length = 0;
    const v = x0 - this.maxSpan;
    let lo = 0;
    let hi = this.start.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.start[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.start.length && this.start[i] <= x1; i++) if (this.end[i] >= x0) out.push(this.items[i]);
    return out;
  }
}
/** Solid obstacles: circles (rock, campfire: `size` = radius) and boxes (log, snowman, spikes: `w`, `h`). */
const SOLID = {
  [FeatureType.ROCK]: { box: false, smash: 'rockSmash', label: 'Rock Smash' },
  [FeatureType.CAMPFIRE]: { box: false, smash: 'campfireSmash', label: 'Campfire Smash' },
  [FeatureType.LOG]: { box: true, smash: 'logSmash', label: 'Log Smash' },
  [FeatureType.SNOWMAN]: { box: true, smash: 'snowmanSmash', label: 'Snowman Smash' },
  [FeatureType.SPIKES]: { box: true, smash: 'spikesSmash', label: 'Spikes Smash' },
};

function freshPrivate() {
  return {
    phys: 'ground', // 'ground' | 'air' | 'grind' | 'crashed'
    s: 0, // speed along the surface / line (ground, grind, crash slide)
    prevHeld: false,
    holdT: 0, // s the button has been held continuously
    airPhases: 0, // count of air phases started (diagnostics)
    bufferT: 0,
    coyoteT: 0,
    jumped: false, // current air phase started with a jump
    takeoffAngle: 0,
    flipMinClear: Infinity,
    bigAirDone: false,
    overChasm: null,
    grind: null,
    grindDist: 0,
    grindLen: 0,
    grindCooldownId: -1,
    grindCooldownT: 0,
    bounceId: -1,
    bounceT: 0,
    crashT: 0,
    crashCause: '',
    invulnT: 0,
    boostDur: 0,
    boostEff: 0, // eased boost bonus actually applied (eases in ~0.15 s, out with the fade)
    kickLeft: 0, // px/s of bank kick still to be delivered (spread over ~0.1 s)
    landEaseT: 0, // s of fast board-to-slope easing left after a touchdown
    wobbleT: 0, // s of sketchy-landing wobble left
    rescue: null, // active pit rescue lift
    rampLaunch: null, // pit ramp whose lip a press made on its run-up will launch from
    lineChain: 0, // lines caught in the current chain (reset on plain snow)
    assistTarget: 0, // RiderInput.assist of the last tick (0..1)
    assistEff: 0, // eased assist actually applied
    spinChecked: false, // this air phase's "is there time to flip?" check was done
    spinBlocked: false, // ...and it said no: a held button keeps the board level instead
    landSquash: 0,
    hoverOff: 0,
  };
}

function freshStats() {
  return { score: 0, bestCombo: 0, flips: 0, grindPx: 0, crashes: 0, coins: 0, topSpeed: 0 };
}

export class RiderSim {
  /** @param {import('../contracts.js').Course} course */
  constructor(course) {
    this.course = course;
    /** @type {Set<number>} */
    this.consumed = new Set();
    this._p = freshPrivate();
    const x = course.startX;
    /** @type {import('../contracts.js').RiderState} */
    this.state = {
      tick: 0,
      x,
      y: course.heightAt(x),
      vx: 0,
      vy: 0,
      angle: Math.atan(course.slopeAt(x)),
      angVel: 0,
      mode: RiderMode.IDLE,
      speed: 0,
      crouch: 0.2,
      scarf: 0,
      boostT: 0,
      boostLevel: 0,
      shield: false,
      hoverT: 0,
      magnetT: 0,
      airTime: 0,
      flips: 0,
      combo: { points: 0, mult: 0, tricks: [] },
      progress: 0,
      finishTick: -1,
      stats: freshStats(),
    };
    Object.defineProperty(this.state, '_sim', { value: this, enumerable: false, writable: true, configurable: true });
    this._ramps = course.features.filter((f) => f.type === FeatureType.RAMP);
    // Per-category indexes (pickups, solid obstacles, grind/ice lines) for cheap per-tick queries.
    const ext = (f) => (course._extent ? course._extent(f) : [f.x0 ?? f.x - (f.w ? f.w / 2 : f.size || 0), f.x1 ?? f.x + (f.w ? f.w / 2 : f.size || 0)]);
    this._pickIdx = new SpanIndex(course.features.filter((f) => f.type === FeatureType.PICKUP), ext);
    this._solidIdx = new SpanIndex(course.features.filter((f) => SOLID[f.type]), ext);
    this._lineIdx = new SpanIndex(course.features.filter((f) => f.type === FeatureType.GRIND), ext);
    this._ev = []; // reused per-tick event buffer
    this._qa = []; // reused feature-query buffers (one per call site, so nested queries never clash)
    this._qb = [];
    this._qc = [];
    this._qd = [];
    this._qe = [];
  }

  /** IDLE → GROUND at GO. */
  start() {
    if (this.state.mode !== RiderMode.IDLE) return;
    this.state.mode = RiderMode.GROUND;
    this._p.phys = 'ground';
    this._p.s = SIM.START_SPEED;
    this.state.vx = SIM.START_SPEED * Math.cos(this.state.angle);
    this.state.vy = SIM.START_SPEED * Math.sin(this.state.angle);
  }

  /** Copies the complete simulation state of another RiderSim on the same course (used by bots to plan). */
  copyFrom(other, copyConsumed = true) {
    const a = this.state;
    const b = other.state;
    for (const k in b) {
      if (k === 'combo' || k === 'stats') continue;
      a[k] = b[k];
    }
    a.combo.points = b.combo.points;
    a.combo.mult = b.combo.mult;
    a.combo.tricks.length = 0;
    for (let i = 0; i < b.combo.tricks.length; i++) a.combo.tricks.push(b.combo.tricks[i]);
    Object.assign(a.stats, b.stats);
    Object.assign(this._p, other._p);
    if (other._p.rescue) this._p.rescue = { ...other._p.rescue }; // the lift state is mutated per tick
    if (copyConsumed) {
      this.consumed.clear();
      for (const id of other.consumed) this.consumed.add(id);
    }
  }

  /**
   * Advances exactly one tick.
   * @param {import('../contracts.js').RiderInput} input
   * @returns {import('../contracts.js').SimEventRecord[]}
   */
  step(input) {
    const ev = this._ev;
    ev.length = 0;
    const st = this.state;
    const p = this._p;
    if (st.mode === RiderMode.IDLE) return ev;
    st.tick++;
    const finished = st.finishTick >= 0;
    const held = !finished && !!(input && input.held);
    const assist = input && input.assist > 0 ? Math.min(1, input.assist) : 0;
    p.assistTarget = assist;
    p.assistEff = damp(p.assistEff, finished ? 0 : assist, SIM.ASSIST_EASE, dt);
    if (p.assistEff < 1e-4 && assist === 0) p.assistEff = 0;
    const pressed = held && !p.prevHeld;
    p.prevHeld = held;
    p.holdT = held ? p.holdT + dt : 0;
    p.bufferT = pressed ? SIM.JUMP_BUFFER : Math.max(0, p.bufferT - dt);

    this._timers();
    this._applyKick();
    switch (p.phys) {
      case 'ground':
        this._ground(held, ev);
        break;
      case 'air':
        this._air(held, ev);
        break;
      case 'grind':
        this._grind(held, ev);
        break;
      case 'crashed':
        this._crashed(ev);
        break;
      case 'rescue':
        this._rescue(ev);
        break;
    }
    if (p.phys !== 'crashed' && p.phys !== 'rescue') this._pickups(ev);

    const c = this.course;
    if (st.x > c.maxX - 5) {
      st.x = c.maxX - 5;
      st.y = c.heightAt(st.x);
      p.s = 0;
      st.vx = 0;
      st.vy = 0;
    }
    if (st.finishTick < 0 && st.x >= c.finishX) {
      st.finishTick = st.tick;
      ev.push({ type: SimEvent.FINISH, data: { tick: st.tick, timeMs: st.tick * TICK_MS } });
    }
    this._derive(held);
    return ev.length ? ev.slice() : NO_EVENTS; // no garbage on quiet ticks
  }

  /* ------------------------------------------------------------ helpers */


  /** `target` shifted by whole turns to be nearest to the current (unwrapped) board angle. */
  _nearest(target) {
    return target + TAU * Math.round((this.state.angle - target) / TAU);
  }

  /** How far the contact point must sit above the snow so neither board tip digs in. */
  _tipLift(rel) {
    const r = Math.abs(wrapAngle(rel));
    return SIM.BOARD_HALF * Math.sin(Math.min(r, Math.PI / 2));
  }

  _surf(x) {
    return this.course.heightAt(x) - this._p.hoverOff;
  }

  _mult() {
    const m = (1 + SIM.SCARF_SPEED_BONUS * this.state.scarf) * (1 + this._p.boostEff);
    return Math.min(m, SIM.MAX_SPEED_MULT) * (1 + SIM.ASSIST_MAX * this._p.assistEff);
  }

  /** Extra push (px/s²) of the active boost: proportional to its eased bonus. */
  _boostPush() {
    return SIM.BOOST_PUSH * this._p.boostEff;
  }

  /** 1 while a boost is at full power, fading smoothly to 0 over its last part. */
  _boostFrac() {
    const st = this.state;
    if (st.boostT <= 0) return 0;
    return smoothstep(0, this._p.boostDur * (1 - SIM.BOOST_FULL_FRAC), st.boostT);
  }

  /** Delivers the pending bank kick over ~KICK_T instead of in one frame. */
  _applyKick() {
    const st = this.state;
    const p = this._p;
    if (p.kickLeft <= 0) return;
    if (p.phys === 'crashed' || p.phys === 'rescue') {
      p.kickLeft = 0;
      return;
    }
    const dv = Math.min(p.kickLeft, SIM.KICK_RATE * dt);
    p.kickLeft -= dv;
    if (p.phys === 'air') {
      const sp = Math.sqrt((st.vx) * (st.vx) + (st.vy) * (st.vy));
      if (sp > 1) {
        st.vx *= (sp + dv) / sp;
        st.vy *= (sp + dv) / sp;
      }
    } else p.s += dv;
  }

  _timers() {
    const st = this.state;
    const p = this._p;
    if (st.boostT > 0) {
      st.boostT = Math.max(0, st.boostT - dt);
      if (st.boostT === 0) st.boostLevel = 0;
    }
    st.shield = st.boostT > 0 && st.boostT > p.boostDur * (1 - SIM.SHIELD_FRAC);
    st.hoverT = Math.max(0, st.hoverT - dt);
    st.magnetT = Math.max(0, st.magnetT - dt);
    p.invulnT = Math.max(0, p.invulnT - dt);
    p.grindCooldownT = Math.max(0, p.grindCooldownT - dt);
    p.bounceT = Math.max(0, p.bounceT - dt);
    p.landSquash = Math.max(0, p.landSquash - SIM.SQUASH_RECOVER * dt);
    p.landEaseT = Math.max(0, p.landEaseT - dt);
    p.wobbleT = Math.max(0, p.wobbleT - dt);
    const boostTarget = st.boostT > 0 && st.boostLevel > 0 ? SIM.BOOST_TIERS[st.boostLevel - 1].bonus * this._boostFrac() : 0;
    p.boostEff = damp(p.boostEff, boostTarget, SIM.BOOST_EASE, dt);
    if (p.boostEff < 1e-4) p.boostEff = 0;
    st.scarf = Math.max(0, st.scarf - SIM.SCARF_DECAY * dt);
    p.hoverOff = damp(p.hoverOff, st.hoverT > 0 ? SIM.HOVER_HEIGHT : 0, 6, dt);
    if (p.hoverOff < 0.01) p.hoverOff = 0;
  }

  _addTrick(ev, name, label, points) {
    const cb = this.state.combo;
    cb.points += points;
    cb.tricks.push(name);
    cb.mult = cb.tricks.length;
    ev.push({ type: SimEvent.TRICK, data: { name, label, points } });
  }

  _bank(ev) {
    const st = this.state;
    const cb = st.combo;
    if (cb.tricks.length === 0) {
      if (cb.points) st.stats.score += cb.points;
      cb.points = 0;
      return;
    }
    const mult = cb.tricks.length;
    const total = cb.points * mult;
    ev.push({ type: SimEvent.COMBO, data: { points: cb.points, mult, total, tricks: cb.tricks.slice() } });
    st.stats.score += total;
    st.stats.bestCombo = Math.max(st.stats.bestCombo, total);
    st.scarf = Math.min(1, st.scarf + Math.min(SIM.SCARF_MAX_GAIN, total * SIM.SCARF_PER_POINT));
    let level = 0;
    SIM.BOOST_TIERS.forEach((t, i) => {
      if (total >= t.min) level = i + 1;
    });
    if (level > 0) {
      const dur = SIM.BOOST_TIERS[level - 1].duration;
      let t = dur;
      if (st.boostT > 0) {
        // Re-banking during a boost: extends it (by a fraction of the overlap). A higher tier
        // upgrades it; a lower tier keeps the current tier only while it still has > 1 s left.
        if (level < st.boostLevel && st.boostT > 1) level = st.boostLevel;
        t = Math.min(SIM.BOOST_MAX_T, Math.max(st.boostT, dur) + SIM.BOOST_EXTEND * Math.min(st.boostT, dur));
      }
      st.boostT = t;
      st.boostLevel = level;
      this._p.boostDur = t;
      st.shield = true;
      ev.push({ type: SimEvent.BOOST, data: { level, duration: t } });
      // Forward kick, delivered over the next ~0.1 s (felt at once, no single-frame snap).
      this._p.kickLeft += SIM.BOOST_TIERS[Math.max(level, 1) - 1].kick;
    }
    cb.points = 0;
    cb.mult = 0;
    cb.tricks = [];
  }

  _startAir(jumped) {
    const st = this.state;
    const p = this._p;
    p.phys = 'air';
    p.airPhases++;
    if (p.rampLaunch && !jumped) {
      // Left the run-up early (e.g. off its lip naturally): the pending press becomes a coyote jump.
      p.bufferT = SIM.COYOTE;
    }
    p.rampLaunch = null;
    p.jumped = jumped;
    p.coyoteT = jumped ? 0 : SIM.COYOTE;
    p.takeoffAngle = st.angle;
    p.spinChecked = false;
    p.spinBlocked = false;
    p.flipMinClear = Infinity;
    p.bigAirDone = false;
    st.airTime = 0;
    st.flips = 0;
  }

  /** The ramp whose run-up / lip zone contains x, or null. */
  _onRamp(x) {
    for (const r of this._ramps) {
      if (r.x0 > x) break;
      if (x <= r.lipX + SIM.RAMP_ZONE_AFTER_LIP) return r;
    }
    return null;
  }

  _jump(ev, vx, vy) {
    const st = this.state;
    const p = this._p;
    p.bufferT = 0;
    st.vx = vx;
    const ramp = this._onRamp(st.x);
    st.vy = vy - JUMP_VY - (ramp ? rampPop(ramp.size) : 0);
    this._startAir(true);
    ev.push({ type: SimEvent.JUMP, data: {} });
  }

  _iceAt(x) {
    for (const f of this._lineIdx.query(x, x, this._qa)) {
      if (f.type === FeatureType.GRIND && f.kind === GrindKind.ICE && x >= f.x0 && x < f.x1 - 2) return f;
    }
    return null;
  }

  _startGrind(ev, g) {
    const st = this.state;
    const p = this._p;
    p.phys = 'grind';
    p.grind = g;
    p.grindDist = 0;
    p.grindLen = 0;
    st.airTime = 0;
    st.flips = 0;
    st.angVel = 0;
    // Line chains: each line caught without touching plain snow since the last one escalates.
    p.lineChain = g.kind === GrindKind.ICE ? 1 : p.lineChain + 1;
    ev.push({ type: SimEvent.GRIND_START, data: { featureId: g.id, kind: g.kind } });
    const spec = GRINDS[g.kind] || GRINDS.bunting;
    this._addTrick(ev, 'grind', spec.label + (CHAIN_LABEL[p.lineChain] || ` ×${p.lineChain}`), spec.catch);
  }

  _endGrind(ev) {
    const p = this._p;
    if (!p.grind) return;
    ev.push({ type: SimEvent.GRIND_END, data: { featureId: p.grind.id, length: Math.round(p.grindLen) } });
    // Exit kick: the line's speed is kept and topped up on the way off (bigger in a chain).
    const spec = GRINDS[p.grind.kind] || GRINDS.bunting;
    if (spec.exitKick > 0) p.kickLeft += spec.exitKick + SIM.CHAIN_KICK_STEP * Math.max(0, p.lineChain - 1);
    p.grindCooldownId = p.grind.id;
    p.grindCooldownT = SIM.GRIND_REJUMP_COOLDOWN;
    p.grind = null;
  }

  _lineSlope(g, x) {
    const c = this.course;
    const a = Math.max(g.x0, x - 2);
    const b = Math.min(g.x1, x + 2);
    if (b - a < 1e-6) return 0;
    return (c.grindY(g, b) - c.grindY(g, a)) / (b - a);
  }

  /** True if a free ballistic arc from here ends above the surface (the ground falls away). */
  _fallsAway(x, y, vx, vy) {
    const t = SIM.LEAVE_LOOKAHEAD_TICKS * dt;
    const g = GRAVITY * (this.state.hoverT > 0 ? SIM.HOVER_GRAVITY : 1);
    const bx = x + vx * t;
    const by = y + vy * t + 0.5 * g * t * t;
    return by < this._surf(bx) - SIM.LEAVE_EPS;
  }

  /* ------------------------------------------------------------ ground */

  _ground(held, ev) {
    const st = this.state;
    const p = this._p;
    p.lineChain = 0; // on plain snow: the line chain is over
    const c = this.course;
    const finished = st.finishTick >= 0;
    const th = Math.atan(c.slopeAt(st.x));
    if (p.bufferT > 0 && !finished && !p.rampLaunch) {
      // A press on a pit ramp's run-up launches from its lip (like a buffered press on landing).
      const r = this._pitRampAt(st.x);
      if (r) {
        p.rampLaunch = r;
        p.bufferT = 0;
      }
    }
    const lipNow = p.rampLaunch && st.x >= p.rampLaunch.lipX - SIM.RAMP_LAUNCH_LEAD;
    if ((p.bufferT > 0 || lipNow) && !finished) {
      p.rampLaunch = null;
      this._jump(ev, p.s * Math.cos(th), p.s * Math.sin(th));
      this._air(held, ev, true);
      return;
    }
    const M = this._mult();
    let a = GRAVITY * Math.sin(th) - (DRAG_K / (M * M)) * p.s * Math.abs(p.s);
    if (st.boostT > 0 && p.s < M * Math.max(REF_SPEED * 0.8, terminalSpeed(Math.tan(th)))) a += this._boostPush();
    if (finished) a -= p.s > 0 ? SIM.FINISH_BRAKE : 0;
    else a += this._recoverAccel();
    a -= this._softDrag(p.s * Math.cos(th));
    p.s += a * dt;
    p.s = finished ? Math.max(0, p.s) : clamp(p.s, 20, SIM.MAX_GROUND_SPEED);
    const vx = p.s * Math.cos(th);
    const vy = p.s * Math.sin(th);
    if (p.s > 0 && this._fallsAway(st.x, this._surf(st.x), vx, vy)) {
      st.vx = vx;
      st.vy = vy;
      this._startAir(false);
      this._air(held, ev, true);
      return;
    }
    const px = st.x;
    const py = st.y;
    st.x += vx * dt;
    const th2 = Math.atan(c.slopeAt(st.x));
    st.vx = p.s * Math.cos(th2);
    st.vy = p.s * Math.sin(th2);
    // Board eases onto the slope (fast right after a touchdown); the contact point is lifted so
    // neither tip digs into the snow while it is still tilted.
    const target = this._nearest(th2);
    st.angle = damp(st.angle, target, p.landEaseT > 0 ? SIM.LAND_ANGLE_SHARPNESS : SIM.GROUND_ANGLE_SHARPNESS, dt);
    if (p.wobbleT > 0) st.angle += SIM.WOBBLE_AMP * Math.sin(p.wobbleT * 38) * (p.wobbleT / SIM.WOBBLE_T) * dt * 20;
    st.y = this._surf(st.x) - this._tipLift(st.angle - th2);
    st.angVel = 0;
    if (!finished) {
      const ice = this._iceAt(st.x);
      if (ice) {
        this._startGrind(ev, ice);
        return;
      }
      this._obstacles(px, py, ev, true);
      if (p.phys === 'ground') this._bank(ev);
    }
  }

  /** Extra aerodynamic drag above the soft terminal speed (horizontal speed vx). */
  _softDrag(vx) {
    const e = vx - SIM.SOFT_V;
    return e > 0 ? Math.min(SIM.SOFT_MAX_DECEL, SIM.SOFT_K * e * e) : 0;
  }

  /** "Getting back up to pace": a push below RECOVER_BELOW × cruise, fading out as speed returns. */
  _recoverAccel() {
    const lim = SIM.RECOVER_BELOW * REF_SPEED;
    const s = this._p.s;
    return s < lim ? SIM.RECOVER_ACCEL * (1 - Math.max(0, s) / lim) : 0;
  }

  /* ------------------------------------------------------------ air */

  _air(held, ev, firstTick = false) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    const finished = st.finishTick >= 0;
    if (!firstTick && p.coyoteT > 0) {
      p.coyoteT -= dt;
      if (p.bufferT > 0 && !p.jumped && !finished) this._jump(ev, st.vx, st.vy);
    }
    const hover = st.hoverT > 0;
    // True projectile: constant g, exact integration of the parabola (no vertical drag);
    // only a light horizontal air drag (and the boost's horizontal push) act on vx.
    const g = GRAVITY * (hover ? SIM.HOVER_GRAVITY : 1);
    const M = this._mult();
    st.vx -= ((DRAG_K * SIM.AIR_DRAG_MULT) / (M * M)) * st.vx * Math.abs(st.vx) * dt;
    st.vx -= this._softDrag(st.vx) * dt;
    if (st.boostT > 0 && st.vx > 0 && st.vx < M * REF_SPEED) st.vx += this._boostPush() * dt;
    const px = st.x;
    const py = st.y;
    st.x += st.vx * dt;
    st.y += st.vy * dt + 0.5 * g * dt * dt;
    st.vy += g * dt;
    st.airTime += dt;

    // Rotation with weight: after HOLD_T of continuous hold a torque winds the spin up (capped);
    // released, the spin carries on and decays; near upright a gentle righting torque acts.
    const under = Math.atan(c.slopeAt(st.x));
    let torque = held ? smoothstep(SIM.HOLD_T, SIM.HOLD_T + SIM.FLIP_RAMP_T, p.holdT) : 0;
    if (torque > 0 && !p.spinChecked) {
      // A plain tap-hop has no room for a flip: the held button only tucks.
      p.spinChecked = true;
      p.spinBlocked = this._timeToGround() < SIM.FLIP_MIN_AIR;
    }
    if (p.spinBlocked) torque = 0;
    const rel0 = wrapAngle(st.angle - under);
    if (torque > 0) {
      st.angVel = Math.max(-SIM.FLIP_MAX_RATE, st.angVel - SIM.FLIP_TORQUE * torque * dt);
    } else {
      const dampRate = hover ? Math.max(SIM.OPEN_DAMP, this._releasedDamp(under)) : this._releasedDamp(under);
      st.angVel *= Math.exp(-dampRate * dt);
      const back = under - st.angle - TAU * Math.floor((under - st.angle) / TAU); // φ past the last upright
      if (hover) st.angVel -= SIM.HOVER_RIGHT_GAIN * rel0 * dt;
      else if (back < SIM.EXTEND_ZONE) st.angVel += SIM.RIGHT_GAIN * back * dt; // extended early: pulled back toward the upright behind
      else if (Math.abs(rel0) < SIM.RIGHT_ZONE) st.angVel -= SIM.RIGHT_GAIN * rel0 * dt;
    }
    st.angVel = clamp(st.angVel, -SIM.FLIP_MAX_RATE, SIM.FLIP_MAX_RATE);
    st.angle += st.angVel * dt;

    // Head clearance (proximity flips, head-first crashes).
    const rel = wrapAngle(st.angle - under);
    if (Math.cos(rel) < 0.2) {
      const hx = st.x + RIDER_HEIGHT * Math.sin(st.angle);
      const hy = st.y - RIDER_HEIGHT * Math.cos(st.angle);
      if (!c._chasmAt(hx)) {
        const clear = this._surf(hx) - hy;
        p.flipMinClear = Math.min(p.flipMinClear, clear);
        if (clear < -2 && !hover && !finished) {
          this._crash('landing', ev);
          return;
        }
      }
    }

    // Flips.
    const n = Math.floor((p.takeoffAngle - st.angle + SIM.FLIP_COUNT_TOL) / TAU);
    while (n > st.flips && !finished) {
      st.flips++;
      st.stats.flips++;
      const k = st.flips;
      const bonus = TRICKS.FLIP_BONUS[k] ?? TRICKS.FLIP_BONUS[TRICKS.FLIP_BONUS.length - 1] + 150 * (k - TRICKS.FLIP_BONUS.length + 1);
      this._addTrick(ev, FLIP_NAMES[k] || 'multiBackflip', TRICKS.FLIP_LABELS[k] || `${k}× Backflip`, TRICKS.BACKFLIP + bonus);
      if (p.flipMinClear < SIM.PROXIMITY_DIST) this._addTrick(ev, 'proximity', 'Proximity Flip', TRICKS.PROXIMITY);
      p.flipMinClear = Infinity;
    }
    if (!p.bigAirDone && st.airTime > SIM.BIG_AIR_T && !finished) {
      p.bigAirDone = true;
      this._addTrick(ev, 'bigAir', 'Big Air', TRICKS.BIG_AIR);
    }

    // Pits: dropping below the lips starts the rescue lift.
    const ch = c._chasmAt(st.x);
    if (ch) {
      p.overChasm = ch;
      const lip = ch.y0 + ((ch.y1 - ch.y0) * (st.x - ch.x0)) / (ch.x1 - ch.x0);
      if (st.y > lip + SIM.RESCUE_DEPTH && !finished) {
        this._startRescue(ch, ev);
        return;
      }
    } else if (p.overChasm) {
      const oc = p.overChasm;
      p.overChasm = null;
      if (st.x >= oc.x1) {
        const ground = this._surf(st.x);
        if (st.y > ground + SIM.CHASM_POP_TOL) {
          // Too low at the far wall: the rider drops into the pit.
          st.x = oc.x1 - 2;
          st.vx = Math.min(st.vx, 0);
          this._startRescue(oc, ev);
          return;
        }
        if (st.y > ground) st.y = ground;
        if (!finished) {
          ev.push({ type: SimEvent.CHASM_CLEAR, data: { featureId: oc.id } });
          this._addTrick(ev, 'chasmJump', 'Chasm Jump', TRICKS.CHASM);
          p.kickLeft += TRICKS.CHASM_KICK;
        }
      }
    }

    if (this._catchGrind(px, py, ev)) return;
    if (!finished) {
      this._obstacles(px, py, ev, false);
      if (p.phys !== 'air') return;
    }
    // Touchdown when the lower board tip reaches the snow while coming down onto it (the tip rule
    // is ignored just after take-off, when the tail is still leaving the lip).
    const surfY = this._surf(st.x);
    const vInto = -st.vx * Math.sin(under) + st.vy * Math.cos(under);
    const tipDown = st.airTime > SIM.TIP_GRACE && vInto > 0 && st.y + this._tipLift(st.angle - under) >= surfY;
    if (!ch && (st.y >= surfY || tipDown)) this._land(ev);
  }

  /** Spin decay rate while released: tuck / extend by rotation phase (see SIM.EXTEND_ZONE…). */
  _releasedDamp(under) {
    const d = under - this.state.angle; // back-rotation relative to the slope below
    const phi = d - TAU * Math.floor(d / TAU); // 0 … 2π past the last upright
    if (phi < SIM.EXTEND_ZONE) return SIM.EXTEND_DAMP;
    if (phi < SIM.COMMIT_ANGLE) return SIM.RISKY_DAMP;
    if (phi < TAU - SIM.OPEN_ZONE) return SIM.TUCK_DAMP;
    return SIM.OPEN_DAMP;
  }

  /** Ballistic time until the rider would touch the snow (or 3 s), ignoring drag. */
  _timeToGround() {
    const st = this.state;
    const g = GRAVITY * (st.hoverT > 0 ? SIM.HOVER_GRAVITY : 1);
    const h = 1 / 30;
    for (let t = h; t < 3; t += h) {
      const x = st.x + st.vx * t;
      const y = st.y + st.vy * t + 0.5 * g * t * t;
      if (!this.course._chasmAt(x) && y >= this._surf(x)) return t;
    }
    return 3;
  }

  /** Pit ramp whose run-up contains x (pit ramps have their lip exactly on a pit's near edge). */
  _pitRampAt(x) {
    for (const r of this._ramps) {
      if (r.x0 > x) break;
      if (x < r.lipX - SIM.RAMP_LAUNCH_LEAD && this.course._chasmAt(r.lipX + 1)) return r;
    }
    return null;
  }

  /**
   * Touchdown, graded by the board angle relative to the slope:
   *   (the angle is the worse of now and LAND_SPIN_LOOK ahead at the current spin)
   *   CLEAN   ≤ LAND_CLEAN_ANGLE   — keeps the tangential speed, banks the combo
   *   SKETCHY ≤ LAND_SKETCHY_ANGLE — slides it out: combo lost, small speed loss, wobble
   *   CRASH   beyond (or head-down) — tumbles, sliding along the slope
   * The board then eases onto the slope over ~0.1 s; the contact point never goes below the snow.
   */
  _land(ev) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    const finished = st.finishTick >= 0;
    const th = Math.atan(c.slopeAt(st.x));
    const rel = wrapAngle(st.angle - th);
    // Judged on the worse of the angle now and where the spin is taking the board.
    const ar = Math.max(Math.abs(rel), Math.abs(rel + st.angVel * SIM.LAND_SPIN_LOOK));
    const vt = st.vx * Math.cos(th) + st.vy * Math.sin(th);
    const vn = -st.vx * Math.sin(th) + st.vy * Math.cos(th);
    const impact = clamp(vn / SIM.IMPACT_REF, 0, 1);
    st.y = this._surf(st.x) - this._tipLift(rel);
    const forgiving = finished || st.hoverT > 0;
    const clean = forgiving || ar <= SIM.LAND_CLEAN_ANGLE;
    const sketchy = !clean && ar <= SIM.LAND_SKETCHY_ANGLE;
    if (!clean && !sketchy) {
      ev.push({ type: SimEvent.LAND, data: { clean: false, sketchy: false, impact } });
      this._crash('landing', ev);
      return;
    }
    // A landing keeps the tangential component of the velocity and loses the normal one.
    p.s = Math.max(SIM.MIN_LAND_SPEED, vt) * (sketchy ? 1 - SIM.SKETCHY_LOSS : 1);
    if (st.hoverT > 0) st.angle = this._nearest(th);
    st.angVel = 0;
    p.landEaseT = SIM.LAND_EASE_T;
    p.landSquash = Math.max(p.landSquash, clamp(vn / SIM.SQUASH_REF, 0, 1));
    if (sketchy) {
      p.wobbleT = SIM.WOBBLE_T;
      st.combo.points = 0; // the unbanked combo is lost
      st.combo.mult = 0;
      st.combo.tricks = [];
      ev.push({ type: SimEvent.LAND, data: { clean: false, sketchy: true, impact } });
    } else if (p.jumped || st.airTime >= SIM.MICRO_AIR || st.combo.tricks.length) {
      ev.push({ type: SimEvent.LAND, data: { clean: true, sketchy: false, impact } });
    }
    st.airTime = 0;
    st.flips = 0;
    p.overChasm = null;
    st.vx = p.s * Math.cos(th);
    st.vy = p.s * Math.sin(th);
    const ice = finished ? null : this._iceAt(st.x);
    if (ice) {
      this._startGrind(ev, ice);
      return;
    }
    p.phys = 'ground';
    if (!finished) this._bank(ev);
  }

  _catchGrind(px, py, ev) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    const x = st.x;
    const list = this._lineIdx.query(Math.min(px, x), Math.max(px, x), this._qb);
    for (const g of list) {
      if (g.type !== FeatureType.GRIND || g.kind === GrindKind.ICE) continue;
      if (x < g.x0 || x > g.x1) continue;
      if (g.id === p.grindCooldownId && p.grindCooldownT > 0) continue;
      const ly = c.grindY(g, x);
      const lyPrev = c.grindY(g, clamp(px, g.x0, g.x1));
      if (!(py <= lyPrev + 1 && st.y >= ly - SIM.GRIND_CATCH_TOL)) continue;
      const ls = this._lineSlope(g, x);
      if (st.vy - ls * st.vx <= 0) continue;
      const thL = Math.atan(ls);
      const rel = wrapAngle(st.angle - thL);
      if (Math.abs(rel) > SIM.GRIND_CATCH_ANGLE && st.hoverT <= 0) continue;
      // Catching a line is a landing on it: keep the tangential velocity, lose the normal part.
      p.s = Math.max(SIM.MIN_LAND_SPEED, st.vx * Math.cos(thL) + st.vy * Math.sin(thL));
      st.vx = p.s * Math.cos(thL);
      st.vy = p.s * Math.sin(thL);
      st.y = ly;
      p.landEaseT = SIM.LAND_EASE_T; // board eases onto the line (no snap)
      p.overChasm = null;
      this._startGrind(ev, g);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ grind */

  _grind(held, ev) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    const g = p.grind;
    const finished = st.finishTick >= 0;
    const ice = g.kind === GrindKind.ICE;
    const ls = ice ? c.slopeAt(st.x) : this._lineSlope(g, st.x);
    const th = Math.atan(ls);
    if (p.bufferT > 0 && !finished) {
      this._endGrind(ev);
      this._jump(ev, p.s * Math.cos(th), p.s * Math.sin(th));
      this._air(held, ev, true);
      return;
    }
    const M = this._mult();
    let a = GRAVITY * Math.sin(th) - ((DRAG_K * (ice ? SIM.ICE_DRAG_MULT : SIM.GRIND_DRAG_MULT)) / (M * M)) * p.s * p.s;
    const spec = GRINDS[g.kind] || GRINDS.bunting;
    if (p.s < SIM.GRIND_CAP * M * REF_SPEED) a += spec.accel * (1 + SIM.CHAIN_ACCEL_STEP * Math.max(0, p.lineChain - 1));
    if (st.boostT > 0 && p.s < M * REF_SPEED) a += this._boostPush();
    a += this._recoverAccel();
    a -= this._softDrag(p.s * Math.cos(th));
    p.s = clamp(p.s + a * dt, 40, SIM.MAX_GROUND_SPEED);
    const dx = p.s * Math.cos(th) * dt;
    const nx = st.x + dx;
    st.stats.grindPx += dx;
    p.grindLen += dx;
    p.grindDist += dx;
    while (p.grindDist >= SIM.GRIND_POINTS_EVERY) {
      p.grindDist -= SIM.GRIND_POINTS_EVERY;
      if (!finished) st.combo.points += spec.perStep;
    }
    if (nx >= g.x1) {
      st.x = nx;
      this._endGrind(ev);
      if (ice) {
        st.y = this._surf(st.x);
        p.phys = 'ground';
        const th2 = Math.atan(c.slopeAt(st.x));
        st.vx = p.s * Math.cos(th2);
        st.vy = p.s * Math.sin(th2);
        if (!finished) this._bank(ev);
      } else {
        st.y = c.grindY(g, g.x1);
        st.vx = p.s * Math.cos(th);
        st.vy = p.s * Math.sin(th);
        this._startAir(false);
      }
      return;
    }
    st.x = nx;
    st.y = ice ? this._surf(nx) : c.grindY(g, nx);
    const th2 = Math.atan(ice ? c.slopeAt(nx) : this._lineSlope(g, nx));
    st.vx = p.s * Math.cos(th2);
    st.vy = p.s * Math.sin(th2);
    st.angle = damp(st.angle, this._nearest(th2), p.landEaseT > 0 ? SIM.LAND_ANGLE_SHARPNESS : SIM.GROUND_ANGLE_SHARPNESS, dt);
    st.angVel = 0;
  }

  /* ------------------------------------------------------------ obstacles */

  _obstacles(px, py, ev, onGround) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    if (p.invulnT > 0 || st.hoverT > 0) return;
    const list = this._solidIdx.query(Math.min(px, st.x) - 60, Math.max(px, st.x) + 60, this._qc);
    for (const f of list) {
      const kind = SOLID[f.type];
      if (!kind || this.consumed.has(f.id)) continue;
      let hit = false;
      let bounce = false;
      for (let k = 0; k < 2 && !hit && !bounce; k++) {
        const x = k === 0 ? (px + st.x) / 2 : st.x;
        const y = k === 0 ? (py + st.y) / 2 : st.y;
        const yPrev = k === 0 ? py : (py + st.y) / 2;
        if (kind.box) {
          if (Math.abs(x - f.x) > f.w / 2) continue;
          const top = c.heightAt(x) - f.h;
          // Log Hop: coming down onto the top of a log.
          if (f.type === FeatureType.LOG && !onGround && st.vy > 0 && yPrev <= top + 3 && y >= top - SIM.LOG_HOP_TOL) {
            if (!(p.bounceId === f.id && p.bounceT > 0)) bounce = true;
          } else if (y > top + 1) hit = true;
        } else {
          const r = f.size;
          const cy = c.heightAt(f.x) - r * (f.type === FeatureType.ROCK ? SIM.ROCK_CENTER : 0.5);
          const dx = x - f.x;
          const dy = y - cy;
          const d2 = dx * dx + dy * dy;
          if (f.type === FeatureType.ROCK && !onGround && st.vy > 0 && y < cy && d2 < (r * SIM.ROCK_TOP_ZONE) ** 2) {
            if (!(p.bounceId === f.id && p.bounceT > 0)) bounce = true;
          } else if (d2 < (r * (f.type === FeatureType.ROCK ? SIM.ROCK_HIT : SIM.CAMPFIRE_HIT)) ** 2) hit = true;
        }
      }
      if (bounce) {
        const isLog = f.type === FeatureType.LOG;
        if (isLog) st.y = Math.min(st.y, c.heightAt(st.x) - f.h);
        st.vy = -(isLog ? SIM.LOG_HOP_VY : SIM.ROCK_BOUNCE_VY);
        p.bounceId = f.id;
        p.bounceT = 0.4;
        if (isLog) this._addTrick(ev, 'logHop', 'Log Hop', TRICKS.LOG_HOP);
        else this._addTrick(ev, 'rockBounce', 'Rock Bounce', TRICKS.ROCK_BOUNCE);
        continue;
      }
      if (!hit) continue;
      if (st.shield) {
        this.consumed.add(f.id);
        ev.push({ type: SimEvent.ROCK_SMASH, data: { featureId: f.id, x: f.x, y: c.heightAt(f.x) - (f.h ?? f.size) / 2 } });
        this._addTrick(ev, kind.smash, kind.label, TRICKS.SMASH);
        continue;
      }
      this._crash(f.type, ev, { obstacle: f });
      return;
    }
  }

  /* ------------------------------------------------------------ crash */

  /**
   * Crash: the rider tumbles but keeps sliding (no dead stop). Hitting an obstacle throws the
   * rider up and over it, so the tumble naturally ends beyond it.
   */
  _crash(cause, ev, info = {}) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    ev.push({ type: SimEvent.CRASH, data: { cause, x: st.x, y: st.y } });
    if (p.grind) this._endGrind(ev);
    this._loseRun(true);
    const th = Math.atan(c.slopeAt(st.x));
    const vt = Math.max(0, st.vx * Math.cos(th) + st.vy * Math.sin(th));
    p.phys = 'crashed';
    p.crashCause = cause;
    p.crashT = SIM.CRASH_T;
    p.overChasm = null;
    p.kickLeft = 0;
    p.rampLaunch = null;
    if (info.obstacle) {
      // Thrown over the obstacle: keep most of the forward speed, pop up.
      st.vx = Math.max(st.vx * SIM.CRASH_KEEP, SIM.CRASH_MIN_THROW * REF_SPEED);
      st.vy = Math.min(st.vy, -SIM.CRASH_THROW_VY);
      st.y = Math.min(st.y, this._surf(st.x));
      p.s = 0;
    } else {
      p.s = vt * SIM.CRASH_KEEP;
      if (st.y >= this._surf(st.x) - 1) {
        st.y = this._surf(st.x);
        st.vx = p.s * Math.cos(th);
        st.vy = p.s * Math.sin(th);
      }
    }
    st.angVel = st.angVel < -2 ? -SIM.CRASH_SPIN : SIM.CRASH_SPIN;
  }

  /** Loses the run state shared by crashes and rescues (combo, boost; crashes also reset the scarf). */
  _loseRun(resetScarf) {
    const st = this.state;
    const p = this._p;
    p.lineChain = 0;
    st.stats.crashes++;
    st.combo.points = 0;
    st.combo.mult = 0;
    st.combo.tricks = [];
    if (resetScarf) st.scarf = 0;
    st.boostT = 0;
    st.boostLevel = 0;
    st.shield = false;
    p.boostEff = 0;
    st.flips = 0;
    st.airTime = 0;
  }

  _crashed(ev) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    p.crashT -= dt;
    const th = Math.atan(c.slopeAt(st.x));
    if (p.crashT < SIM.CRASH_GETUP_T) {
      // Getting up: spin settles and the board comes back onto the slope.
      st.angVel = damp(st.angVel, 0, 12, dt);
      st.angle = damp(st.angle, this._nearest(th), 14, dt);
    } else st.angVel *= Math.exp(-SIM.CRASH_SPIN_DECAY * dt);
    st.angle += st.angVel * dt;
    const ground = this._surf(st.x);
    let airborne = st.y < ground - 0.5 || c._chasmAt(st.x);
    if (airborne) {
      st.vx -= ((DRAG_K * SIM.AIR_DRAG_MULT) * st.vx * Math.abs(st.vx)) * dt;
      st.x += st.vx * dt;
      st.y += st.vy * dt + 0.5 * GRAVITY * dt * dt;
      st.vy += GRAVITY * dt;
      const ch = c._chasmAt(st.x);
      if (ch) {
        const lip = ch.y0 + ((ch.y1 - ch.y0) * (st.x - ch.x0)) / (ch.x1 - ch.x0);
        if (st.y > lip + SIM.RESCUE_DEPTH) {
          this._startRescue(ch, ev, true);
          return;
        }
      } else if (st.y >= this._surf(st.x)) {
        // Tumbling touchdown: keep sliding along the slope (tangential part of the velocity).
        const t2 = Math.atan(c.slopeAt(st.x));
        p.s = Math.max(0, st.vx * Math.cos(t2) + st.vy * Math.sin(t2));
        st.y = this._surf(st.x);
        st.vx = p.s * Math.cos(t2);
        st.vy = p.s * Math.sin(t2);
        airborne = false;
      }
    } else {
      // Sliding tumble: decelerate toward a getting-up pace along the slope (never a dead stop).
      p.s = damp(p.s, SIM.CRASH_SLIDE_TO * REF_SPEED, SIM.CRASH_SLIDE_RATE, dt);
      st.vx = p.s * Math.cos(th);
      st.vy = p.s * Math.sin(th);
      st.x += st.vx * dt;
      if (c._chasmAt(st.x)) {
        // Slid over a pit lip: fall (the air branch handles the rescue).
        st.y += 1;
      } else st.y = this._surf(st.x);
    }
    if (p.crashT <= 0 && !airborne) this._respawn(ev);
  }

  /** Back on the board where the tumble ended, already moving. */
  _respawn(ev) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    let x = st.x;
    // Only if the tumble ended inside an obstacle: step past it.
    for (let iter = 0; iter < 6; iter++) {
      let moved = false;
      for (const f of this._solidIdx.query(x - 120, x + 120, this._qd)) {
        const half = f.w ? f.w / 2 : f.size;
        if (SOLID[f.type] && !this.consumed.has(f.id) && Math.abs(f.x - x) < half + 4) {
          x = f.x + half + SIM.RESPAWN_CLEAR;
          moved = true;
        }
      }
      if (!moved) break;
    }
    x = Math.min(x, c.maxX - 20);
    const th = Math.atan(c.slopeAt(x));
    st.x = x;
    st.angle = this._nearest(th);
    st.y = this._surf(x);
    st.angVel = 0;
    p.s = Math.max(p.s, SIM.RESPAWN_MIN_FRAC * REF_SPEED);
    st.vx = p.s * Math.cos(th);
    st.vy = p.s * Math.sin(th);
    p.phys = 'ground';
    p.invulnT = SIM.RESPAWN_INVULN;
    p.bufferT = 0;
    ev.push({ type: SimEvent.RESPAWN, data: { x: st.x, y: st.y } });
  }

  /* ------------------------------------------------------------ pit rescue */

  /**
   * Fell into a pit: a 3 s lift carries the rider out and across (cubic Bézier: straight up out
   * of the pit, an arc over it, set down on the far lip moving along the slope). Scarf survives;
   * combo and boost are lost; counted in stats.crashes.
   */
  _startRescue(ch, ev, fromCrash = false) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    if (p.grind) this._endGrind(ev);
    if (!fromCrash || p.phys !== 'crashed') this._loseRun(false);
    p.kickLeft = 0;
    p.overChasm = null;
    p.rampLaunch = null;
    const toX = ch.x1 + SIM.RESCUE_LAND_OFFSET;
    const toY = c.heightAt(toX);
    const top = Math.min(ch.y0, ch.y1) - SIM.RESCUE_ARC_H;
    const thEnd = Math.atan(c.slopeAt(toX));
    const lead = SIM.RESCUE_LEAD;
    p.rescue = {
      ch,
      t: 0,
      P0: { x: st.x, y: st.y },
      // Rise out of the pit first (staying clear of the far wall), then arc across.
      P1: { x: Math.min(st.x + 0.1 * (toX - st.x), ch.x1 - 30), y: top },
      P2: { x: toX - lead * Math.cos(thEnd), y: Math.min(top + 40, toY - lead * Math.sin(thEnd) - SIM.RESCUE_SETDOWN_H) },
      P3: { x: toX, y: toY },
      a0: st.angle,
      a1: this._nearest(thEnd),
    };
    // End speed along the path = release speed (continuous hand-off).
    const r = p.rescue;
    const tail = 3 * Math.sqrt((r.P3.x - r.P2.x) * (r.P3.x - r.P2.x) + (r.P3.y - r.P2.y) * (r.P3.y - r.P2.y));
    r.m = (SIM.RESCUE_RELEASE * REF_SPEED * SIM.RESCUE_T) / tail;
    p.phys = 'rescue';
    st.angVel = 0;
    ev.push({ type: SimEvent.RESCUE_START, data: { featureId: ch.id, duration: SIM.RESCUE_T, toX, toY } });
  }

  _rescue(ev) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    const r = p.rescue;
    r.t += dt;
    const u = Math.min(1, r.t / SIM.RESCUE_T);
    // Time warp e(u): eases in from rest, leaves with slope m (matching the release speed).
    const e = -2 * u * u * u + 3 * u * u + r.m * (u * u * u - u * u);
    const de = (-6 * u * u + 6 * u + r.m * (3 * u * u - 2 * u)) / SIM.RESCUE_T;
    const q = 1 - e;
    const { P0, P1, P2, P3 } = r;
    st.x = q * q * q * P0.x + 3 * q * q * e * P1.x + 3 * q * e * e * P2.x + e * e * e * P3.x;
    st.y = q * q * q * P0.y + 3 * q * q * e * P1.y + 3 * q * e * e * P2.y + e * e * e * P3.y;
    const dx = 3 * q * q * (P1.x - P0.x) + 6 * q * e * (P2.x - P1.x) + 3 * e * e * (P3.x - P2.x);
    const dy = 3 * q * q * (P1.y - P0.y) + 6 * q * e * (P2.y - P1.y) + 3 * e * e * (P3.y - P2.y);
    st.vx = dx * de;
    st.vy = dy * de;
    const settle = smoothstep(0, 0.6, u);
    st.angle = r.a0 + (r.a1 - r.a0) * settle + SIM.RESCUE_SWAY * Math.sin(TAU * 1.1 * r.t) * Math.sin(Math.PI * u);
    if (u >= 1) {
      const th = Math.atan(c.slopeAt(st.x));
      st.y = this._surf(st.x);
      st.angle = r.a1;
      p.s = SIM.RESCUE_RELEASE * REF_SPEED;
      st.vx = p.s * Math.cos(th);
      st.vy = p.s * Math.sin(th);
      p.phys = 'ground';
      p.invulnT = SIM.RESPAWN_INVULN;
      p.bufferT = 0;
      p.rescue = null;
      ev.push({ type: SimEvent.RESPAWN, data: { x: st.x, y: st.y } });
    }
  }

  /* ------------------------------------------------------------ pickups */

  _pickups(ev) {
    const st = this.state;
    const p = this._p;
    const bx = st.x + BODY_CENTER * Math.sin(st.angle);
    const by = st.y - BODY_CENTER * Math.cos(st.angle);
    const magnet = st.magnetT > 0;
    const R = magnet ? SIM.MAGNET_RADIUS : SIM.PICKUP_RADIUS;
    for (const f of this._pickIdx.query(bx - R, bx + R, this._qe)) {
      if (f.type !== FeatureType.PICKUP || this.consumed.has(f.id)) continue;
      const rr = f.kind === PickupKind.COIN ? R : SIM.PICKUP_RADIUS;
      const dx = f.x - bx;
      const dy = f.y - by;
      if (dx * dx + dy * dy > rr * rr) continue;
      this.consumed.add(f.id);
      ev.push({ type: SimEvent.PICKUP, data: { featureId: f.id, kind: f.kind, x: f.x, y: f.y } });
      if (f.kind === PickupKind.COIN) {
        st.stats.coins++;
        st.scarf = Math.min(1, st.scarf + SIM.SCARF_PER_COIN);
        p.kickLeft += TRICKS.COIN_KICK;
        if (p.phys === 'air' || p.phys === 'grind') st.combo.points += TRICKS.COIN;
        else st.stats.score += TRICKS.COIN;
      } else if (f.kind === PickupKind.FEATHER) {
        st.hoverT = SIM.HOVER_T;
      } else if (f.kind === PickupKind.MAGNET) {
        st.magnetT = SIM.MAGNET_T;
      }
    }
  }

  /* ------------------------------------------------------------ derived */

  _derive(held) {
    const st = this.state;
    const p = this._p;
    const c = this.course;
    st.speed = Math.sqrt((st.vx) * (st.vx) + (st.vy) * (st.vy));
    if (st.speed > st.stats.topSpeed) st.stats.topSpeed = st.speed;
    st.progress = clamp((st.x - c.startX) / c.length, 0, 1);
    let target = 0.2;
    if (p.phys === 'air') target = held ? 1 : 0.35;
    else if (p.phys === 'grind') target = 0.55;
    else if (p.phys === 'crashed' || p.phys === 'rescue') target = 0;
    else target = clamp(0.2 + 0.7 * p.landSquash + (p.wobbleT > 0 ? 0.25 : 0), 0, 1);
    // Squash dips fast on impact, recovers more slowly.
    st.crouch = damp(st.crouch, target, target > st.crouch ? 30 : 10, dt);
    if (p.phys === 'rescue') st.mode = RiderMode.RESCUE;
    else if (p.phys === 'crashed') st.mode = RiderMode.CRASHED;
    else if (st.finishTick >= 0) st.mode = RiderMode.FINISHED;
    else st.mode = p.phys === 'air' ? RiderMode.AIR : p.phys === 'grind' ? RiderMode.GRIND : RiderMode.GROUND;
  }
}
