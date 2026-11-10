/**
 * Screen-space weather. Every flake / streak position is a pure function of
 * (time, camera position) — no state — so it is deterministic and costs no
 * allocation. Depth `d` drives size, speed and how strongly the flake slides
 * with the camera (near flakes stream past fast, far ones barely move).
 *
 *   snow   multi-depth flakes drifting diagonally, gently swaying
 *   storm  rain streaks slanted by wind + camera motion (lightning is a flash in DayCycle)
 *   fog    drifting horizontal fog bands and an overall veil
 *   always a handful of slow motes so the air is never empty
 */
import { createRandom } from '../math/random.js';
import { hex, mix, rgba } from './color.js';
import { wrap } from './canvas.js';

const MAX_FLAKES = 520;

export class Weather {
  constructor() {
    const r = createRandom(424242);
    this.u = new Float32Array(MAX_FLAKES);
    this.v = new Float32Array(MAX_FLAKES);
    this.d = new Float32Array(MAX_FLAKES);
    this.ph = new Float32Array(MAX_FLAKES);
    for (let i = 0; i < MAX_FLAKES; i++) {
      this.u[i] = r.next();
      this.v[i] = r.next();
      // more far flakes than near ones
      this.d[i] = 0.25 + Math.pow(r.next(), 1.8) * 1.75;
      this.ph[i] = r.range(0, 6.28);
    }
  }

  /** Fog bands sitting low over the slope (drawn before riders so they sit "in" the scene). */
  drawFog(ctx, atm, L) {
    const fog = atm._fog ?? 0;
    const base = 0.1 + fog * 0.55;
    const col = hex(atm.skyBottom);
    const t = L.t;
    for (let i = 0; i < 3; i++) {
      const y = L.h * (0.46 + i * 0.17) + Math.sin(t * 0.07 + i * 2) * L.h * 0.02;
      const hh = L.h * (0.12 + 0.05 * i);
      const a = base * (0.55 + 0.45 * Math.sin(t * 0.11 + i * 1.7));
      if (a < 0.02) continue;
      const g = ctx.createLinearGradient(0, y - hh, 0, y + hh);
      g.addColorStop(0, rgba(col, 0));
      g.addColorStop(0.5, rgba(col, a));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, y - hh, L.w, hh * 2);
    }
    if (fog > 0.02) {
      ctx.fillStyle = rgba(col, fog * 0.22);
      ctx.fillRect(0, 0, L.w, L.h);
    }
  }

  /** Falling stuff in front of everything. */
  drawPrecip(ctx, atm, L) {
    const t = L.t;
    const W = L.w + 40;
    const H = L.h + 40;
    const cx = L.camX * L.baseScale;
    const cy = L.camY * L.baseScale;
    const night = atm.night;
    const flakeCol = rgba(mix([255, 255, 255], hex(atm.snow), 0.3 + night * 0.4));
    const amt = atm.weatherAmt;

    // ambient motes + snow flakes
    let flakes = 34;
    if (atm.weather === 'snow') flakes += Math.round(amt * 440);
    if (atm.weather === 'fog') flakes += Math.round(amt * 40);
    if (atm.weather === 'storm') flakes = 0;
    if (flakes > 0) {
      ctx.fillStyle = flakeCol;
      const wind = atm.weather === 'snow' ? 26 + 40 * amt : 10;
      for (let i = 0; i < flakes && i < MAX_FLAKES; i++) {
        const d = this.d[i];
        const sway = Math.sin(t * 0.9 + this.ph[i]) * 14 * d;
        const x = wrap(this.u[i] * W - cx * d * 0.5 - t * wind * d + sway, W) - 20;
        const y = wrap(this.v[i] * H + t * (22 + 46 * d) - cy * d * 0.35, H) - 20;
        const s = 0.7 + d * 1.5;
        ctx.globalAlpha = i < 34 ? 0.35 : d > 1.4 ? 0.45 : 0.8;
        if (s < 2) ctx.fillRect(x, y, s, s);
        else {
          ctx.beginPath();
          ctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    if (atm.weather === 'storm' && amt > 0.02) {
      const n = Math.round(320 * amt);
      const vxCam = L.camVx * L.baseScale;
      ctx.strokeStyle = rgba(mix([200, 210, 230], hex(atm.skyBottom), 0.3), 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const d = this.d[i];
        const fall = 900 + 500 * d;
        const wx = -180 - vxCam * 0.6 * d;
        const x = wrap(this.u[i] * W + t * wx * 0.4 - cx * d * 0.6, W) - 20;
        const y = wrap(this.v[i] * H + t * fall, H) - 20;
        const len = 0.018 + 0.012 * d;
        ctx.moveTo(x, y);
        ctx.lineTo(x - wx * len, y - fall * len);
      }
      ctx.stroke();
    }
  }
}
