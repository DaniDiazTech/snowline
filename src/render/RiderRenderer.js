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
    this.frame = 0;
    // scratch joint storage (no per-frame allocation)
    this.J = {};
    for (const k of ['f1', 'f2', 'k1', 'k2', 'h', 'n', 'hd', 'e1', 'e2', 'a1', 'a2']) this.J[k] = { x: 0, y: 0 };
  }

  reset() {
    this.scarves.clear();
  }

  /** Drops scarf state of riders not drawn for a while. Call once per frame after drawing. */
  sweep() {
    this.frame++;
    for (const [id, s] of this.scarves) if (this.frame - s.seen > 30) this.scarves.delete(id);
  }

  /** Computes joints (board-local) into this.J. */
  pose(v, t) {
    const J = this.J;
    const mode = v.mode;
    const crashed = mode === RiderMode.CRASHED;
    const air = mode === RiderMode.AIR;
    const grind = mode === RiderMode.GRIND;
    const idle = mode === RiderMode.IDLE;
    const finished = mode === RiderMode.FINISHED;
    let c = clamp(v.crouch || 0, 0, 1);
    if (grind) c = Math.max(c, 0.3);
    if (idle) c = 0.05;
    const bob = mode === RiderMode.GROUND ? Math.sin(t * 6.5) * 0.4 : 0;

    set(J.f1, -7.5, -3);
    set(J.f2, 7.5, -3);
    set(J.h, -1 + 2.5 * c, -21 + 8.5 * c + bob);
    const kneeOut = 2.5 + 3 * c;
    set(J.k1, (J.f1.x + J.h.x) / 2 + kneeOut * 0.6, (J.f1.y + J.h.y) / 2 + 0.5);
    set(J.k2, (J.f2.x + J.h.x) / 2 + kneeOut, (J.f2.y + J.h.y) / 2 - 0.5);
    let lean = 0.14 + 0.62 * c + (air ? 0.06 : 0);
    if (crashed) lean = 0.4 + Math.sin(t * 9) * 0.5;
    if (finished) lean = 0.02;
    const tl = 12.5 - 2 * c;
    set(J.n, J.h.x + Math.sin(lean) * tl, J.h.y - Math.cos(lean) * tl);
    set(J.hd, J.n.x + Math.sin(lean) * 5.2 + 0.6, J.n.y - Math.cos(lean) * 5.2);

    // hands/elbows relative to the neck
    let a1x;
    let a1y;
    let a2x;
    let a2y;
    if (crashed) {
      a1x = Math.cos(t * 11) * 11;
      a1y = Math.sin(t * 11) * 11;
      a2x = Math.cos(t * 13 + 2) * 11;
      a2y = Math.sin(t * 13 + 2) * 11;
    } else if (air) {
      const flap = Math.sin(t * 5) * 1.5;
      a1x = -12;
      a1y = -2 + flap;
      a2x = 12.5;
      a2y = -3.5 - flap;
      // tucked flip: hands reach for the board (grab)
      a1x = lerp(a1x, J.h.x - J.n.x - 2, c);
      a1y = lerp(a1y, J.h.y - J.n.y + 9, c);
      a2x = lerp(a2x, J.h.x - J.n.x + 6, c);
      a2y = lerp(a2y, J.h.y - J.n.y + 10, c);
    } else if (grind) {
      a1x = -13.5;
      a1y = 1 + Math.sin(t * 7) * 1.2;
      a2x = 13.5;
      a2y = -0.5 - Math.sin(t * 7) * 1.2;
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
  draw(ctx, v, P, dt) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return;
    const t = P.t;
    const J = this.pose(v, t);
    const ghost = !v.isLocal;
    const body = ghost ? rgba(mix(P.sil, P.haze, 0.38)) : rgba(P.sil);
    const ca = Math.cos(v.angle);
    const sa = Math.sin(v.angle);
    // neck in world space (scarf anchor)
    const nx = v.x + (J.n.x * ca - J.n.y * sa) * K;
    const ny = v.y + (J.n.x * sa + J.n.y * ca) * K;

    const boost = v.boostLevel || 0;
    const scarfCol = mix(mix(hex(v.color), P.sil, 0.12 + P.night * 0.2), [255, 255, 255], boost ? 0.12 + boost * 0.06 : 0);
    const s = this.scarf(v, nx, ny, dt, t);
    this.t = t;
    this.flow = clamp(Math.hypot(v.vx, v.vy) / 1000, 0, 1.3);
    this.phase = v.isLocal ? 0 : (v.id.length * 1.7) % 6.28;

    // at night a faint cool halo keeps the dark silhouette readable against dark ridges
    if (P.night > 0.3) {
      const hx = v.x + Math.sin(v.angle) * 18;
      const hy = v.y - Math.cos(v.angle) * 18;
      const R = 46;
      const g = ctx.createRadialGradient(hx, hy, 4, hx, hy, R);
      const a = (P.night - 0.3) * (ghost ? 0.18 : 0.32);
      g.addColorStop(0, rgba(P.snow, a));
      g.addColorStop(1, rgba(P.snow, 0));
      ctx.fillStyle = g;
      ctx.fillRect(hx - R, hy - R, R * 2, R * 2);
    }
    // boost aura behind the rider
    if (boost && !ghost) P.glow(v.x - v.vx * 0.02, v.y - 22, 46 + boost * 10, 0.22 + boost * 0.1, hex(v.color));

    // scarf goes behind the body
    this.drawScarf(ctx, s, scarfCol, ghost ? 0.75 : 1, boost, v);

    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.rotate(v.angle);
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

    if (v.shield) this.drawShield(ctx, v, P, ghost);
    if (v.hover) this.drawHover(ctx, v, P);
    s.seen = this.frame;
  }

  scarf(v, ax, ay, dt, t) {
    let s = this.scarves.get(v.id);
    const amt = clamp(v.scarf ?? 0, 0, 1);
    // in calm air (start line) the scarf is a shorter, lighter streamer
    const calmL = Math.max(0, 1 - clamp(Math.hypot(v.vx, v.vy) / 900, 0, 1.4) * 2);
    const L = lerp(2.0, 7.2, amt) * (1 - 0.4 * calmL);
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
      ctx.shadowColor = rgba(mix(col, [255, 255, 255], 0.3), 0.9);
      ctx.shadowBlur = 8 + boost * 5;
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

  /** Name tag above a ghost, in screen space. */
  drawTag(ctx, v, sx, sy, alpha, P) {
    if (alpha <= 0.02) return;
    const name = (v.name || '').toUpperCase().slice(0, 14);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
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

function set(p, x, y) {
  p.x = x;
  p.y = y;
}
