/**
 * Tiny stand-in rider for the render harness when src/sim is not available:
 * follows the surface, leaves it at lips/chasms, auto-jumps and backflips now
 * and then, grinds bunting/roof/ice it lands on. Deterministic, 60 Hz.
 * It mimics RiderState fields the renderer needs and emits a few SimEvents.
 */
import { TICK_DT, RiderMode, SimEvent, FeatureType } from '../src/contracts.js';
import { createRandom } from '../src/math/random.js';

const G = 1500;

export class MockRider {
  constructor(course, seed = 1, skill = 0.7) {
    this.course = course;
    this.rng = createRandom(seed);
    this.skill = skill;
    const x = course.startX - 20;
    this.state = {
      tick: 0, x, y: course.heightAt(x), vx: 0, vy: 0, angle: 0, angVel: 0, mode: RiderMode.IDLE,
      speed: 0, crouch: 0, scarf: 0.35, boostT: 0, boostLevel: 0, shield: false, hoverT: 0, magnetT: 0,
      airTime: 0, flips: 0, combo: { points: 0, mult: 1, tricks: [] }, progress: 0, finishTick: -1, stats: {},
    };
    this.consumed = new Set();
    this.nextJump = 90 + this.rng.int(0, 120);
    this.crashT = 0;
    this.grind = null;
  }

  start() {
    this.state.mode = RiderMode.GROUND;
  }

  step() {
    const s = this.state;
    const c = this.course;
    const ev = [];
    s.tick++;
    if (s.mode === RiderMode.IDLE) return ev;
    const dt = TICK_DT;
    if (s.boostT > 0) {
      s.boostT -= dt;
      if (s.boostT <= 0) {
        s.boostT = 0;
        s.boostLevel = 0;
        s.shield = false;
      } else if (s.boostT < 1.5) s.shield = false;
    }
    if (s.hoverT > 0) s.hoverT = Math.max(0, s.hoverT - dt);
    const maxV = 950 + (s.boostLevel ? 350 : 0);

    if (s.mode === RiderMode.CRASHED) {
      this.crashT -= dt;
      s.vx *= 0.98;
      s.x += s.vx * dt;
      s.y = c.heightAt(s.x) - 4;
      s.angle += 9 * dt;
      if (this.crashT <= 0) {
        s.mode = RiderMode.GROUND;
        s.angle = Math.atan(c.slopeAt(s.x));
        s.vx = 300;
        ev.push({ type: SimEvent.RESPAWN, data: { x: s.x, y: s.y } });
      }
    } else if (s.mode === RiderMode.GROUND) {
      const slope = c.slopeAt(s.x);
      const ang = Math.atan(slope);
      let v = Math.hypot(s.vx, s.vy);
      v += (G * Math.sin(ang) * 0.75 - v * 0.12) * dt;
      v = Math.min(maxV, Math.max(120, v));
      const nx = s.x + Math.cos(ang) * v * dt;
      const ny = c.heightAt(nx);
      s.vx = Math.cos(ang) * v;
      s.vy = Math.sin(ang) * v;
      s.angle += (ang - s.angle) * 0.35;
      s.crouch *= 0.9;
      // leave the ground if the surface drops away (lip / chasm)
      if (ny - (s.y + s.vy * dt) > 6 || c.slopeAt(nx) - slope > 0.06) {
        s.mode = RiderMode.AIR;
        s.airTime = 0;
        s.x = nx;
        s.y += s.vy * dt;
      } else {
        s.x = nx;
        s.y = ny;
      }
      if (--this.nextJump <= 0 && s.mode === RiderMode.GROUND) {
        s.mode = RiderMode.AIR;
        s.vy -= 520;
        s.airTime = 0;
        this.flip = this.rng.chance(0.55);
        this.nextJump = 150 + this.rng.int(0, 160);
        ev.push({ type: SimEvent.JUMP, data: {} });
      }
    } else if (s.mode === RiderMode.AIR) {
      s.airTime += dt;
      s.vy += G * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (this.flip && s.airTime > 0.15) {
        s.crouch = Math.min(1, s.crouch + 0.15);
        s.angle -= 7 * dt;
      } else s.crouch *= 0.9;
      // grinds
      for (const f of c.featuresIn(s.x - 2, s.x + 2)) {
        if (f.type !== FeatureType.GRIND) continue;
        const gy = c.grindY(f, s.x);
        if (s.vy > 0 && s.y >= gy - 2 && s.y <= gy + 14) {
          s.mode = RiderMode.GRIND;
          this.grind = f;
          s.y = gy;
          ev.push({ type: SimEvent.GRIND_START, data: { featureId: f.id, kind: f.kind } });
          break;
        }
      }
      const gy = c.heightAt(s.x);
      if (s.mode === RiderMode.AIR && s.y >= gy) {
        const ang = Math.atan(c.slopeAt(s.x));
        // normalise flips
        let d = s.angle - ang;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const impact = Math.min(1, Math.max(0, (s.vy - 300) / 1200));
        s.y = gy;
        if (Math.abs(d) > 0.9) {
          s.mode = RiderMode.CRASHED;
          this.crashT = 1.2;
          s.scarf = 0.1;
          ev.push({ type: SimEvent.CRASH, data: { cause: 'landing', x: s.x, y: s.y } });
        } else {
          s.mode = RiderMode.GROUND;
          s.angle = ang;
          ev.push({ type: SimEvent.LAND, data: { clean: true, impact } });
          if (this.flip) {
            s.scarf = Math.min(1, s.scarf + 0.2);
            s.boostT = 3.5;
            s.boostLevel = 1 + Math.floor(s.scarf * 2.5);
            s.shield = true;
            ev.push({ type: SimEvent.BOOST, data: { level: s.boostLevel, duration: 3.5 } });
          }
          this.flip = false;
          const v = Math.hypot(s.vx, s.vy);
          s.vx = Math.cos(ang) * v;
          s.vy = Math.sin(ang) * v;
        }
      }
    } else if (s.mode === RiderMode.GRIND) {
      const f = this.grind;
      s.x += s.vx * dt;
      const ny = c.grindY(f, s.x);
      s.vy = (ny - s.y) / dt;
      s.y = ny;
      s.angle = Math.atan2(c.grindY(f, s.x + 2) - c.grindY(f, s.x - 2), 4);
      if (s.x >= f.x1) {
        s.mode = RiderMode.AIR;
        s.vy = Math.min(s.vy, 0) - 120;
        ev.push({ type: SimEvent.GRIND_END, data: { featureId: f.id, length: f.x1 - f.x0 } });
      }
    }

    // rocks + pickups
    for (const f of c.featuresIn(s.x - 20, s.x + 20)) {
      if (this.consumed.has(f.id)) continue;
      if (f.type === FeatureType.PICKUP && Math.hypot(f.x - s.x, f.y - (s.y - 20)) < 34) {
        this.consumed.add(f.id);
        if (f.kind === 'feather') s.hoverT = 3;
        ev.push({ type: SimEvent.PICKUP, data: { featureId: f.id, kind: f.kind, x: f.x, y: f.y } });
      } else if (f.type === FeatureType.ROCK && Math.abs(f.x - s.x) < (f.size || 20) && s.y > c.heightAt(f.x) - (f.size || 20) && s.mode === RiderMode.GROUND) {
        this.consumed.add(f.id);
        if (s.shield) ev.push({ type: SimEvent.ROCK_SMASH, data: { featureId: f.id, x: f.x, y: c.heightAt(f.x) } });
        else {
          // the mock simply hops rocks it cannot smash
          s.mode = RiderMode.AIR;
          s.vy -= 480;
          ev.push({ type: SimEvent.JUMP, data: {} });
        }
      }
    }
    s.speed = Math.hypot(s.vx, s.vy);
    return ev;
  }
}
