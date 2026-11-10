/**
 * The riding slope.
 *
 * heightAt is sampled across the visible span every ~7 screen px (on a
 * world-aligned grid so vertices do not shimmer while scrolling), with extra
 * samples exactly at chasm edges so cliffs stay vertical and crisp.
 *
 * Body: clipped to the surface polygon, a vertical snow → snowShade gradient
 * is laid down in narrow columns that each start at the local surface, so the
 * shading follows the slope (a single linear gradient would not). A thin
 * bright lip is stroked along the top edge. Chasms are drawn as deep dark
 * gaps with layered rock cliff faces and a snow overhang.
 */
import { clamp } from '../math/utils.js';
import { hex, mix, rgba, scale } from './color.js';
import { makeCanvas } from './canvas.js';
import { FeatureType } from '../contracts.js';
import { hash01 } from './DayCycle.js';

const MAX_SAMPLES = 2048;

/**
 * Surface y ignoring chasm pits (a straight line across the gap): what the
 * camera and pose helpers treat as "the ground" so flying over a chasm does
 * not count as being 900 px up.
 */
export function surfaceY(course, x) {
  const fs = course.featuresIn(x, x);
  for (const f of fs) {
    if (f.type === FeatureType.CHASM && x > f.x0 && x < f.x1) {
      const a = Number.isFinite(f.y0) ? f.y0 : course.heightAt(f.x0 - 0.5);
      const b = Number.isFinite(f.y1) ? f.y1 : course.heightAt(f.x1 + 0.5);
      return a + ((b - a) * (x - f.x0)) / (f.x1 - f.x0);
    }
  }
  return course.heightAt(x);
}
const GRAD_H = 128;

export class TerrainRenderer {
  constructor() {
    this.wx = new Float64Array(MAX_SAMPLES);
    this.sx = new Float32Array(MAX_SAMPLES);
    this.sy = new Float32Array(MAX_SAMPLES);
    this.pit = new Uint8Array(MAX_SAMPLES);
    this.n = 0;
    this.grad = makeCanvas(1, GRAD_H);
    this.gradSig = '';
    this.chasms = [];
  }

  /** Samples the surface for the current camera. */
  sample(course, cam, L) {
    const x0 = cam.worldX(-30);
    const x1 = cam.worldX(L.w + 30);
    const step = Math.max(2, 7 / cam.scale);
    // power-of-two-ish quantised step so the grid is stable under small zoom changes
    const q = Math.pow(2, Math.round(Math.log2(step) * 2) / 2);
    const chasms = (this.chasms = []);
    for (const f of course.featuresIn(x0 - 50, x1 + 50)) if (f.type === FeatureType.CHASM) chasms.push(f);
    let n = 0;
    let ci = 0;
    const push = (x, inPit) => {
      if (n >= MAX_SAMPLES) return;
      this.wx[n] = x;
      const y = course.heightAt(x);
      this.sx[n] = cam.sx(x);
      this.sy[n] = cam.sy(y);
      this.pit[n] = inPit ? 1 : 0;
      n++;
    };
    let x = Math.floor(x0 / q) * q;
    while (x <= x1 + q) {
      // inject chasm edges in order
      while (ci < chasms.length && chasms[ci].x0 <= x) {
        const c = chasms[ci++];
        const e0 = c.x0;
        const e1 = c.x1;
        push(e0 - 0.01, false);
        push(e0 + 0.01, true);
        push(e1 - 0.01, true);
        push(e1 + 0.01, false);
        if (x < e1) x = Math.ceil(e1 / q) * q;
      }
      push(x, false);
      x += q;
    }
    this.n = n;
  }

  ensureGradient(atm) {
    const sig = atm.snow + atm.snowShade + atm.skyBottom;
    if (sig === this.gradSig) return;
    this.gradSig = sig;
    const ctx = this.grad.getContext('2d');
    const snow = hex(atm.snow);
    const shade = hex(atm.snowShade);
    const g = ctx.createLinearGradient(0, 0, 0, GRAD_H);
    g.addColorStop(0, rgba(snow));
    g.addColorStop(0.08, rgba(snow));
    g.addColorStop(0.35, rgba(mix(snow, shade, 0.38)));
    g.addColorStop(0.7, rgba(mix(snow, shade, 0.8)));
    g.addColorStop(1, rgba(shade));
    ctx.clearRect(0, 0, 1, GRAD_H);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1, GRAD_H);
  }

  /** Builds the closed body path (surface + screen bottom). */
  bodyPath(ctx, L) {
    const { sx, sy, n } = this;
    ctx.beginPath();
    ctx.moveTo(sx[0], sy[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(sx[i], sy[i]);
    const bottom = L.h + 40;
    ctx.lineTo(sx[n - 1], Math.max(bottom, sy[n - 1] + 10));
    ctx.lineTo(sx[0], Math.max(bottom, sy[0] + 10));
    ctx.closePath();
  }

  drawBody(ctx, atm, cam, L) {
    if (this.n < 2) return;
    this.ensureGradient(atm);
    const { sx, sy, pit, n } = this;
    ctx.save();
    this.bodyPath(ctx, L);
    ctx.fillStyle = atm.snowShade;
    ctx.fill();
    ctx.clip();
    // gradient columns following the surface
    const depth = clamp(520 * cam.scale, 220, 900);
    const colW = 10;
    let i = 0;
    for (let x = Math.max(-10, sx[0]); x < Math.min(L.w + 10, sx[n - 1]); x += colW) {
      while (i < n - 2 && sx[i + 1] < x) i++;
      if (pit[i] && pit[i + 1]) continue;
      // highest surface point within the column
      let top = sy[i];
      for (let j = i + 1; j < n && sx[j] <= x + colW; j++) if (!pit[j] && sy[j] < top) top = sy[j];
      if (sy[i + 1] < top && !pit[i + 1]) top = sy[i + 1];
      ctx.drawImage(this.grad, 0, 0, 1, GRAD_H, x, top - 2, colW + 0.6, depth);
    }
    this.drawSurfaceDetail(ctx, atm, cam, L);
    ctx.restore();
  }

  /** Soft wind-ripple bands inside the snow body, parallel to the surface. */
  drawSurfaceDetail(ctx, atm, cam, L) {
    const { sx, sy, pit, n } = this;
    const shade = hex(atm.snowShade);
    const k = cam.scale;
    const bands = [
      [34, 0.035, 10],
      [96, 0.045, 22],
      [190, 0.055, 40],
    ];
    for (const [off, a, wid] of bands) {
      ctx.strokeStyle = rgba(shade, a);
      ctx.lineWidth = wid * k;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        if (pit[i]) {
          pen = false;
          continue;
        }
        // undulate the offset along x so bands look like drifts, not copies
        const o = off * k * (1 + 0.35 * Math.sin(this.wx[i] * 0.0021 + off));
        if (!pen) ctx.moveTo(sx[i], sy[i] + o);
        else ctx.lineTo(sx[i], sy[i] + o);
        pen = true;
      }
      ctx.stroke();
    }
  }

  /** Bright thin lip along the top edge. */
  drawLip(ctx, atm, cam) {
    const { sx, sy, pit, n } = this;
    const lip = mix(hex(atm.snow), [255, 255, 255], 0.65);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(lip, 0.95);
    ctx.lineWidth = Math.max(1.4, 2.6 * cam.scale);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      if (pit[i]) {
        pen = false;
        continue;
      }
      if (!pen) ctx.moveTo(sx[i], sy[i] + 1);
      else ctx.lineTo(sx[i], sy[i] + 1);
      pen = true;
    }
    ctx.stroke();
  }

  /** Chasm pits: dark depth gradient + rock cliff faces + snow overhangs. */
  drawChasms(ctx, atm, cam, L, course) {
    if (!this.chasms.length) return;
    const sil = hex(atm.silhouette);
    const shade = hex(atm.snowShade);
    const haze = hex(atm.skyBottom);
    const ridge = hex(atm.ridges[4]);
    const rockLit = mix(sil, ridge, 0.5);
    const rockMid = mix(sil, ridge, 0.26);
    const rockBand = mix(rockMid, rockLit, 0.45);
    const deep = scale(sil, 0.55);
    const snow = hex(atm.snow);
    for (const c of this.chasms) {
      const xa = cam.sx(c.x0);
      const xb = cam.sx(c.x1);
      if (xb < -60 || xa > L.w + 60) continue;
      const ya = cam.sy(Number.isFinite(c.y0) ? c.y0 : course.heightAt(c.x0 - 0.5));
      const yb = cam.sy(Number.isFinite(c.y1) ? c.y1 : course.heightAt(c.x1 + 0.5));
      const k = cam.scale;
      const yTop = Math.min(ya, yb);
      // the gap opens at the LOWER lip; above it, between the lips, the background shows
      // and the higher side exposes its rock wall (drawn by face())
      const yLow = Math.max(ya, yb);
      const wWorld = c.x1 - c.x0;
      const narrow = wWorld < 120; // crevasse: a dark crack
      const wide = wWorld > 200; // gorge: far wall + mist
      const seed = c.id * 13 + (c.variant ?? 0);
      const bottom = Math.max(L.h + 20, yTop + 700 * k);
      const gw = xb - xa;

      // 1. the gap. Its top edge is the FAR rim of the gorge: a jagged line a little below
      // the lips, with a thin snow edge; the far wall under it is hazy, darkening with depth.
      const rimY = (x) => {
        const u = (x - xa) / (gw || 1);
        return ya + (yb - ya) * u + (10 + 7 * Math.sin(u * 9.1 + seed) + 4 * hash01(seed, Math.floor(u * 12))) * k;
      };
      const g = ctx.createLinearGradient(0, yTop, 0, yLow + (narrow ? 160 : 360) * k);
      g.addColorStop(0, rgba(narrow ? mix(shade, sil, 0.7) : mix(mix(rockMid, haze, 0.5), shade, 0.2)));
      g.addColorStop(0.35, rgba(mix(sil, rockMid, 0.5)));
      g.addColorStop(1, rgba(deep));
      ctx.fillStyle = g;
      ctx.beginPath();
      const steps = Math.max(4, Math.ceil(gw / (14 * k)));
      ctx.moveTo(xa, ya + 2);
      for (let i = 1; i < steps; i++) {
        const x = xa + (gw * i) / steps;
        ctx.lineTo(x, rimY(x));
      }
      ctx.lineTo(xb, yb + 2);
      ctx.lineTo(xb, Math.max(L.h + 20, yLow + 1));
      ctx.lineTo(xa, Math.max(L.h + 20, yLow + 1));
      ctx.closePath();
      ctx.fill();
      if (!narrow) {
        ctx.strokeStyle = rgba(mix(snow, haze, 0.35), 0.75);
        ctx.lineWidth = 1.6 * k;
        ctx.beginPath();
        for (let i = 1; i < steps; i++) {
          const x = xa + (gw * i) / steps;
          if (i === 1) ctx.moveTo(x, rimY(x));
          else ctx.lineTo(x, rimY(x));
        }
        ctx.stroke();
      }

      // 2. wide gorge: a hazy far wall with strata, then rising mist
      if (wide) {
        const fx0 = xa + gw * 0.12;
        const fx1 = xb - gw * 0.12;
        const fTop = yTop + 70 * k;
        ctx.fillStyle = rgba(mix(rockMid, haze, 0.3));
        ctx.beginPath();
        ctx.moveTo(fx0, bottom);
        const n = 9;
        for (let i = 0; i <= n; i++) {
          const u = i / n;
          ctx.lineTo(fx0 + (fx1 - fx0) * u, fTop + (hash01(seed, 200 + i) * 45 + Math.sin(u * Math.PI) * 25) * k);
        }
        ctx.lineTo(fx1, bottom);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = rgba(mix(rockMid, haze, 0.25), 0.7);
        ctx.lineWidth = 2 * k;
        ctx.beginPath();
        for (let b = 0; b < 4; b++) {
          const by = fTop + (70 + b * 55) * k;
          ctx.moveTo(fx0 + 6 * k, by);
          for (let i = 1; i <= 6; i++) ctx.lineTo(fx0 + ((fx1 - fx0) * i) / 6, by + (hash01(seed, 300 + b * 9 + i) - 0.5) * 10 * k);
        }
        ctx.stroke();
      }

      // 3. cliff walls with strata: alternating rock bands, jagged edges
      const face = (x, y, dir, wFrac, colA, colB, layer, converge) => {
        let yy = y;
        let ww = gw * wFrac;
        let prevW = ww * 0.6;
        let i = 0;
        while (yy < bottom) {
          const seg = (18 + hash01(seed + layer, i) * 26) * k;
          const wNow = ww * (0.6 + 0.5 * hash01(seed + layer * 7, i));
          ctx.fillStyle = rgba(i % 2 ? colA : colB);
          ctx.beginPath();
          ctx.moveTo(x, yy - 0.5);
          ctx.lineTo(x + dir * prevW, yy - 0.5);
          ctx.lineTo(x + dir * wNow, yy + seg * 0.45);
          ctx.lineTo(x + dir * wNow * (0.78 + 0.18 * hash01(seed, i + 50)), yy + seg + 0.5);
          ctx.lineTo(x, yy + seg + 0.5);
          ctx.closePath();
          ctx.fill();
          prevW = wNow * (0.78 + 0.18 * hash01(seed, i + 50));
          yy += seg;
          ww *= converge;
          i++;
        }
      };
      if (narrow) {
        // a crack: walls lean in and nearly meet a little way down
        face(xa, ya, 1, 0.46, rockMid, rockBand, 1, 1.03);
        face(xb, yb, -1, 0.46, mix(rockMid, deep, 0.35), rockMid, 2, 1.03);
      } else {
        face(xa, ya, 1, wide ? 0.16 : 0.26, rockMid, rockBand, 1, 0.98);
        face(xb, yb, -1, wide ? 0.13 : 0.2, mix(rockMid, deep, 0.35), rockMid, 2, 0.98);
        face(xa, ya, 1, wide ? 0.07 : 0.12, rockLit, mix(rockLit, rockMid, 0.5), 3, 0.97);
        face(xb, yb, -1, wide ? 0.05 : 0.08, rockMid, rockBand, 4, 0.97);
      }
      if (wide || !narrow) {
        // mist pooling at the bottom
        const my = yTop + (wide ? 220 : 280) * k;
        const mg = ctx.createLinearGradient(0, my, 0, my + 260 * k);
        mg.addColorStop(0, rgba(haze, 0));
        mg.addColorStop(1, rgba(haze, wide ? 0.5 : 0.25));
        ctx.fillStyle = mg;
        ctx.fillRect(xa, my, gw, Math.max(0, bottom - my));
      }

      // 4. shaded snow walls along the cut edges
      const wall = 7 * k;
      for (const [x, y, dir] of [
        [xa, ya, -1],
        [xb, yb, 1],
      ]) {
        const sg = ctx.createLinearGradient(x, 0, x + dir * wall, 0);
        sg.addColorStop(0, rgba(mix(shade, sil, 0.3), 0.9));
        sg.addColorStop(1, rgba(shade, 0));
        ctx.fillStyle = sg;
        ctx.fillRect(dir < 0 ? x - wall : x, y + 2, wall, bottom - y);
      }

      // 5. snow cornices overhanging both lips, with icicles
      ctx.fillStyle = rgba(snow);
      const corn = narrow ? 0.6 : 1;
      for (const [x, y, dir] of [
        [xa, ya, 1],
        [xb, yb, -1],
      ]) {
        const q = corn * k;
        ctx.beginPath();
        ctx.moveTo(x - dir * 6 * q, y - 0.5);
        ctx.quadraticCurveTo(x + dir * 14 * q, y - 3 * q, x + dir * 18 * q, y + 4 * q);
        ctx.lineTo(x + dir * 15 * q, y + 7 * q);
        ctx.lineTo(x + dir * 13 * q, y + 17 * q);
        ctx.lineTo(x + dir * 11 * q, y + 8 * q);
        ctx.lineTo(x + dir * 7 * q, y + 13 * q);
        ctx.lineTo(x + dir * 5 * q, y + 8 * q);
        ctx.lineTo(x + dir * 2 * q, y + 11 * q);
        ctx.lineTo(x - dir * 2 * q, y + 8 * q);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}
