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
  /**
   * Falling snow in front of everything: soft round flakes at three depths (size, speed, sway
   * and parallax by depth), batched into one path per depth. Storm = the same snow driven by a
   * gusting wind: denser, faster, with short wind streaks on the nearest layer (no rain).
   */
  drawPrecip(ctx, atm, L) {
    const t = L.t;
    const W = L.w + 40;
    const H = L.h + 40;
    const cx = L.camX * L.baseScale;
    const cy = L.camY * L.baseScale;
    const night = atm.night;
    const flakeCol = rgba(mix([255, 255, 255], hex(atm.snow), 0.3 + night * 0.4));
    const amt = atm.weatherAmt;
    const storm = atm.weather === 'storm';
    let flakes = 34;
    if (atm.weather === 'snow') flakes += Math.round(amt * 420);
    if (atm.weather === 'fog') flakes += Math.round(amt * 40);
    if (storm) flakes += Math.round(amt * 480);
    flakes = Math.min(MAX_FLAKES, Math.round(flakes * (L.weatherScale ?? 1)));
    if (flakes <= 0) return;
    // wind: steady drift (snow) or gusting gale (storm)
    const gust = storm ? 0.6 + 0.4 * Math.sin(t * 0.7) * Math.sin(t * 1.9 + 1) + 0.25 * Math.sin(t * 4.1) : 0;
    const wind = storm ? (160 + 260 * Math.max(0, gust)) * amt : atm.weather === 'snow' ? 24 + 36 * amt : 10;
    const fallK = storm ? 1.8 : 1;
    ctx.fillStyle = flakeCol;
    // three depth bands: far (small, slow, faint) → near (bigger, faster, softer)
    for (let band = 0; band < 3; band++) {
      const lo = band === 0 ? 0 : band === 1 ? 0.75 : 1.35;
      const hi = band === 0 ? 0.75 : band === 1 ? 1.35 : 9;
      ctx.globalAlpha = band === 0 ? 0.55 : band === 1 ? 0.8 : 0.6;
      ctx.beginPath();
      for (let i = 0; i < flakes; i++) {
        const d = this.d[i];
        if (d < lo || d >= hi) continue;
        const sway = Math.sin(t * (0.8 + 0.4 * this.ph[i] / 6.28) + this.ph[i]) * 12 * d * (storm ? 0.4 : 1);
        const x = wrap(this.u[i] * W - cx * d * 0.5 - t * wind * d + sway, W) - 20;
        const y = wrap(this.v[i] * H + t * (20 + 44 * d) * fallK - cy * d * 0.35, H) - 20;
        const r = (0.45 + d * 0.75) * (0.75 + 0.5 * ((this.ph[i] * 7.3) % 1));
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (storm && amt > 0.05) {
      // short wind streaks on the nearest flakes only
      ctx.strokeStyle = rgba(mix([255, 255, 255], hex(atm.snow), 0.3), 0.35 * amt);
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < flakes; i += 3) {
        const d = this.d[i];
        if (d < 1.1) continue;
        const x = wrap(this.u[i] * W - cx * d * 0.5 - t * wind * d, W) - 20;
        const y = wrap(this.v[i] * H + t * (20 + 44 * d) * fallK - cy * d * 0.35, H) - 20;
        const len = (6 + 8 * d) * (0.5 + Math.max(0, gust));
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y - len * 0.25);
      }
      ctx.stroke();
    }
  }
}
