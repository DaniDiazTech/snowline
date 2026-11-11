/**
 * Riders: a small stylised snowboarder + a long flowing scarf.
 *
 * Pose — a tiny skeleton in board-local coordinates (x forward, y down,
 * origin = contact point, bottom-centre of the board) blended from the mode:
 * upright carve with bent knees, tuck when crouch → 1, arms out in the air /
 * on a grind, flailing tumble when crashed, arm up when finished. The whole
 * figure is rotated by the board angle, so backflips just work.
 *
 * Scarf — per rider id a verlet chain (SEGMENTS points) anchored at the neck,
 * simulated in world space with air drag, gravity and a travelling ripple.
 * Drag against still air is what makes it stream behind at speed. Segment
 * length scales with RiderView.scarf (stub → long streamer). Chains of ids
 * that stop appearing are dropped.
 */
import { clamp, lerp } from '../math/utils.js';
import { RiderMode } from '../contracts.js';
import { RIDER_HEIGHT } from '../math/physics.js';
import { hex, mix, rgba } from './color.js';

const SEGMENTS = 16;
const SUBSTEP = 1 / 120;
const TAU = Math.PI * 2;
/** The skeleton below is authored ~43.5 px board-to-head-top; scale it to the sim's rider height. */
const K = RIDER_HEIGHT / 43.5;

export class RiderRenderer {
  constructor() {
    this.scarves = new Map();
    /** per rider id: smoothed visual state (drawn angle, blended joints, landing/wobble timers, rescue) */
    this.vis = new Map();
    /** balloons released after a rescue, drifting away */
    this.departing = [];
    this.frame = 0;
    // scratch joint storage (no per-frame allocation)
    this.J = {};
    for (const k of ['f1', 'f2', 'k1', 'k2', 'h', 'n', 'hd', 'e1', 'e2', 'a1', 'a2']) this.J[k] = { x: 0, y: 0 };
  }

  reset() {
    this.scarves.clear();
    this.vis.clear();
    this.departing.length = 0;
    this.flares = new Map();
  }

  /** Landing feedback hook (local rider's LAND event): squash + lean-back, wobble when sketchy. */
  landed(id, impact, sketchy) {
    const vs = this.vis.get(id);
    if (!vs) return;
    vs.landAge = 0;
    vs.landK = clamp(impact, 0.15, 1);
    if (sketchy) vs.wobbleAge = 0;
  }

  /** Boost hit: the scarf flares long and bright for a moment. */
  flare(id, level) {
    if (!this.flares) this.flares = new Map();
    this.flares.set(id, { amt: 0.4 + 0.2 * level, t: 0 });
  }

  flareOf(id, dt) {
    const f = this.flares && this.flares.get(id);
    if (!f) return 0;
    f.amt *= Math.exp(-dt / 0.6);
    if (f.amt < 0.01) {
      this.flares.delete(id);
      return 0;
    }
    return f.amt;
  }

  /** Drops scarf state of riders not drawn for a while. Call once per frame after drawing. */
  sweep() {
    this.frame++;
    for (const [id, s] of this.scarves) if (this.frame - s.seen > 30) this.scarves.delete(id);
    for (const [id, s] of this.vis) if (this.frame - s.seen > 30) this.vis.delete(id);
  }

  /** Computes the TARGET joints (board-local) for the current mode into this.J. */
  pose(v, t, vs) {
    const J = this.J;
    const mode = v.mode;
    const rescue = mode === RiderMode.RESCUE;
    const crashed = mode === RiderMode.CRASHED;
    const air = mode === RiderMode.AIR;
    const grind = mode === RiderMode.GRIND;
    const idle = mode === RiderMode.IDLE;
    const finished = mode === RiderMode.FINISHED;
    let c = clamp(v.crouch || 0, 0, 1);
    if (grind) c = Math.max(c, 0.55);
    if (idle) c = 0.05;
    if (crashed) c = Math.max(c, 0.7); // tucked roll
    if (rescue) c = 0.12;
    // landing: knees absorb — deeper and a little longer for heavier impacts, no overshoot
    const la = vs ? vs.landAge : 9;
    const lk = vs ? vs.landK : 0;
    const squash = la < 0.9 ? lk * (la < 0.06 ? la / 0.06 : Math.exp(-(la - 0.06) / (0.11 + 0.16 * lk))) : 0;
    c = c + squash * 0.75;
    // take-off: a quick compress carried into a spring/extension (legs straighten)
    const tk = vs ? vs.takeoffAge : 9;
    if (air && tk < 0.24) c += tk < 0.05 ? 0.45 * (1 - tk / 0.05) : -0.25 * Math.sin((Math.PI * (tk - 0.05)) / 0.19);
    // air: the flip phase decides the tuck (knees to chest when tucked, extended otherwise)
    const tuck = air && vs ? vs.tuck : 0;
    if (air) c = (tk < 0.24 ? c - clamp(v.crouch || 0, 0, 1) : 0) + 0.15 + 0.85 * tuck;
    c = clamp(c, -0.25, 1);
    const wa = vs ? vs.wobbleAge : 9;
    const wobble = wa < 0.45 ? 1 - wa / 0.45 : 0;
    const bob = mode === RiderMode.GROUND ? Math.sin(t * 6.5) * 0.4 : 0;

    set(J.f1, -7.5, -3);
    set(J.f2, 7.5, -3);
    set(J.h, -1 + 2.5 * c + squash * 2, -21 + 8.5 * c + bob);
    const kneeOut = 2.5 + 3 * c;
    set(J.k1, (J.f1.x + J.h.x) / 2 + kneeOut * 0.6, (J.f1.y + J.h.y) / 2 + 0.5);
    set(J.k2, (J.f2.x + J.h.x) / 2 + kneeOut, (J.f2.y + J.h.y) / 2 - 0.5);
    // landing shifts the weight slightly forward; in the air, descending with little spin = spotting the landing
    const spot = air && vs && vs.spot && tuck < 0.5 ? 0.18 : 0;
    let lean = 0.14 + 0.62 * Math.max(0, c) + (air ? 0.06 : 0) + squash * 0.22 + spot;
    if (crashed) lean = 0.9 + Math.sin(t * 9) * 0.25;
    if (finished || rescue) lean = 0.02;
    if (grind) lean += 0.18;
    lean += Math.sin(wa * 30) * 0.28 * wobble;
    const tl = 12.5 - 2 * c;
    set(J.n, J.h.x + Math.sin(lean) * tl, J.h.y - Math.cos(lean) * tl);
    // head leads the rotation a touch (and looks down at the landing when spotting)
    const lead = vs ? clamp(vs.omega * 0.05, -0.32, 0.32) + spot * 0.8 : 0;
    set(J.hd, J.n.x + Math.sin(lean + lead) * 5.2 + 0.6, J.n.y - Math.cos(lean + lead) * 5.2);

    // hands/elbows relative to the neck
    let a1x;
    let a1y;
    let a2x;
    let a2y;
    if (rescue) {
      // both hands up on the rope
      a1x = -1.5;
      a1y = -15;
      a2x = 2;
      a2y = -16;
    } else if (wobble > 0) {
      // sketchy landing: arms windmill to catch the balance
      const ang = wa * 24;
      a1x = Math.cos(ang) * 12;
      a1y = Math.sin(ang) * 10 - 2;
      a2x = Math.cos(ang + Math.PI) * 12;
      a2y = Math.sin(ang + Math.PI) * 10 - 2;
    } else if (crashed) {
      // tumbling: arms flailing close to the body
      a1x = Math.cos(t * 11) * 8;
      a1y = Math.sin(t * 11) * 8;
      a2x = Math.cos(t * 13 + 2) * 8;
      a2y = Math.sin(t * 13 + 2) * 8;
    } else if (air) {
      const flap = Math.sin(t * 5) * 1.5;
      a1x = -12;
      a1y = -2 + flap;
      a2x = 12.5;
      a2y = -3.5 - flap;
      // spinning: arms come in, and at high spin the hands grab the board
      const g = Math.max(clamp(c, 0, 1) * 0.6, tuck);
      a1x = lerp(a1x, J.h.x - J.n.x - 2, g);
      a1y = lerp(a1y, J.h.y - J.n.y + 9, g);
      a2x = lerp(a2x, J.h.x - J.n.x + 6, g);
      a2y = lerp(a2y, J.h.y - J.n.y + 10, g);
    } else if (grind) {
      // fast line: rear arm trailing low behind, front arm forward for balance
      a1x = -14;
      a1y = 4 + Math.sin(t * 9) * 0.8;
      a2x = 11;
      a2y = 1 - Math.sin(t * 9) * 0.8;
    } else if (finished) {
      a1x = -8;
      a1y = 7;
      a2x = 5;
      a2y = -12 + Math.sin(t * 6) * 1.5;
    } else if (idle) {
      a1x = -3;
      a1y = 11;
      a2x = 4;
      a2y = 11;
    } else {
      // carving: arms loosely out for balance, tucked a bit when crouching
      a1x = lerp(-9.5, -6, c);
      a1y = lerp(7, 9, c);
      a2x = lerp(10, 9, c);
      a2y = lerp(5, 8, c);
    }
    set(J.a1, J.n.x + a1x, J.n.y + 1 + a1y);
    set(J.a2, J.n.x + a2x, J.n.y + 1 + a2y);
    // elbows: halfway, pushed down/out a little
    set(J.e1, (J.n.x + J.a1.x) / 2 - 1, (J.n.y + J.a1.y) / 2 + 2.2);
    set(J.e2, (J.n.x + J.a2.x) / 2 + 1, (J.n.y + J.a2.y) / 2 + 2.2);
    return J;
  }

  /**
   * Draws one rider (world transform already applied).
   * @param {Object} v RiderView
   * @param {Object} P palette
   * @param {number} dt seconds since the previous frame
   */
  /** Smoothed visual state of a rider (created on first sight). */
  visOf(v) {
    let vs = this.vis.get(v.id);
    if (!vs) {
      vs = { a: v.angle, prevTarget: v.angle, prevRaw: v.angle, omega: 0, rot: 0, tuck: 0, takeoffAge: 9, baseA: v.angle, airW: 0, j: null, lift: 0, landAge: 9, landK: 0, wobbleAge: 9, prevMode: v.mode, prevVy: v.vy, rescueAge: 9, seen: 0 };
      this.vis.set(v.id, vs);
    }
    return vs;
  }

  draw(ctx, v, P, dt) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return;
    const t = P.t;
    const vs = this.visOf(v);
    vs.seen = this.frame;
    const mode = v.mode;
    // timers + transitions
    vs.landAge += dt;
    vs.wobbleAge += dt;
    vs.takeoffAge += dt;
    // angular velocity from successive angles (rad/s), lightly smoothed; jumps are ignored
    if (dt > 0) {
      const dA = wrapAngle(v.angle - vs.prevRaw);
      const w = Math.abs(dA) < 0.6 ? dA / dt : vs.omega;
      vs.omega += (w - vs.omega) * (1 - Math.exp(-dt * 14));
    }
    // back-rotation accumulated since take-off (a backflip decreases the angle → positive)
    if (mode === RiderMode.AIR && dt > 0) {
      const dA = wrapAngle(v.angle - vs.prevRaw);
      if (Math.abs(dA) < 0.6) vs.rot -= dA;
    }
    vs.prevRaw = v.angle;
    if (mode === RiderMode.AIR && (vs.prevMode === RiderMode.GROUND || vs.prevMode === RiderMode.GRIND || vs.prevMode === RiderMode.IDLE)) {
      vs.takeoffAge = 0;
      vs.baseA = vs.a;
      vs.rot = 0;
      if (this.onTakeoff) this.onTakeoff(v);
    }
    if ((vs.prevMode === RiderMode.AIR) && (mode === RiderMode.GROUND || mode === RiderMode.FINISHED) && vs.landAge > 0.25) {
      // touchdown seen without an event (ghosts): squash by how hard it came down
      vs.landAge = 0;
      vs.landK = clamp((vs.prevVy - 250) / 900, 0.2, 0.9);
    }
    if (mode === RiderMode.RESCUE) {
      if (vs.prevMode !== RiderMode.RESCUE) vs.rescueAge = 0;
      else vs.rescueAge += dt;
    } else if (vs.prevMode === RiderMode.RESCUE) {
      // set down: the balloon lets go and drifts away
      if (this.departing.length < 16) this.departing.push({ x: v.x, y: v.y - 46 * K - 70, color: v.color, age: 0, ghost: !v.isLocal });
    }

    // tuck by flip phase (mirrors the sim): held → wind-up tuck; released → extend (< 120°),
    // risky (120–160°), tucked carry (160–275°), open up / spot the landing (last 85°)
    {
      let want = 0;
      if (mode === RiderMode.AIR) {
        const w = Math.abs(vs.omega);
        const held = (v.crouch || 0) > 0.75;
        const phi = ((vs.rot % TAU) + TAU) % TAU;
        const deg = (phi * 180) / Math.PI;
        if (held && (w > 0.5 || vs.rot > 0.1)) want = 0.55 + 0.45 * smooth(2, 7, w);
        else if (held) want = 0.45; // holding before the torque kicks in: crouched, ready
        else if (w > 1.2 || vs.rot > 0.3) {
          if (deg < 120) want = 0;
          else if (deg < 160) want = 0.5;
          else if (deg < 275) want = 1;
          else want = 1 - smooth(275, 330, deg);
        }
        vs.spot = !held && ((vs.rot > 0.3 && deg >= 275) || (w < 1.2 && v.vy > 120));
      } else vs.spot = false;
      vs.tuck += (want - vs.tuck) * (1 - Math.exp(-dt * 14));
    }

    // target joints, then cross-fade (≈150 ms) from what was drawn last frame
    const J = this.pose(v, t, vs);
    const keys = JOINTS;
    if (!vs.j) {
      vs.j = new Float32Array(keys.length * 2);
      for (let i = 0; i < keys.length; i++) {
        vs.j[i * 2] = J[keys[i]].x;
        vs.j[i * 2 + 1] = J[keys[i]].y;
      }
    } else {
      const k = this.noSmooth ? 1 : 1 - Math.exp(-dt * 20);
      for (let i = 0; i < keys.length; i++) {
        const p = J[keys[i]];
        vs.j[i * 2] += (p.x - vs.j[i * 2]) * k;
        vs.j[i * 2 + 1] += (p.y - vs.j[i * 2 + 1]) * k;
        p.x = vs.j[i * 2];
        p.y = vs.j[i * 2 + 1];
      }
    }

    // drawn angle: follow steady rotation without lag (predict by the target's own change),
    // and ease away any jump (snap to the slope at touchdown, mode changes) over ~70 ms
    let target = v.angle;
    if (mode === RiderMode.RESCUE) target = 0.22 + Math.sin(t * 1.7 + 0.5) * 0.12;
    let dTarget = wrapAngle(target - vs.prevTarget);
    if (Math.abs(dTarget) > 0.6) dTarget = 0; // a jump, not a spin: let the easing handle it
    vs.a += dTarget;
    vs.a += wrapAngle(target - vs.a) * (this.noSmooth ? 1 : 1 - Math.exp(-dt * 15));
    vs.prevTarget = target;
    const ang = vs.a;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);

    // airborne rotation pivots about the centre of mass (≈ hip height), not the board: the
    // board is drawn where the body's spin puts it. The reference orientation follows the drawn
    // angle whenever the rider is not spinning, so take-off and touchdown line up exactly.
    const spinNow = smooth(1.2, 5.2, Math.abs(vs.omega));
    vs.airW += ((mode === RiderMode.AIR ? 1 : 0) - vs.airW) * (1 - Math.exp(-dt * (mode === RiderMode.AIR ? 12 : 30)));
    vs.baseA += wrapAngle(ang - vs.baseA) * (1 - Math.exp(-dt * 7 * (1 - spinNow)));
    let ox = 0;
    let oy = 0;
    if (vs.airW > 0.001 && !this.noSmooth) {
      const hC = COM_H * K;
      // contact' = contact + R(baseA)·(0,-h) − R(ang)·(0,-h)
      ox = (Math.sin(vs.baseA) - sa) * hC * vs.airW;
      oy = (-Math.cos(vs.baseA) + ca) * hC * vs.airW;
    }

    // ground contact: lift the drawn rider so the lowest board tip (or, tumbling, any limb)
    // rests on the snow line instead of cutting into it. Rises instantly, settles smoothly.
    let need = 0;
    if (this.groundAt && mode !== RiderMode.RESCUE && mode !== RiderMode.GRIND) {
      const pts = mode === RiderMode.CRASHED ? CONTACT_CRASH : CONTACT_BOARD;
      for (let i = 0; i < pts.length; i += 3) {
        let lx = pts[i];
        let ly = pts[i + 1];
        if (pts[i] === 999) {
          const p = J[CONTACT_JOINTS[pts[i + 1]]];
          lx = p.x;
          ly = p.y;
        }
        const wx = v.x + ox + (lx * ca - ly * sa) * K;
        const wy = v.y + oy + (lx * sa + ly * ca) * K + pts[i + 2] * K;
        // the TRUE surface (pit floor inside a gap), so a rider falling into a pit is not held up
        const pen = wy - ((this.surfaceAt ? this.surfaceAt(wx) : this.groundAt(wx)) + 0.5);
        if (pen > need) need = pen;
      }
      need = Math.min(need, 40);
    }
    vs.lift = this.noSmooth ? 0 : need >= vs.lift ? need : vs.lift + (need - vs.lift) * (1 - Math.exp(-dt * 14));
    const X = v.x + ox;
    const Y = v.y + oy - vs.lift;
    vs.prevMode = mode;
    vs.prevVy = v.vy;

    if (mode === RiderMode.RESCUE) this.drawBalloon(ctx, v, vs, X, Y, J, ca, sa, P);

    const ghost = !v.isLocal;
    // ghosts: a touch lighter than the local rider, but never below a minimum contrast with
    // the snow / haze behind them (fog, dusk on bright snow)
    const body = ghost ? rgba(this.ghostBody(P)) : rgba(P.sil);
    // neck in world space (scarf anchor)
    const nx = X + (J.n.x * ca - J.n.y * sa) * K;
    const ny = Y + (J.n.x * sa + J.n.y * ca) * K;

    const boost = v.boostLevel || 0;
    const flare = this.flareOf(v.id, dt);
    this.curFlare = flare;
    const scarfCol = mix(mix(hex(v.color), P.sil, 0.12 + P.night * 0.2), [255, 255, 255], Math.min(0.7, (boost ? 0.12 + boost * 0.06 : 0) + flare * 0.6));
    const s = this.scarf(v, nx, ny, dt, t);
    this.t = t;
    this.flow = clamp(Math.hypot(v.vx, v.vy) / 1000 + Math.abs(vs.omega) * 0.1, 0, 1.6);
    this.phase = v.isLocal ? 0 : (v.id.length * 1.7) % 6.28;

    // at night a faint cool halo keeps the dark silhouette readable against dark ridges
    if (P.night > 0.3) {
      const hx = X + sa * 18;
      const hy = Y - ca * 18;
      const R = 46;
      const g = ctx.createRadialGradient(hx, hy, 4, hx, hy, R);
      const a = (P.night - 0.3) * (ghost ? 0.18 : 0.32);
      g.addColorStop(0, rgba(P.snow, a));
      g.addColorStop(1, rgba(P.snow, 0));
      ctx.fillStyle = g;
      ctx.fillRect(hx - R, hy - R, R * 2, R * 2);
    }
    // boost aura behind the rider
    if (boost && !ghost) P.glow(X - v.vx * 0.02, Y - 22, 46 + boost * 10, 0.22 + boost * 0.1, hex(v.color));

    // scarf goes behind the body
    this.drawScarf(ctx, s, scarfCol, ghost ? 0.92 : 1, boost + flare * 4, v);

    ctx.save();
    ctx.translate(X, Y);
    ctx.rotate(ang);
    ctx.scale(K, K);
    // board
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-15.5, -4.2);
    ctx.quadraticCurveTo(-17.5, -4.2, -17, -1.6);
    ctx.quadraticCurveTo(-16, 0, -13, 0);
    ctx.lineTo(13, 0);
    ctx.quadraticCurveTo(16, 0, 17, -1.6);
    ctx.quadraticCurveTo(17.5, -4.2, 15.5, -4.2);
    ctx.closePath();
    ctx.fill();
    // a thin coloured stripe on the board for character
    ctx.fillStyle = rgba(scarfCol, ghost ? 0.6 : 0.9);
    ctx.fillRect(-11, -2.6, 22, 1.1);

    ctx.strokeStyle = body;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // legs
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.moveTo(J.f1.x, J.f1.y);
    ctx.lineTo(J.k1.x, J.k1.y);
    ctx.lineTo(J.h.x, J.h.y);
    ctx.lineTo(J.k2.x, J.k2.y);
    ctx.lineTo(J.f2.x, J.f2.y);
    ctx.stroke();
    // torso (jacket: slightly wider)
    ctx.lineWidth = 7.2;
    ctx.beginPath();
    ctx.moveTo(J.h.x, J.h.y);
    ctx.lineTo(J.n.x, J.n.y + 1);
    ctx.stroke();
    // arms
    ctx.lineWidth = 3.1;
    ctx.beginPath();
    ctx.moveTo(J.n.x, J.n.y + 1.5);
    ctx.lineTo(J.e1.x, J.e1.y);
    ctx.lineTo(J.a1.x, J.a1.y);
    ctx.moveTo(J.n.x, J.n.y + 1.5);
    ctx.lineTo(J.e2.x, J.e2.y);
    ctx.lineTo(J.a2.x, J.a2.y);
    ctx.stroke();
    // head + beanie with a bobble
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(J.hd.x, J.hd.y, 4.5, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(J.hd.x - 1.6, J.hd.y - 4.8, 1.9, 0, TAU);
    ctx.fill();
    ctx.restore();

    this.drawn = { x: X, y: Y, angle: ang, hx: X + (J.hd.x * ca - J.hd.y * sa) * K, hy: Y + (J.hd.x * sa + J.hd.y * ca) * K, pen: need };
    if (v.shield) this.drawShield(ctx, v, P, ghost);
    if (v.hover) this.drawHover(ctx, v, P);
    s.seen = this.frame;
  }

  scarf(v, ax, ay, dt, t) {
    let s = this.scarves.get(v.id);
    const amt = clamp(v.scarf ?? 0, 0, 1);
    // in calm air (start line) the scarf is a shorter, lighter streamer
    const calmL = Math.max(0, 1 - clamp(Math.hypot(v.vx, v.vy) / 900, 0, 1.4) * 2);
    const L = lerp(2.0, 7.2, amt) * (1 - 0.4 * calmL) * (1 + 0.6 * (this.curFlare || 0));
    if (!s || Math.hypot(ax - s.ax, ay - s.ay) > 260) {
      s = s || { px: new Float32Array(SEGMENTS), py: new Float32Array(SEGMENTS), ox: new Float32Array(SEGMENTS), oy: new Float32Array(SEGMENTS), acc: 0, seen: 0, ax, ay };
      // lay it out trailing behind the velocity, pre-moving so it starts streaming
      const sp = Math.hypot(v.vx, v.vy);
      const dx = sp > 20 ? -v.vx / sp : -0.7;
      const dy = sp > 20 ? -v.vy / sp : 0.7;
      for (let i = 0; i < SEGMENTS; i++) {
        s.px[i] = ax + dx * L * i;
        s.py[i] = ay + dy * L * i + i * i * 0.05;
        s.ox[i] = s.px[i] - v.vx * SUBSTEP;
        s.oy[i] = s.py[i] - v.vy * SUBSTEP;
      }
      s.acc = 0;
      this.scarves.set(v.id, s);
    }
    // anchor moves linearly between the previous and the current neck position across substeps
    s.acc += Math.min(dt, 0.1);
    const steps = Math.floor(s.acc / SUBSTEP);
    s.acc -= steps * SUBSTEP;
    const pax = s.ax;
    const pay = s.ay;
    const sp = Math.hypot(v.vx, v.vy);
    const speedK = clamp(sp / 900, 0, 1.4);
    const drag = Math.exp(-5.5 * SUBSTEP);
    const boost = v.boostLevel || 0;
    // unit perpendicular to the flow (for the ripple)
    const fx = sp > 1 ? -v.vx / sp : -1;
    const fy = sp > 1 ? -v.vy / sp : 0;
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const sx = pax + (ax - pax) * u;
      const sy = pay + (ay - pay) * u;
      const tt = t - (steps - k) * SUBSTEP;
      s.px[0] = sx;
      s.py[0] = sy;
      s.ox[0] = sx;
      s.oy[0] = sy;
      for (let i = 1; i < SEGMENTS; i++) {
        const vx = (s.px[i] - s.ox[i]) * drag;
        const vy = (s.py[i] - s.oy[i]) * drag;
        s.ox[i] = s.px[i];
        s.oy[i] = s.py[i];
        const tip = i / SEGMENTS;
        const rip = Math.sin(tt * (15 + boost * 3) - i * 0.62) * (900 + 1600 * speedK) * tip * (0.35 + speedK);
        // a light breeze when slow (start line): the scarf lifts and drifts back instead of hanging dead
        const calm = Math.max(0, 1 - speedK * 2);
        const breeze = calm * (420 + 180 * Math.sin(tt * 1.7 + i * 0.4)) * (0.4 + tip);
        const ax2 = -fy * rip - breeze;
        const ay2 = fx * rip + 520 * (1 - 0.5 * speedK) * (1 - 0.85 * calm) - calm * 160 * Math.sin(tt * 2.3 - i * 0.5);
        s.px[i] += vx + ax2 * SUBSTEP * SUBSTEP;
        s.py[i] += vy + ay2 * SUBSTEP * SUBSTEP;
      }
      // the scarf never sinks into the snow
      if (this.groundAt) {
        for (let i = 1; i < SEGMENTS; i++) {
          const gy = this.groundAt(s.px[i]) - 1.5;
          if (s.py[i] > gy) {
            s.py[i] = gy;
            s.oy[i] = gy;
          }
        }
      }
      for (let it = 0; it < 3; it++) {
        for (let i = 1; i < SEGMENTS; i++) {
          const dx = s.px[i] - s.px[i - 1];
          const dy = s.py[i] - s.py[i - 1];
          const d = Math.hypot(dx, dy) || 0.0001;
          const diff = (d - L) / d;
          if (i === 1) {
            s.px[i] -= dx * diff;
            s.py[i] -= dy * diff;
          } else {
            s.px[i] -= dx * diff * 0.5;
            s.py[i] -= dy * diff * 0.5;
            s.px[i - 1] += dx * diff * 0.5;
            s.py[i - 1] += dy * diff * 0.5;
          }
        }
      }
    }
    if (steps === 0) {
      // frozen frame: keep the chain glued to the anchor without simulating
      const dx = ax - s.px[0];
      const dy = ay - s.py[0];
      if (dx || dy) for (let i = 0; i < SEGMENTS; i++) {
        s.px[i] += dx;
        s.py[i] += dy;
        s.ox[i] += dx;
        s.oy[i] += dy;
      }
    }
    s.ax = ax;
    s.ay = ay;
    return s;
  }

  drawScarf(ctx, s, col, alpha, boost, v) {
    const n = SEGMENTS;
    const W0 = 5;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (boost) {
      // glow without shadowBlur: the same ribbon, wider and translucent, underneath
      ctx.globalAlpha = alpha * 0.28;
      ctx.strokeStyle = rgba(mix(col, [255, 255, 255], 0.3));
      ctx.lineWidth = 6 + boost * 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(s.px[0], s.py[0]);
      for (let i = 1; i < SEGMENTS; i++) ctx.lineTo(s.px[i], s.py[i]);
      ctx.stroke();
      ctx.globalAlpha = alpha;
    }
    ctx.fillStyle = rgba(col);
    ctx.beginPath();
    // left edge forward, right edge back (polygon ribbon)
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < n; k++) {
        const i = pass === 0 ? k : n - 1 - k;
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        let tx = s.px[b] - s.px[a];
        let ty = s.py[b] - s.py[a];
        const d = Math.hypot(tx, ty) || 1;
        tx /= d;
        ty /= d;
        const taper = 1 - 0.6 * (i / (n - 1));
        // travelling wave on top of the physics (purely visual, grows towards the tip)
        const wave = Math.sin(this.t * (13 + boost * 3) - i * 0.85 + this.phase) * (1.3 + 2.2 * this.flow) * (i / (n - 1));
        // the ribbon twists: width modulated along its length
        const w = W0 * taper * (0.75 + 0.25 * Math.cos(i * 0.7 + (v.x + v.y) * 0.004)) * (pass === 0 ? 0.5 : -0.5);
        const x = s.px[i] - ty * (w + wave);
        const y = s.py[i] + tx * (w + wave);
        if (pass === 0 && k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.fill();
    // forked tail end
    const e = n - 1;
    ctx.beginPath();
    ctx.arc(s.px[e], s.py[e], 1.3, 0, TAU);
    ctx.fill();
    ctx.restore();
    // knot at the neck
    ctx.fillStyle = rgba(col, alpha);
    ctx.beginPath();
    ctx.arc(s.px[0], s.py[0] + 0.5, 3.2, 0, TAU);
    ctx.fill();
  }

  drawShield(ctx, v, P, ghost) {
    const t = P.t;
    const dir = Math.atan2(v.vy, v.vx);
    const cx = v.x + Math.sin(v.angle) * 16;
    const cy = v.y - Math.cos(v.angle) * 16;
    const R = 27 + Math.sin(t * 6) * 0.8;
    if (ghost) {
      // other riders: one faint arc, no fill
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, R, dir - 0.7, dir + 0.7);
      ctx.stroke();
      return;
    }
    // local rider: a soft warm crescent of light + one crisp arc with a travelling glint
    const g = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.12);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.85, `rgba(${P.accent[0] | 0},${P.accent[1] | 0},${P.accent[2] | 0},0.22)`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.12, dir - 1.1, dir + 1.1);
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.fill();
    ctx.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      // tapered: three overlapping arcs, the central part brightest
      const span = 0.95 - k * 0.3;
      ctx.strokeStyle = `rgba(255,255,255,${0.22 + k * 0.18})`;
      ctx.lineWidth = 1.1 + k * 0.35;
      ctx.beginPath();
      ctx.arc(cx, cy, R, dir - span, dir + span);
      ctx.stroke();
    }
    const ga = dir - 0.8 + ((t * 1.6) % 1) * 1.6;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ga) * R, cy + Math.sin(ga) * R, 1.6, 0, TAU);
    ctx.fill();
  }

  drawHover(ctx, v, P) {
    const t = P.t;
    const cx = v.x + Math.sin(v.angle) * 20;
    const cy = v.y - Math.cos(v.angle) * 20;
    // soft teal shimmer around the body
    const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 42);
    g.addColorStop(0, 'rgba(190,255,240,0.32)');
    g.addColorStop(0.6, 'rgba(160,240,225,0.12)');
    g.addColorStop(1, 'rgba(160,240,225,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, 42, 0, TAU);
    ctx.fill();
    // three little feathers orbiting slowly
    ctx.fillStyle = 'rgba(240,255,252,0.9)';
    for (let i = 0; i < 3; i++) {
      const a = t * 2.2 + (i * TAU) / 3;
      const fx = cx + Math.cos(a) * 26;
      const fy = cy + Math.sin(a) * 12;
      ctx.save();
      ctx.translate(fx, fy);
      ctx.rotate(a + Math.PI / 2 + Math.sin(t * 5 + i) * 0.3);
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.quadraticCurveTo(3.5, -1, 0, 6);
      ctx.quadraticCurveTo(-3.5, -1, 0, -6);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Pit rescue: a little hot-air balloon in the rider's colour comes down on a rope;
   * the rider hangs from it (hands on the rope, board dangling), swaying gently.
   */
  drawBalloon(ctx, v, vs, X, Y, J, ca, sa, P) {
    const t = P.t;
    // hands (mid point of both) in world space
    const hx = X + (((J.a1.x + J.a2.x) / 2) * ca - ((J.a1.y + J.a2.y) / 2) * sa) * K;
    const hy = Y + (((J.a1.x + J.a2.x) / 2) * sa + ((J.a1.y + J.a2.y) / 2) * ca) * K;
    const e = Math.min(1, vs.rescueAge / 0.7);
    const ease = 1 - (1 - e) * (1 - e) * (1 - e);
    const rope = 34 + 110 * (1 - ease); // comes down a little, then holds a short rope
    const sway = Math.sin(t * 1.7) * 6;
    const bx = hx - sway;
    const by = hy - rope;
    drawBalloonAt(ctx, bx, by, v.color, P, 1, t, !v.isLocal);
    // rope from the basket to the hands
    ctx.strokeStyle = rgba(P.sil, 0.85);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo((bx + hx) / 2 + sway * 0.4, (by + hy) / 2, hx, hy);
    ctx.stroke();
  }

  /** Balloons that let go after a rescue: rise and drift away, fading. Call once per frame. */
  drawDeparting(ctx, P, dt) {
    for (let i = this.departing.length - 1; i >= 0; i--) {
      const b = this.departing[i];
      b.age += dt;
      if (b.age > 3) {
        this.departing.splice(i, 1);
        continue;
      }
      const u = b.age / 3;
      const x = b.x + b.age * 26 + Math.sin(b.age * 1.4) * 6;
      const y = b.y - b.age * (40 + b.age * 22);
      drawBalloonAt(ctx, x, y, b.color, P, (1 - u) * (1 - u), P.t, b.ghost, 1 - 0.25 * u);
    }
  }

  /** Ghost body colour with a guaranteed luminance gap to the brightest backdrop (snow / haze). */
  ghostBody(P) {
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const bright = Math.max(lum(P.snow), lum(P.haze));
    let k = 0.3;
    let c = mix(P.sil, P.haze, k);
    while (k > 0 && bright - lum(c) < 110) {
      k -= 0.05;
      c = mix(P.sil, P.haze, Math.max(0, k));
    }
    return c;
  }

  /** Edge marker for an off-screen rider (screen space). side: 1 = right/ahead, -1 = left/behind. */
  drawMarker(ctx, v, side, x, y, alpha, gapS, P) {
    if (alpha <= 0.02) return;
    const name = (v.name || '').toUpperCase().slice(0, 10);
    const label = gapS == null ? name : `${name}  ${gapS >= 0 ? '+' : '−'}${Math.abs(gapS).toFixed(1)}s`;
    ctx.save();
    ctx.globalAlpha = alpha;
    // (font / letter spacing are set once per frame by the renderer before this pass)
    const tw = ctx.measureText(label).width;
    const pw = tw + 20;
    // chevron pointing off screen (with a soft dark backing so it reads on bright snow)
    ctx.fillStyle = rgba(P.sil, 0.35);
    ctx.beginPath();
    ctx.moveTo(x + side * 1.5, y);
    ctx.lineTo(x - side * 13.5, y - 10.5);
    ctx.lineTo(x - side * 13.5, y + 10.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = v.color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - side * 12, y - 9);
    ctx.lineTo(x - side * 12, y + 9);
    ctx.closePath();
    ctx.fill();
    // pill with the name (and gap)
    const px = side > 0 ? x - 17 - pw : x + 17;
    ctx.fillStyle = rgba(P.sil, 0.55);
    ctx.beginPath();
    ctx.roundRect(px, y - 10, pw, 20, 10);
    ctx.fill();
    ctx.fillStyle = v.color;
    ctx.beginPath();
    ctx.arc(px + 8, y, 3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(label, px + 14, y + 0.5);
    ctx.restore();
  }

  /** Name tag above a ghost, in screen space. */
  drawTag(ctx, v, sx, sy, alpha, P) {
    if (alpha <= 0.02) return;
    const name = (v.name || '').toUpperCase().slice(0, 14);
    ctx.save();
    ctx.globalAlpha = alpha;
    // (font / letter spacing are set once per frame by the renderer before this pass)
    const w = ctx.measureText(name).width + 18;
    const x = Math.round(sx - w / 2);
    const y = Math.round(sy);
    ctx.fillStyle = rgba(P.sil, 0.42);
    ctx.beginPath();
    ctx.roundRect(x, y - 8, w, 16, 8);
    ctx.fill();
    ctx.fillStyle = v.color;
    ctx.beginPath();
    ctx.arc(x + 7, y, 2.6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, x + 13, y + 0.5);
    // little pointer
    ctx.fillStyle = rgba(P.sil, 0.42);
    ctx.beginPath();
    ctx.moveTo(sx - 3, y + 8);
    ctx.lineTo(sx + 3, y + 8);
    ctx.lineTo(sx, y + 11);
    ctx.fill();
    ctx.restore();
  }
}

/** centre of mass above the board, in skeleton units (≈ hip height) */
const COM_H = 18;

function smooth(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

const JOINTS = ['f1', 'f2', 'k1', 'k2', 'h', 'n', 'hd', 'e1', 'e2', 'a1', 'a2'];
/* contact probes (board-local, unscaled): [x, y, extra radius] triples; 999 = joint index */
const CONTACT_BOARD = [-17, 0, 0, 17, 0, 0, -12, 0, 0, 12, 0, 0];
const CONTACT_JOINTS = ['hd', 'h', 'k1', 'k2', 'a1', 'a2', 'n'];
const CONTACT_CRASH = [-17, 0, 0, 17, 0, 0, 999, 0, 4.5, 999, 1, 3, 999, 2, 2, 999, 3, 2, 999, 4, 1.5, 999, 5, 1.5, 999, 6, 3];

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Hot-air balloon with its basket hanging at (bx, by). */
function drawBalloonAt(ctx, bx, by, color, P, alpha, t, ghost, k = 1) {
  if (alpha <= 0.01) return;
  const col = mix(mix(hex(color), P.sil, 0.12 + 0.25 * P.night), P.haze, ghost ? 0.25 : 0);
  const light = mix(col, [255, 255, 255], 0.38);
  const R = 26 * k;
  const cy = by - 14 * k - R * 1.15; // envelope centre
  ctx.save();
  ctx.globalAlpha = alpha;
  // envelope: round top tapering to the mouth
  ctx.beginPath();
  ctx.moveTo(bx - R * 0.32, cy + R * 1.0);
  ctx.bezierCurveTo(bx - R * 1.25, cy + R * 0.35, bx - R * 1.15, cy - R * 1.05, bx, cy - R * 1.05);
  ctx.bezierCurveTo(bx + R * 1.15, cy - R * 1.05, bx + R * 1.25, cy + R * 0.35, bx + R * 0.32, cy + R * 1.0);
  ctx.closePath();
  ctx.fillStyle = rgba(col);
  ctx.fill();
  // lighter gores (vertical stripes) + a soft lit side
  ctx.save();
  ctx.clip();
  ctx.fillStyle = rgba(light);
  for (const off of [-0.55, 0.05]) {
    ctx.beginPath();
    ctx.ellipse(bx + off * R, cy, R * 0.18, R * 1.3, 0, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = rgba(P.shadeDeep || P.sil, 0.25);
  ctx.beginPath();
  ctx.ellipse(bx + R * 0.95, cy + R * 0.1, R * 0.55, R * 1.4, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
  // mouth band + suspension lines + basket
  ctx.fillStyle = rgba(P.sil);
  ctx.fillRect(bx - R * 0.34, cy + R * 0.98, R * 0.68, 2.2 * k);
  ctx.strokeStyle = rgba(P.sil, 0.8);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(bx - R * 0.32, cy + R * 1.05);
  ctx.lineTo(bx - 5 * k, by - 7 * k);
  ctx.moveTo(bx + R * 0.32, cy + R * 1.05);
  ctx.lineTo(bx + 5 * k, by - 7 * k);
  ctx.stroke();
  ctx.fillStyle = rgba(mix([120, 80, 50], P.sil, 0.35 + 0.35 * P.night));
  ctx.fillRect(bx - 6 * k, by - 7 * k, 12 * k, 8 * k);
  // burner flame flickering in the mouth
  const fl = 0.7 + 0.3 * Math.sin(t * 17) * Math.sin(t * 7.3 + 1);
  ctx.fillStyle = `rgba(255,190,90,${0.9 * fl})`;
  ctx.beginPath();
  ctx.moveTo(bx - 2.5 * k, cy + R * 1.0);
  ctx.quadraticCurveTo(bx, cy + R * (0.55 - 0.25 * fl), bx + 2.5 * k, cy + R * 1.0);
  ctx.fill();
  if (P.glow) P.glow(bx, cy + R * 0.85, 34 * k, (0.25 + 0.6 * P.night) * fl * alpha);
  ctx.restore();
}

function set(p, x, y) {
  p.x = x;
  p.y = y;
}
