/**
 * Pooled particles in world space (struct-of-arrays, no per-frame allocation).
 *
 * Kinds
 *   PUFF     snow spray / powder (soft disc that grows and fades)
 *   SPARKLE  four-point star (boost, pickups)
 *   SHARD    rock fragment (spinning triangle with gravity)
 *   SPARK    grind spark (short bright streak along its velocity)
 *   RING     expanding ring (pickup pop, landing)
 *   EMBER    campfire ember (rises, flickers)
 *   FEATHER  hover shimmer (small drifting leaf)
 * Uses its own seeded RNG so a harness run is reproducible.
 */
import { createRandom } from '../math/random.js';

export const PK = Object.freeze({ PUFF: 0, SPARKLE: 1, SHARD: 2, SPARK: 3, RING: 4, EMBER: 5, FEATHER: 6, CONFETTI: 7, HAT: 8 });
const MAX = 1400;
const TAU = Math.PI * 2;

export class Particles {
  constructor() {
    this.x = new Float32Array(MAX);
    this.y = new Float32Array(MAX);
    this.vx = new Float32Array(MAX);
    this.vy = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.max = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.rot = new Float32Array(MAX);
    this.vrot = new Float32Array(MAX);
    this.grav = new Float32Array(MAX);
    this.drag = new Float32Array(MAX);
    this.kind = new Uint8Array(MAX);
    this.col = new Uint8Array(MAX); // 0 snow, 1 shade, 2 rock, 3 warm, 4 white, 5 gold, 6 player
    this.alive = 0; // number of live particles (packed at the front)
    /** fraction of the pool usable (quality governor) */
    this.budget = 1;
    this.rng = createRandom(12345);
  }

  reset() {
    this.alive = 0;
  }

  rand(a, b) {
    return a + (b - a) * this.rng.next();
  }

  spawn(kind, x, y, vx, vy, life, size, col = 0, grav = 0, drag = 1.5) {
    if (this.alive >= MAX * this.budget || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
    const i = this.alive++;
    this.kind[i] = kind;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.max[i] = life;
    this.size[i] = size;
    this.rot[i] = this.rng.next() * TAU;
    this.vrot[i] = this.rand(-8, 8);
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.col[i] = col;
  }

  /** dt in seconds. Dead particles are swapped with the last live one. */
  update(dt) {
    for (let i = 0; i < this.alive; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.copy(--this.alive, i);
        i--;
        continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d;
      this.vy[i] = this.vy[i] * d + this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.rot[i] += this.vrot[i] * dt;
    }
  }

  copy(from, to) {
    this.x[to] = this.x[from];
    this.y[to] = this.y[from];
    this.vx[to] = this.vx[from];
    this.vy[to] = this.vy[from];
    this.life[to] = this.life[from];
    this.max[to] = this.max[from];
    this.size[to] = this.size[from];
    this.rot[to] = this.rot[from];
    this.vrot[to] = this.vrot[from];
    this.grav[to] = this.grav[from];
    this.drag[to] = this.drag[from];
    this.kind[to] = this.kind[from];
    this.col[to] = this.col[from];
  }

  /** @param P frame palette (arrays) ; colors[] css strings indexed by col */
  draw(ctx, colors) {
    const n = this.alive;
    // pass 1: puffs (most numerous) — grouped per colour index to limit state changes
    for (let c = 0; c < colors.length; c++) {
      ctx.fillStyle = colors[c];
      for (let i = 0; i < n; i++) {
        if (this.kind[i] !== PK.PUFF || this.col[i] !== c) continue;
        const u = this.life[i] / this.max[i];
        ctx.globalAlpha = Math.min(1, u * 1.6) * 0.7;
        const r = this.size[i] * (1.6 - u * 0.6);
        ctx.beginPath();
        ctx.arc(this.x[i], this.y[i], r, 0, TAU);
        ctx.fill();
      }
    }
    for (let i = 0; i < n; i++) {
      const k = this.kind[i];
      if (k === PK.PUFF) continue;
      const u = this.life[i] / this.max[i];
      const x = this.x[i];
      const y = this.y[i];
      const s = this.size[i];
      ctx.fillStyle = colors[this.col[i]];
      if (k === PK.SPARKLE) {
        ctx.globalAlpha = Math.sin(u * Math.PI);
        const r = s * (0.6 + 0.4 * Math.sin(u * 9));
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.quadraticCurveTo(x, y, x, y + r);
        ctx.quadraticCurveTo(x, y, x - r, y);
        ctx.quadraticCurveTo(x, y, x, y - r);
        ctx.fill();
      } else if (k === PK.SHARD) {
        ctx.globalAlpha = Math.min(1, u * 3);
        const c = Math.cos(this.rot[i]) * s;
        const sn = Math.sin(this.rot[i]) * s;
        ctx.beginPath();
        ctx.moveTo(x + c, y + sn);
        ctx.lineTo(x - sn * 0.8, y + c * 0.8);
        ctx.lineTo(x - c * 0.7, y - sn * 0.5);
        ctx.closePath();
        ctx.fill();
      } else if (k === PK.SPARK || k === PK.EMBER) {
        ctx.globalAlpha = k === PK.EMBER ? u * (0.6 + 0.4 * Math.sin(this.rot[i] * 3)) : Math.min(1, u * 2);
        if (k === PK.SPARK) {
          ctx.strokeStyle = colors[this.col[i]];
          ctx.lineWidth = s;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - this.vx[i] * 0.03, y - this.vy[i] * 0.03);
          ctx.stroke();
        } else {
          ctx.fillRect(x - s / 2, y - s / 2, s, s);
        }
      } else if (k === PK.RING) {
        ctx.globalAlpha = u * 0.9;
        ctx.strokeStyle = colors[this.col[i]];
        ctx.lineWidth = 2 * u + 0.5;
        ctx.beginPath();
        ctx.arc(x, y, s * (1 - u) + 4, 0, TAU);
        ctx.stroke();
      } else if (k === PK.CONFETTI) {
        ctx.globalAlpha = Math.min(1, u * 3);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(this.rot[i]);
        ctx.scale(Math.cos(this.rot[i] * 2.3), 1); // flutter: the paper flips
        ctx.fillRect(-s / 2, -s * 0.3, s, s * 0.6);
        ctx.restore();
      } else if (k === PK.HAT) {
        // the snowman's top hat, tumbling away
        ctx.globalAlpha = Math.min(1, u * 4);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(this.rot[i] * 0.6);
        ctx.fillRect(-s, s * 0.35, s * 2, s * 0.3);
        ctx.fillRect(-s * 0.62, -s * 0.75, s * 1.24, s * 1.12);
        ctx.restore();
      } else if (k === PK.FEATHER) {
        ctx.globalAlpha = Math.sin(u * Math.PI) * 0.9;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(this.rot[i] * 0.3);
        ctx.beginPath();
        ctx.ellipse(0, 0, s, s * 0.32, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }
}

