/**
 * Sky: gradient, sun / moon with soft halos, twinkling stars, the odd
 * shooting star, drifting cloud wisps (in depth slots so they can sit
 * between mountain layers) and occasional bird flocks.
 * All screen space; everything moves off `t` (race clock seconds) so two
 * clients — or two screenshots — look the same.
 */
import { createRandom } from '../math/random.js';
import { clamp, smoothstep } from '../math/utils.js';
import { hex, rgba, mix } from './color.js';
import { hash01 } from './DayCycle.js';
import { wrap } from './canvas.js';

const STAR_COUNT = 190;
const CLOUD_COUNT = 16;

export class Sky {
  constructor(seed) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    const r = createRandom((seed ^ 0x51c7) >>> 0);
    this.seed = seed;
    this.stars = Array.from({ length: STAR_COUNT }, () => ({
      x: r.next(),
      y: Math.pow(r.next(), 1.4) * 0.72,
      size: r.next() < 0.1 ? r.range(1.6, 2.4) : r.range(0.6, 1.4),
      phase: r.range(0, 6.28),
      speed: r.range(0.8, 2.6),
    }));
    // Cloud wisps: a long flat-bottomed capsule with a few soft bumps on top (unit length).
    this.clouds = Array.from({ length: CLOUD_COUNT }, (_, i) => {
      const slot = i < 6 ? 0 : 1 + (i % 4);
      const bumps = [];
      const n = 2 + r.int(0, 3);
      for (let k = 0; k < n; k++) bumps.push({ x: r.range(0.12, 0.8), r: r.range(0.9, 1.9), dy: r.range(0.1, 0.5) });
      const strands = [];
      const m = r.int(0, 2);
      for (let k = 0; k < m; k++) strands.push({ x: r.range(-0.2, 0.45), y: r.range(1.0, 1.5), len: r.range(0.35, 0.75), th: r.range(0.55, 0.8) });
      return {
        slot,
        u: r.next(),
        y: slot === 0 ? r.range(0.06, 0.34) : r.range(0.36, 0.62) + slot * 0.03,
        len: r.range(0.12, 0.3) * (slot === 0 ? 1.2 : 0.8),
        thick: r.range(0.014, 0.024) * (slot === 0 ? 1 : 1.3),
        alpha: slot === 0 ? r.range(0.45, 0.75) : r.range(0.12, 0.26),
        speed: r.range(4, 12),
        par: slot === 0 ? 0.006 : 0.01 + slot * 0.025,
        bumps,
        strands,
      };
    });
  }

  /** Background gradient (sky to haze at the horizon, solid haze below). */
  drawGradient(ctx, atm, L) {
    const g = ctx.createLinearGradient(0, 0, 0, L.horizonY);
    g.addColorStop(0, atm.skyTop);
    g.addColorStop(0.5, atm.skyMid);
    g.addColorStop(1, atm.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, L.w, L.horizonY + 1);
    ctx.fillStyle = atm.skyBottom;
    ctx.fillRect(0, L.horizonY, L.w, L.h - L.horizonY);
  }

  drawStars(ctx, atm, L) {
    if (atm.stars <= 0.01) return;
    const t = L.t;
    ctx.fillStyle = '#ffffff';
    const drift = wrap(L.camX * L.baseScale * 0.003, L.w);
    for (const s of this.stars) {
      const y = s.y * L.h;
      if (y > L.horizonY) continue;
      const tw = 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
      // fade near the horizon haze
      const a = atm.stars * tw * (1 - smoothstep(L.horizonY * 0.55, L.horizonY * 0.95, y));
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      const x = wrap(s.x * L.w - drift, L.w);
      const z = s.size;
      if (z > 1.5) {
        // bright star: tiny cross
        ctx.fillRect(x - z * 1.6, y - 0.4, z * 3.2, 0.8);
        ctx.fillRect(x - 0.4, y - z * 1.6, 0.8, z * 3.2);
      }
      ctx.fillRect(x - z / 2, y - z / 2, z, z);
    }
    ctx.globalAlpha = 1;
    this.drawShootingStar(ctx, atm, L);
  }

  drawShootingStar(ctx, atm, L) {
    const SLOT = 7.5;
    const slot = Math.floor(L.t / SLOT);
    if (hash01(this.seed, 300 + slot) > 0.42) return;
    const start = slot * SLOT + hash01(this.seed, 400 + slot) * (SLOT - 1.2);
    const u = (L.t - start) / 0.9;
    if (u < 0 || u > 1) return;
    const x0 = (0.2 + 0.6 * hash01(this.seed, 500 + slot)) * L.w;
    const y0 = (0.05 + 0.2 * hash01(this.seed, 600 + slot)) * L.h;
    const dx = -L.w * 0.22;
    const dy = L.h * 0.12;
    const hx = x0 + dx * u;
    const hy = y0 + dy * u;
    const tail = 0.28;
    const tx = hx - dx * tail;
    const ty = hy - dy * tail;
    const a = atm.stars * Math.sin(Math.PI * u);
    const g = ctx.createLinearGradient(tx, ty, hx, hy);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, `rgba(255,255,255,${a})`);
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();
  }

  /** Sun and moon: flat discs with a big faint halo. */
  drawBodies(ctx, atm, L) {
    const R = (atm._sunR ?? 0.06) * L.h;
    const sunUp = atm.sunPos.y < 0.95;
    if (sunUp) this.drawDisc(ctx, atm.sunPos.x * L.w, atm.sunPos.y * L.h, R, atm.sun, atm.glow, 1 - atm.night * 0.5, L, false);
    if (atm.moonPos.y < 0.95 && atm.night > 0.2) {
      const a = smoothstep(0.2, 0.7, atm.night);
      this.drawDisc(ctx, atm.moonPos.x * L.w, atm.moonPos.y * L.h, L.h * 0.05, atm._moon, atm.glow, a, L, true);
    }
  }

  drawDisc(ctx, x, y, r, color, glow, alpha, L, moon) {
    const storm = this.stormDim ?? 1;
    const g0 = hex(glow);
    // Large faint halo + a tighter warm one.
    const big = r * (moon ? 7 : 9);
    let g = ctx.createRadialGradient(x, y, r * 0.8, x, y, big);
    g.addColorStop(0, rgba(g0, 0.42 * alpha * storm));
    g.addColorStop(0.35, rgba(g0, 0.14 * alpha * storm));
    g.addColorStop(1, rgba(g0, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - big, y - big, big * 2, big * 2);
    const mid = r * 2.4;
    g = ctx.createRadialGradient(x, y, r * 0.9, x, y, mid);
    g.addColorStop(0, rgba(g0, 0.5 * alpha * storm));
    g.addColorStop(1, rgba(g0, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - mid, y - mid, mid * 2, mid * 2);
    ctx.globalAlpha = alpha * storm * storm;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (moon) {
      // a couple of soft maria so it reads as the moon
      ctx.globalAlpha = alpha * 0.045;
      ctx.fillStyle = '#5a6488';
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - r * 0.2, r * 0.32, 0, Math.PI * 2);
      ctx.arc(x + r * 0.25, y + r * 0.3, r * 0.22, 0, Math.PI * 2);
      ctx.arc(x + r * 0.35, y - r * 0.35, r * 0.13, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Cloud wisps belonging to one depth slot (0 = high, behind everything; 1..4 between ridge layers). */
  drawClouds(ctx, atm, L, slot) {
    const base = hex(atm._cloud);
    const amt = atm.weather === 'storm' ? 1 + atm.weatherAmt * 0.6 : atm.weather === 'fog' ? 1 + atm.weatherAmt * 0.4 : 1;
    ctx.fillStyle = rgba(base, 1);
    for (const c of this.clouds) {
      if (c.slot !== slot) continue;
      const len = c.len * L.h * 2.2;
      const th = c.thick * L.h;
      const span = L.w + len * 2;
      const x = wrap(c.u * span + L.t * c.speed - L.camX * L.baseScale * c.par, span) - len;
      const y = c.y * L.h + (slot === 0 ? 0 : L.vshift * c.par * 8);
      ctx.globalAlpha = clamp(c.alpha * amt, 0, 0.85);
      ctx.beginPath();
      ctx.roundRect(x, y - th, len, th, th / 2);
      for (const b of c.bumps) {
        const br = Math.min(th * b.r * 0.5, th * (0.5 + b.dy));
        ctx.moveTo(x + b.x * len + br, y - th * 0.5);
        ctx.arc(x + b.x * len, y - th * (0.5 + b.dy), br, 0, Math.PI * 2);
      }
      for (const st of c.strands) {
        const sh = th * st.th;
        ctx.roundRect(x + st.x * len, y - th * 0.5 + st.y * th * 0.5, st.len * len, sh, sh / 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Small flocks of birds crossing now and then. */
  drawBirds(ctx, atm, L) {
    const SLOT = 22;
    const slot = Math.floor(L.t / SLOT);
    if (hash01(this.seed, 900 + slot) > 0.5 || atm.weather === 'storm') return;
    const u = (L.t - slot * SLOT) / SLOT;
    const n = 3 + Math.floor(hash01(this.seed, 901 + slot) * 5);
    const y0 = (0.16 + 0.22 * hash01(this.seed, 902 + slot)) * L.h;
    const x0 = L.w * (1.15 - u * 1.4);
    const col = mix(hex(atm.silhouette), hex(atm.skyMid), 0.35);
    ctx.strokeStyle = rgba(col, 0.85);
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const bx = x0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 16 + i * 6;
      const by = y0 + Math.ceil(i / 2) * 9 + Math.sin(L.t * 1.3 + i) * 3;
      const flap = Math.sin(L.t * 9 + i * 1.7);
      const s = 5 + (i % 3);
      ctx.moveTo(bx - s, by - s * 0.5 * flap);
      ctx.quadraticCurveTo(bx - s * 0.4, by - s * 0.3 * flap - 1, bx, by);
      ctx.quadraticCurveTo(bx + s * 0.4, by - s * 0.3 * flap - 1, bx + s, by - s * 0.5 * flap);
    }
    ctx.stroke();
  }
}
