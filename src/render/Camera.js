/**
 * Follow camera (resolution independent).
 *
 * World → screen:  sx = (x - this.x) * this.scale + anchorX
 *                  sy = (y - this.y) * this.scale + anchorY
 *
 * Size: the scale is chosen so the rider (RIDER_HEIGHT px, board to head) is a
 * fixed fraction of the viewport's SHORT side — ≈ 6.5 % at cruising speed,
 * easing to ≈ 4.5 % at top boosted speed or in big air — and never below
 * MIN_RIDER_PX css px. Lead time wins over size: the scale is capped so the
 * ground ahead of the rider is visible for ≥ LEAD_S seconds at the current
 * speed (this only bites in portrait).
 *
 * Framing: x = rider + look-ahead along the velocity. y follows a spatial
 * average of the SURFACE over a window around/ahead of the rider (so rollers
 * do not make the camera bob and the ground ahead is framed), raised by part
 * of the air height in jumps, and clamped so the rider stays in a safe band
 * (clear of the HUD at the top and bottom). Everything eases (damp), so a
 * crash or respawn never snaps.
 *
 * Modes: race · cinematic (home/lobby: rider ~60 % across, slow drift) ·
 * finish (FINISHED: rider centred ~50 % / 45 % for the results screen).
 */
import { clamp, damp, lerp, smoothstep } from '../math/utils.js';
import { RIDER_HEIGHT } from '../math/physics.js';
import { surfaceY } from './TerrainRenderer.js';

export const RIDER_FRAC_CRUISE = 0.065;
export const RIDER_FRAC_FAST = 0.045;
export const MIN_RIDER_PX = 26;
export const LEAD_S = 1.1;
const CRUISE_SPEED = 500;
/** height of the rescue balloon + rope above the rider's board, world px */
const BALLOON_H = 150; // px/s (≈ 21 m/s)
const TOP_SPEED = 1000; // px/s (≈ 42 m/s, the soft terminal)

export class Camera {
  constructor() {
    this.width = 1;
    this.height = 1;
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.scale = 1;
    this.baseScale = 1;
    this.targetScale = 1;
    this.anchorX = 0;
    this.anchorBase = 0;
    this.prevRiderX = 0;
    this.prevTy = 0;
    this.anchorY = 0;
    this.shakeAmp = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.initialized = false;
    this.portrait = false;
    /** debug multiplier for close-up screenshots (harness ?camzoom=) */
    this.debugZoom = 1;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.portrait = height > width * 1.05;
    // reference ("zoom 1") scale: the rider at cruising size; parallax layers key off it
    this.baseScale = this.sizeScale(RIDER_FRAC_CRUISE);
  }

  /** Scale at which the rider is `frac` of the short side (floored at MIN_RIDER_PX). */
  sizeScale(frac) {
    const short = Math.min(this.width, this.height);
    return Math.max(frac * short, MIN_RIDER_PX) / RIDER_HEIGHT;
  }

  /** Short zoom-out pulse (boost hit): rises instantly, eases out over ~0.25 s, adds a little lead. */
  kick(amount) {
    if (this.reduced) return;
    this.kickTarget = Math.max(this.kickTarget || 0, amount);
  }

  /** Landing settle: the frame dips down by `px` (≤ 6) and recovers, critically damped. */
  dip(px) {
    if (this.reduced) return;
    this.dipTarget = Math.max(this.dipTarget || 0, Math.min(6, px));
  }

  addShake(amount) {
    if (this.reduced) return;
    this.shakeAmp = Math.min(14, Math.max(this.shakeAmp, amount));
  }

  /** Anchor fractions (where the camera target sits on screen) per mode. */
  anchors(mode) {
    if (mode === 'cinematic') return this.portrait ? [0.5, 0.5] : [0.6, 0.55];
    if (mode === 'finish') return [0.5, 0.45];
    if (mode === 'rescue') return [0.5, 0.5];
    return this.portrait ? [0.3, 0.52] : [0.32, 0.56];
  }

  /**
   * Seconds of ground visible ahead of the rider for a given scale/speed
   * (assuming the look-ahead has settled). Exposed for tests/reporting.
   */
  leadTime(scale, speed) {
    const [ax] = this.anchors('race');
    return (this.width * (1 - ax)) / scale / Math.max(1, speed);
  }


  /**
   * @param {import('../contracts.js').RiderView} rider
   * @param {import('../contracts.js').Course} course
   * @param {number} dt seconds
   * @param {number} timeMs
   * @param {boolean} cinematic
   */
  update(rider, course, dt, timeMs, cinematic) {
    const rescue = rider.mode === 'rescue' && this.rescueSpan;
    const mode = cinematic ? 'cinematic' : rider.mode === 'finished' ? 'finish' : rescue ? 'rescue' : 'race';
    const [ax, ay] = this.anchors(mode);
    const first = !this.initialized;
    const W = this.width;
    const H = this.height;

    const speed = Math.hypot(rider.vx, rider.vy);
    const gAt = (x) => (course ? surfaceY(course, clamp(x, course.minX, course.maxX)) : rider.y);
    const ground = gAt(rider.x);
    const air = clamp(ground - rider.y, 0, 3000);
    // eased scale from the previous frame: framing maths uses it, never the raw target
    const curScale = first ? this.sizeScale(RIDER_FRAC_CRUISE) : this.targetScale;

    let scaleT;
    let tx;
    let ty;
    let wY = 5; // spring stiffness (rad/s) for y
    let wS = 2.6; // ... for scale
    if (mode === 'cinematic') {
      const t = timeMs / 1000;
      scaleT = this.sizeScale(0.05) * (1 + 0.03 * Math.sin(t * 0.07));
      tx = rider.x + Math.sin(t * 0.05) * 40;
      ty = this.groundWindow(gAt, tx, 300) - 30 + Math.sin(t * 0.083) * 15;
      wY = 1.6;
      wS = 1;
    } else if (mode === 'finish') {
      scaleT = this.sizeScale(0.06);
      tx = rider.x;
      ty = rider.y - 10;
      wY = 2;
      wS = 1.2;
    } else if (mode === 'rescue') {
      // frame both lips of the pit while the balloon carries the rider across
      // keep both lips AND the whole balloon (≈ 150 world px above the rider) inside the safe
      // band: below 24 % and above 75 % of the height (HUD toast at the top)
      const r = this.rescueSpan;
      const span = Math.abs(r.x1 - r.x0) + 320;
      const top = Math.min(rider.y - BALLOON_H, r.y0 - 40, r.y1 - 40);
      const bot = Math.max(rider.y + 10, r.y0 + 30, r.y1 + 30);
      scaleT = Math.min(this.sizeScale(RIDER_FRAC_CRUISE), (W * 0.75) / span, (H * 0.48) / Math.max(1, bot - top));
      tx = rider.x + ((r.x0 + r.x1) / 2 - rider.x) * 0.6;
      // centre of the band (0.495 H) on the middle of [top, bot]; anchorY is 0.5 H
      ty = (top + bot) / 2 + (0.5 - 0.495) * H / scaleT;
      wY = 5;
      wS = 2.5;
    } else {
      const fast = smoothstep(CRUISE_SPEED, TOP_SPEED, speed);
      const big = smoothstep(80, 600, air);
      const frac = lerp(RIDER_FRAC_CRUISE, RIDER_FRAC_FAST, Math.max(fast, big));
      scaleT = this.sizeScale(frac);
      if (big > 0.05) wS = 1.7; // weighty: big airs zoom out slowly
      // lead time first: cap the scale so ≥ LEAD_S s of ground ahead is on screen (the rider sits at ax)
      scaleT = Math.min(scaleT, (W * (1 - ax)) / (LEAD_S * Math.max(speed, 1)));
      tx = rider.x;
      // vertical: frame the averaged ground around/ahead of the rider, lifted with air height
      const ahead = (W * (1 - ax)) / curScale;
      const gw = this.groundWindow(gAt, rider.x + ahead * 0.25, Math.max(250, ahead * 0.6));
      ty = lerp(gw, ground, 0.35) - air * 0.55 - 6;
      // keep the rider inside a safe vertical band (HUD top / bottom)
      const top = H * 0.26;
      const bottom = H * 0.74;
      const cs = curScale * this.debugZoom; // (debug close-ups magnify the frame too)
      const ry = (rider.y - ty) * cs + H * ay;
      if (ry < top) ty -= (top - ry) / cs;
      if (ry > bottom) ty += (ry - bottom) / cs;
    }

    if (first) {
      this.x = tx;
      this.y = ty;
      this.targetScale = scaleT;
      this.vy = this.vs = this.va = this.vay = this.kv = 0;
      this.anchorBase = W * ax;
      this.anchorY = H * ay;
      this.initialized = true;
    } else {
      // x: carried with the rider's own displacement (no lag at speed), residual eased;
      // a teleport (respawn) is not carried, so it eases instead of snapping
      // a different subject (spectating after the finish): glide across over ~0.6 s
      if (rider.id !== this.prevId) this.switchT = this.prevId === undefined ? 0 : 0.6;
      this.switchT = Math.max(0, (this.switchT || 0) - dt);
      const moved = rider.x - this.prevRiderX;
      if (Math.abs(moved) < 200 && this.switchT <= 0) this.x += moved;
      const gapX = Math.abs(tx - this.x);
      this.x = damp(this.x, tx, this.switchT > 0 ? 6 : mode === 'race' ? (gapX > 600 ? 4 : 12) : 1.5, dt);
      // y: rides along with the (spatially smooth) framing target, residual on a critically damped spring
      if (mode === 'race' && this.prevMode === 'race' && Math.abs(ty - this.prevTy) < 200) this.y += ty - this.prevTy;
      [this.y, this.vy] = spring(this.y, this.vy, ty, wY, dt);
      [this.targetScale, this.vs] = spring(this.targetScale, this.vs, scaleT, wS, dt);
      [this.anchorBase, this.va] = spring(this.anchorBase, this.va, W * ax, 3.5, dt);
      [this.anchorY, this.vay] = spring(this.anchorY, this.vay, H * ay, 3.5, dt);
    }
    // boost pulse: a spring chasing a decaying target — eases in and out, never a step
    this.kickTarget = (this.kickTarget || 0) * Math.exp(-dt / 0.25);
    [this.kickAmt, this.kv] = spring(this.kickAmt || 0, this.kv || 0, this.kickTarget, 16, dt);
    if (Math.abs(this.kickAmt) < 0.0003 && this.kickTarget < 0.0003) this.kickAmt = this.kickTarget = this.kv = 0;
    if (mode === 'rescue') {
      // hard keep-in-band: the whole balloon + rider stays between 24 % and 75 % of the height
      const sc = this.targetScale;
      const topS = (rider.y - BALLOON_H - this.y) * sc + this.anchorY;
      const botS = (rider.y + 10 - this.y) * sc + this.anchorY;
      if (topS < H * 0.24) this.y -= (H * 0.24 - topS) / sc;
      else if (botS > H * 0.75) this.y += (botS - H * 0.75) / sc;
    }
    this.dipTarget = (this.dipTarget || 0) * Math.exp(-dt / 0.1);
    [this.dipAmt, this.dv] = spring(this.dipAmt || 0, this.dv || 0, this.dipTarget, 15, dt);
    this.prevRiderX = rider.x;
    this.prevId = rider.id;
    this.prevTy = ty;
    this.prevMode = mode;
    this.zoom = this.targetScale / this.baseScale;
    const kick = this.kickAmt;
    this.scale = this.targetScale * (1 - kick) * this.debugZoom;
    // the pulse also leans the frame forward a touch (rider drifts left)
    this.anchorX = this.anchorBase - kick * W * 0.6;
    // the landing dip moves the world down a few px (anchor), then settles back
    this.anchorYDrawn = this.anchorY + (this.dipAmt || 0);

    // Shake: small deterministic wobble decaying quickly.
    this.shakeAmp = damp(this.shakeAmp, 0, 7, dt);
    const s = timeMs / 1000;
    this.shakeX = this.shakeAmp * (Math.sin(s * 71.3) * 0.6 + Math.sin(s * 113.7) * 0.4);
    this.shakeY = this.shakeAmp * (Math.sin(s * 89.1 + 1.3) * 0.6 + Math.sin(s * 57.9) * 0.4);
    if (this.shakeAmp < 0.05) this.shakeX = this.shakeY = 0;
  }

  /** Mean surface height over [cx - half, cx + half] (7 samples): a spatial low-pass. */
  groundWindow(gAt, cx, half) {
    let sum = 0;
    for (let i = -3; i <= 3; i++) sum += gAt(cx + (i / 3) * half);
    return sum / 7;
  }

  sx(x) {
    return (x - this.x) * this.scale + this.anchorX + this.shakeX;
  }

  sy(y) {
    return (y - this.y) * this.scale + (this.anchorYDrawn ?? this.anchorY) + this.shakeY;
  }

  worldToScreen(x, y) {
    return { x: this.sx(x), y: this.sy(y) };
  }

  /** World x at a screen x. */
  worldX(sx) {
    return (sx - this.anchorX - this.shakeX) / this.scale + this.x;
  }

  worldY(sy) {
    return (sy - (this.anchorYDrawn ?? this.anchorY) - this.shakeY) / this.scale + this.y;
  }

  /** Applies the world transform to a 2D context (on top of the pixel-density base transform). */
  apply(ctx, dpr) {
    const s = this.scale * dpr;
    ctx.setTransform(s, 0, 0, s, (this.anchorX + this.shakeX - this.x * this.scale) * dpr, ((this.anchorYDrawn ?? this.anchorY) + this.shakeY - this.y * this.scale) * dpr);
  }
}

/**
 * One step of a critically damped spring (implicit Euler, unconditionally stable).
 * Position and velocity are continuous, so a jumping target never produces a visible step.
 * @returns {[number, number]} [position, velocity]
 */
function spring(x, v, target, omega, dt) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  return [(f * x + dt * v + hhoo * target) * det, (v + hoo * (target - x)) * det];
}
