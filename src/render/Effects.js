/**
 * Screen-space finishing touches:
 *   - huge blurred foreground pines passing by fast (parallax > 1)
 *   - boost: speed streaks, warm edge glow, a pulse when a boost starts
 *   - vignette (stronger at night)
 *   - lightning white-out
 * The blurred pine is rendered once as a white mask (shadow-blur trick, works
 * in every browser) and re-tinted only when the silhouette colour drifts.
 */
import { clamp, smoothstep } from '../math/utils.js';
import { hash01 } from './DayCycle.js';
import { colorDistance, hex, mix, rgba } from './color.js';
import { makeCanvas, sizeCanvas } from './canvas.js';

const FG_SPACING = 3400; // world px between candidate foreground trees (in the fg plane)
const FG_PAR = 1.9;

export class Effects {
  constructor() {
    this.vignette = makeCanvas(1, 1);
    this.fgMask = null;
    this.fgTint = null;
    this.fgSig = null;
    this.w = 0;
    this.h = 0;
  }

  /** Radial speed-line burst from the rider when a boost fires. */
  burstAt(level, t) {
    this.burst = { level, t0: t };
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    const vw = 256;
    const vh = Math.max(16, Math.round((256 * h) / Math.max(1, w)));
    sizeCanvas(this.vignette, vw, vh);
    const ctx = this.vignette.getContext('2d');
    ctx.clearRect(0, 0, vw, vh);
    const g = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.32, vw / 2, vh / 2, Math.hypot(vw, vh) * 0.55);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
    this.buildForeground(h);
  }

  buildForeground(h) {
    // tall pine silhouette, ~1.25 screen heights tall, blurred
    const H = 360;
    const W = 170;
    const pad = 30;
    this.fgMask = makeCanvas(W + pad * 2, H + pad * 2);
    this.fgTint = makeCanvas(W + pad * 2, H + pad * 2);
    const ctx = this.fgMask.getContext('2d');
    const off = 5000;
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 9;
    ctx.shadowOffsetX = off;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    const cx = pad + W / 2 - off;
    const tiers = 7;
    for (let t = 0; t < tiers; t++) {
      const u = t / tiers;
      const yb = pad + H - u * H * 0.86;
      const top = yb - H * 0.26;
      const w = (W / 2) * (1 - u * 0.8);
      ctx.moveTo(cx, top);
      ctx.lineTo(cx + w * 0.5, yb - (yb - top) * 0.4);
      ctx.lineTo(cx + w, yb + 6);
      ctx.lineTo(cx - w, yb + 4);
      ctx.lineTo(cx - w * 0.5, yb - (yb - top) * 0.42);
      ctx.closePath();
    }
    ctx.rect(cx - 6, pad + H - 20, 12, 40);
    ctx.fill();
    this.fgSig = null;
    this.fgAspect = (W + pad * 2) / (H + pad * 2);
    void h;
  }

  tintForeground(col) {
    if (this.fgSig && colorDistance(this.fgSig, col) < 5) return;
    this.fgSig = col;
    const ctx = this.fgTint.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.fgTint.width, this.fgTint.height);
    ctx.drawImage(this.fgMask, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = rgba(col);
    ctx.fillRect(0, 0, this.fgTint.width, this.fgTint.height);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Big dark blurred pines sweeping past in the foreground. */
  drawForeground(ctx, cam, P, L, startX, riderSX, avoid) {
    const col = mix(P.deep, P.sil, 0.15);
    this.tintForeground(col);
    const k = cam.scale * FG_PAR;
    // smaller viewports (phones): smaller, rarer foreground trees
    const vk = clamp(Math.min(L.w, L.h) / 900, 0.4, 1);
    const sprH = L.h * (0.8 + 0.45 * vk);
    const sprW = sprH * this.fgAspect;
    const fx0 = cam.x + (-sprW - cam.anchorX) / k;
    const fx1 = cam.x + (L.w + sprW - cam.anchorX) / k;
    for (let i = Math.floor(fx0 / FG_SPACING); i <= Math.ceil(fx1 / FG_SPACING); i++) {
      if (hash01(i, 4242) < 0.78 + 0.12 * (1 - vk)) continue;
      const fx = i * FG_SPACING + hash01(i, 4243) * FG_SPACING * 0.5;
      if (fx < startX + 800) continue; // keep the start line clear
      const sx = cam.anchorX + (fx - cam.x) * k;
      const s = 0.8 + 0.4 * hash01(i, 4244);
      const top = L.h - sprH * s * (0.62 + 0.18 * hash01(i, 4245));
      // never over the rider (±120 px) nor over the HUD column on the left: fade out near them
      const half = sprW * s * 0.36; // the dense part of the blurred tree
      const gapRider = Math.abs(sx - riderSX) - half - 120;
      const gapHud = sx - half - 330;
      let gap = Math.min(gapRider, gapHud);
      // never over a hazard the rider is about to meet (screen x ranges passed by the renderer)
      for (let a = 0; a < avoid.n; a++) gap = Math.min(gap, Math.max(avoid.l[a] - (sx + half), sx - half - avoid.r[a]) - 40);
      const a = 0.92 * smoothstep(0, 160, gap);
      if (a <= 0.01) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(this.fgTint, sx - (sprW * s) / 2, top, sprW * s, sprH * s);
    }
    ctx.globalAlpha = 1;
  }

  /** Boost streaks + warmth + vignette + flash. */
  drawPost(ctx, atm, P, L, fx) {
    const t = L.t;
    const boost = fx.boost;
    if (boost > 0.01) {
      // speed streaks: thin wind lines in a band around the rider, flowing backwards
      const vk = clamp(Math.min(L.w, L.h) / 900, 0.4, 1);
      const n = Math.round(boost * 16 * vk);
      const dir = fx.dir;
      const cx = Math.cos(dir);
      const sy = Math.sin(dir);
      const cy = fx.ry ?? L.h * 0.55;
      ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const life = 0.35 + 0.25 * hash01(i, 77);
        const cyc = Math.floor(t / life + hash01(i, 78));
        const u = (t / life + hash01(i, 78)) % 1;
        const y0 = cy + (hash01(i, 79 + cyc) - 0.5) * L.h * 0.5;
        const x = L.w * (1.05 - u * 1.3);
        const len = (50 + 110 * hash01(i, 80 + cyc)) * (0.7 + boost * 0.3) * (0.5 + 0.5 * vk);
        if (Math.abs(y0 - cy) < L.h * 0.05) continue; // keep the rider clear
        const a = Math.sin(u * Math.PI) * 0.16 * boost;
        ctx.strokeStyle = `rgba(255,255,255,${a})`;
        ctx.lineWidth = 1 + hash01(i, 81);
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x + cx * len, y0 + sy * len);
        ctx.stroke();
      }
      // warm edge glow (the "chromatic warmth")
      const warm = hex(atm.accent);
      const g = ctx.createRadialGradient(L.w * 0.4, L.h * 0.55, Math.min(L.w, L.h) * 0.35, L.w * 0.4, L.h * 0.55, Math.hypot(L.w, L.h) * 0.62);
      g.addColorStop(0, rgba(warm, 0));
      g.addColorStop(1, rgba(warm, 0.32 * boost));
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, L.w, L.h);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (this.burst) {
      const age = t - this.burst.t0;
      const lv = this.burst.level;
      const dur = 0.3 + 0.08 * lv;
      if (age < 0 || age > dur) this.burst = null;
      else {
        const u = age / dur;
        const vk = clamp(Math.min(L.w, L.h) / 900, 0.4, 1);
        const n = Math.round((10 + 6 * lv) * (0.6 + 0.4 * vk));
        const r0 = (30 + u * (120 + 90 * lv)) * (0.55 + 0.45 * vk);
        const len = (36 + 34 * lv) * (1 - u * 0.5) * (0.55 + 0.45 * vk);
        ctx.lineCap = 'round';
        ctx.strokeStyle = `rgba(255,255,255,${(0.5 + 0.08 * lv) * (1 - u) * (1 - u)})`;
        ctx.lineWidth = 1.2 + 0.6 * lv;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + hash01(i, 61) * 0.4;
          const rr = r0 * (0.8 + 0.4 * hash01(i, 62));
          ctx.moveTo(fx.rx + Math.cos(a) * rr, fx.ryy + Math.sin(a) * rr);
          ctx.lineTo(fx.rx + Math.cos(a) * (rr + len), fx.ryy + Math.sin(a) * (rr + len));
        }
        ctx.stroke();
      }
    }
    if (fx.pulse > 0.01) {
      ctx.fillStyle = `rgba(255,240,215,${0.22 * fx.pulse})`;
      ctx.fillRect(0, 0, L.w, L.h);
    }
    // vignette
    const va = clamp(0.2 + atm.night * 0.25 + (atm.weather === 'storm' ? 0.15 * atm.weatherAmt : 0) + boost * 0.1, 0, 0.7);
    ctx.globalAlpha = va;
    ctx.drawImage(this.vignette, 0, 0, L.w, L.h);
    ctx.globalAlpha = 1;
    if (atm.flash > 0.01) {
      ctx.fillStyle = `rgba(235,240,255,${0.3 * atm.flash})`;
      ctx.fillRect(0, 0, L.w, L.h);
    }
    void P;
  }
}
