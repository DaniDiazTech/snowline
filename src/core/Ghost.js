/**
 * Ghost — smooth playback of a remote rider from its 12 Hz NetState stream.
 *
 * Samples are placed on the sender's own tick timeline and replayed a little in
 * the past (cubic Hermite between samples, short extrapolation when one is late),
 * so network jitter never shows up as stutter.
 */
import { RiderMode, TICK_MS } from '../contracts.js';
import { decodeNetState } from '../sim/netState.js';
import { clamp, lerp } from '../math/utils.js';

const DELAY_MS = 110; // how far behind the newest sample we render
const MAX_EXTRAPOLATE_MS = 280;
const BUFFER = 24;

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function hermite(p0, v0, p1, v1, t, dt) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * dt * v0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * dt * v1;
}

export class Ghost {
  constructor() {
    this.samples = [];
    /** local ms − sender race ms; tracks the fastest delivery seen */
    this.offset = null;
    this.last = null;
  }

  /** @param {import('../contracts.js').NetState} net  @param {number} recvMs */
  push(net, recvMs) {
    const s = decodeNetState(net);
    if (![s.tick, s.x, s.y, s.angle, s.vx, s.vy].every(Number.isFinite)) return;
    s.t = s.tick * TICK_MS;
    const newest = this.samples[this.samples.length - 1];
    if (newest && s.tick < newest.tick) {
      if (s.tick > 0) return; // late, out-of-order packet
      this.samples.length = 0; // a new race started
    }
    if (s.tick === 0) {
      this.offset = null; // still on the start line: nothing to time yet
      this.samples.length = 0;
    } else {
      const off = recvMs - s.t;
      this.offset = this.offset === null ? off : Math.min(off, this.offset + 0.4);
    }
    this.samples.push(s);
    if (this.samples.length > BUFFER) this.samples.shift();
    this.last = s;
  }

  /** Progress source for the HUD (newest known x). */
  get x() {
    return this.last ? this.last.x : 0;
  }

  /**
   * @param {number} nowMs  @param {import('../contracts.js').Course} course
   * @returns {Object|null} RiderView partial
   */
  sample(nowMs, course) {
    const n = this.samples.length;
    if (!n) return null;
    const newest = this.samples[n - 1];
    if (this.offset === null || n === 1) return this.pose(newest, newest, 0, 0, course);
    const t = nowMs - this.offset - DELAY_MS;
    if (t >= newest.t) return this.pose(newest, newest, 0, clamp(t - newest.t, 0, MAX_EXTRAPOLATE_MS) / 1000, course);
    let i = n - 2;
    while (i > 0 && this.samples[i].t > t) i--;
    const a = this.samples[i];
    const b = this.samples[i + 1];
    if (t <= a.t) return this.pose(a, a, 0, 0, course);
    return this.pose(a, b, (t - a.t) / (b.t - a.t), 0, course);
  }

  pose(a, b, u, extraS, course) {
    const dt = (b.t - a.t) / 1000;
    // Respawns and long gaps are jumps, not motion: snap instead of sweeping across the screen.
    const jump = dt > 0.5 || Math.abs(b.x - a.x) > 900;
    const k = jump ? (u < 0.5 ? 0 : 1) : u;
    let x;
    let y;
    if (a === b || jump) {
      const s = k < 0.5 ? a : b;
      x = s.x + s.vx * extraS;
      y = s.y + s.vy * extraS;
    } else {
      x = hermite(a.x, a.vx, b.x, b.vx, k, dt);
      y = hermite(a.y, a.vy, b.y, b.vy, k, dt);
    }
    const near = k < 0.5 ? a : b;
    // Riders on the snow stay glued to it, whatever the interpolation did.
    if (near.mode === RiderMode.GROUND || near.mode === RiderMode.IDLE || near.mode === RiderMode.FINISHED) {
      const ground = course.heightAt(x);
      if (a.mode === b.mode || extraS > 0) y = ground;
      else y = Math.min(y, ground);
    } else {
      y = Math.min(y, course.heightAt(x));
    }
    return {
      x,
      y,
      vx: lerp(a.vx, b.vx, k),
      vy: lerp(a.vy, b.vy, k),
      angle: lerpAngle(a.angle, b.angle, k),
      mode: near.mode,
      crouch: lerp(a.crouch, b.crouch, k),
      scarf: lerp(a.scarf, b.scarf, k),
      boostLevel: near.boostLevel,
      shield: near.shield,
      hover: near.hover,
    };
  }
}
