/**
 * Distant scenery: five layered ridges, far → near.
 *
 *   0..2  alpine peaks: crisp triangular silhouettes with a lit face and a
 *         darker shadow face split along a jagged ridge line (+ a faint cap)
 *   3     lower rocky ridges with a scatter of pines
 *   4     rolling forested hills covered with tiny pine silhouettes
 *
 * Geometry is generated once per (seed, screen size) as Path2D objects in a
 * wide tileable strip. Each layer owns one offscreen canvas holding the strip
 * already TINTED with the current atmosphere (vertical gradient from the
 * ridge colour to the horizon haze at its base). Re-tinting is a couple of
 * path fills and only happens when the palette has drifted noticeably — at
 * most one layer per frame — so a normal frame is just a few drawImage calls.
 */
import { createRandom } from '../math/random.js';
import { clamp } from '../math/utils.js';
import { hex, mix, rgba, scale, colorDistance } from './color.js';
import { makeCanvas, sizeCanvas, wrap } from './canvas.js';

/* All vertical values are fractions of the screen height. */
const LAYERS = [
  { kind: 'alpine', par: 0.012, top: 0.13, range: 0.2, valley: 0.16, base: 0.72, spacing: [0.42, 0.9], fade: 0.85, shade: 0.3, cap: 0.3 },
  { kind: 'alpine', par: 0.03, top: 0.27, range: 0.17, valley: 0.13, base: 0.8, spacing: [0.3, 0.62], fade: 0.8, shade: 0.42, cap: 0.22 },
  { kind: 'alpine', par: 0.06, top: 0.4, range: 0.13, valley: 0.1, base: 0.88, spacing: [0.2, 0.46], fade: 0.72, shade: 0.55, cap: 0.14 },
  { kind: 'ridge', par: 0.11, top: 0.52, range: 0.1, valley: 0.06, base: 0.98, spacing: [0.14, 0.32], fade: 0.68, shade: 0.5, cap: 0, pines: 0.35 },
  { kind: 'hills', par: 0.2, top: 0.62, range: 0.08, valley: 0.05, base: 1.08, spacing: [0.2, 0.4], fade: 0.62, shade: 0.4, cap: 0, pines: 1 },
];

const TILE_W = 2.2; // strip width in screen heights

export class Parallax {
  constructor(seed) {
    this.seed = seed;
    this.layers = LAYERS.map((cfg) => ({ cfg, canvas: makeCanvas(1, 1), sig: null, geo: null }));
    this.h = 0;
    this.res = 1;
  }

  setSeed(seed) {
    this.seed = seed;
    this.h = 0; // force rebuild on next resize/draw
  }

  /** Builds geometry for a screen height (CSS px) and resolution. */
  build(h, dpr) {
    this.h = h;
    // Strips are soft distant shapes: cap their resolution to save memory.
    this.res = clamp(dpr, 1, 1.5);
    const W = TILE_W * h;
    this.layers.forEach((layer, i) => {
      const cfg = layer.cfg;
      const r = createRandom((this.seed * 31 + i * 7919) >>> 0);
      const stripTop = cfg.top - 0.03;
      const stripH = cfg.base + 0.04 - stripTop;
      const k = h * this.res;
      sizeCanvas(layer.canvas, W * this.res, stripH * k);
      layer.stripTop = stripTop;
      layer.stripH = stripH;
      layer.W = W;
      const geo = cfg.kind === 'hills' ? hills(r, cfg, TILE_W) : alpine(r, cfg, TILE_W, cfg.kind === 'ridge');
      // Build Path2D in strip pixel space (x * k, (y - stripTop) * k), drawn at -W, 0, +W so seams wrap.
      const bottom = stripH * k + 2;
      const toPath = (polys, closeToBottom) => {
        const path = new Path2D();
        for (const off of [-TILE_W, 0, TILE_W]) {
          for (const poly of polys) {
            path.moveTo((poly[0] + off) * k, (poly[1] - stripTop) * k);
            for (let j = 2; j < poly.length; j += 2) path.lineTo((poly[j] + off) * k, (poly[j + 1] - stripTop) * k);
            if (closeToBottom) {
              path.lineTo((poly[poly.length - 2] + off) * k, bottom);
              path.lineTo((poly[0] + off) * k, bottom);
            }
            path.closePath();
          }
        }
        return path;
      };
      layer.body = toPath([geo.outline], true);
      layer.shadow = geo.shadows.length ? toPath(geo.shadows, false) : null;
      layer.caps = geo.caps.length ? toPath(geo.caps, false) : null;
      layer.trees = geo.trees.length ? toPath(geo.trees, false) : null;
      layer.sig = null;
    });
  }

  /** Colours a layer should currently have. */
  colorsFor(i, atm) {
    const cfg = LAYERS[i].cfg ?? LAYERS[i];
    const c = hex(atm.ridges[i]);
    const glow = hex(atm.glow);
    const haze = hex(atm.skyBottom);
    const day = 1 - atm.night;
    const lit = mix(c, glow, 0.08 + 0.1 * day);
    const next = hex(atm.ridges[Math.min(4, i + 1)]);
    const shade = i < 4 ? mix(c, scale(next, 0.95), cfg.shade) : scale(c, 0.78);
    const cap = mix(lit, [255, 255, 255], 0.35 * day + 0.12);
    const fog = atm._fog ?? 0;
    return { lit, shade, cap, haze, fade: clamp(cfg.fade + fog * 0.2, 0, 0.97) };
  }

  tint(layer, i, colors) {
    const ctx = layer.canvas.getContext('2d');
    const cw = layer.canvas.width;
    const ch = layer.canvas.height;
    const { lit, shade, cap, haze, fade } = colors;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cw, ch);
    const cfg = layer.cfg;
    const k = this.h * this.res;
    const y0 = (cfg.top - layer.stripTop) * k;
    const y1 = (cfg.base - layer.stripTop) * k;
    const grad = (col, fadeMul = 1) => {
      const g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, rgba(col));
      g.addColorStop(0.5, rgba(mix(col, haze, fade * 0.42 * fadeMul)));
      g.addColorStop(1, rgba(mix(col, haze, fade * fadeMul)));
      return g;
    };
    ctx.fillStyle = grad(lit);
    ctx.fill(layer.body);
    if (layer.trees) ctx.fill(layer.trees);
    ctx.globalCompositeOperation = 'source-atop';
    if (layer.shadow) {
      ctx.fillStyle = grad(shade, 0.92);
      ctx.fill(layer.shadow);
    }
    if (layer.caps && cfg.cap > 0) {
      ctx.globalAlpha = cfg.cap;
      ctx.fillStyle = grad(cap, 1.1);
      ctx.fill(layer.caps);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
    layer.sig = colors;
  }

  /** Re-tints whichever layer drifted most (or all when `force`). */
  update(atm, force) {
    let worst = -1;
    let worstD = 6;
    const wanted = [];
    for (let i = 0; i < this.layers.length; i++) {
      const c = this.colorsFor(i, atm);
      wanted.push(c);
      const s = this.layers[i].sig;
      if (!s || force) {
        this.tint(this.layers[i], i, c);
        continue;
      }
      const d = colorDistance(s.lit, c.lit) + colorDistance(s.shade, c.shade) + colorDistance(s.haze, c.haze) + Math.abs(s.fade - c.fade) * 100;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) this.tint(this.layers[worst], worst, wanted[worst]);
  }

  /**
   * Draws layer i in screen space.
   * @param L layout { w, h, horizonY, camX, baseScale, zoom, vshift }
   */
  drawLayer(ctx, i, L) {
    const layer = this.layers[i];
    const cfg = layer.cfg;
    const sc = 1 - (1 - L.zoom) * cfg.par * 1.6;
    const W = layer.W * sc;
    const top = L.horizonY + ((layer.stripTop * L.h) - L.horizonY) * sc + L.vshift * cfg.par * 3;
    const hgt = layer.stripH * L.h * sc;
    const off = wrap(L.camX * L.baseScale * cfg.par, W);
    for (let x = -off; x < L.w; x += W) ctx.drawImage(layer.canvas, x, top, W + 0.5, hgt);
    // solid continuation under the strip (in case the strip bottom is above the screen bottom)
    const below = top + hgt - 1;
    if (below < L.h) {
      ctx.fillStyle = rgba(mix(layer.sig.lit, layer.sig.haze, layer.sig.fade));
      ctx.fillRect(0, below, L.w, L.h - below);
    }
    return { base: L.horizonY + (cfg.base * L.h - L.horizonY) * sc + L.vshift * cfg.par * 3, top };
  }
}

/* ---------------- geometry generators (units: screen heights) ---------------- */

/**
 * Triangular alpine peaks (or lower rocky ridges when `low`).
 * The silhouette is the upper envelope of many jagged triangles (each flank a
 * short polyline with kinks), so peaks overlap naturally and valleys are
 * crisp Vs. Each visible peak gets a shadow face: the area right of a jagged
 * split line dropping from its apex, bounded by its own right flank.
 */
function alpine(r, cfg, W, low) {
  // Peak centres spread evenly with jitter; widths from cfg.spacing.
  const peaks = [];
  let x = 0;
  while (x < W) {
    const w = r.range(cfg.spacing[0], cfg.spacing[1]);
    const ax = x + r.range(0, w * 0.6);
    const ay = cfg.top + r.next() ** 1.25 * cfg.range;
    // flank steepness (dy per dx), slightly asymmetric
    const sl = r.range(0.62, 1.05) * (low ? 0.8 : 1);
    const sr = r.range(0.55, 0.95) * (low ? 0.8 : 1);
    const flank = (s) => {
      // kinks: [dx, slope] segments outward from the apex
      const segs = [];
      let d = 0;
      const n = 2 + r.int(0, 2);
      for (let i = 0; i < n; i++) {
        const len = r.range(0.03, 0.09) * (1 + i * 0.6);
        segs.push([d, s * r.range(0.7, 1.35)]);
        d += len;
      }
      segs.push([d, s * r.range(0.45, 0.8)]);
      return segs;
    };
    peaks.push({ ax, ay, L: flank(sl), R: flank(sr) });
    x += w * r.range(0.45, 0.8);
  }
  const yOf = (p, x) => {
    let dx = x - p.ax;
    const f = dx < 0 ? p.L : p.R;
    dx = Math.abs(dx);
    let y = p.ay;
    for (let i = 0; i < f.length; i++) {
      const end = i + 1 < f.length ? f[i + 1][0] : Infinity;
      const seg = Math.min(dx, end) - f[i][0];
      if (seg <= 0) break;
      y += seg * f[i][1];
    }
    return y;
  };
  const N = Math.round(W * 360);
  const env = new Float64Array(N + 1);
  const own = new Int32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const xx = (i / N) * W;
    let best = Infinity;
    let who = -1;
    for (let k = 0; k < peaks.length; k++) {
      for (const off of [-W, 0, W]) {
        const y = yOf(peaks[k], xx - off);
        if (y < best) {
          best = y;
          who = k + (off < 0 ? -1e6 : off > 0 ? 1e6 : 0);
        }
      }
    }
    env[i] = Math.min(best, cfg.base + 0.05);
    own[i] = who;
  }
  const outline = [];
  for (let i = 0; i <= N; i++) outline.push((i / N) * W, env[i]);

  const shadows = [];
  const caps = [];
  const baseY = cfg.base + 0.05;
  peaks.forEach((p, k) => {
    const ia = Math.round((((p.ax % W) + W) % W / W) * N);
    if (own[ia] !== k || Math.abs(env[ia] - p.ay) > 0.004) return; // apex hidden by a neighbour
    // walk right along the peak's own flank (allow wrap past the end of the strip)
    const right = [];
    let j = ia;
    let steps = 0;
    while (steps < N) {
      const jj = j % (N + 1);
      const o = own[jj];
      if (o !== k && o !== k - 1e6 && o !== k + 1e6) break;
      right.push(p.ax + (steps * W) / N, env[jj]);
      j++;
      steps++;
    }
    const vx = right.length ? right[right.length - 2] : p.ax;
    const vy = right.length ? right[right.length - 1] : p.ay;
    // split line: from apex down-right-ish, zig-zagging
    const reach = Math.max(0.02, (vx - p.ax) * r.range(0.12, 0.4));
    const split = [p.ax, p.ay];
    const n = 5 + r.int(0, 3);
    for (let s = 1; s < n; s++) {
      const u = s / n;
      const zig = (s % 2 ? 1 : -1) * r.range(0.002, 0.012);
      split.push(p.ax + reach * u ** 0.8 + zig, p.ay + (baseY - p.ay) * u);
    }
    const sEnd = p.ax + reach;
    split.push(sEnd, baseY);
    // occlusion line below the valley (continue down-left along the neighbour's flank)
    const ox = Math.max(sEnd, vx - (baseY - vy) * 0.9);
    const sh = [...split, ox, baseY, vx, vy];
    for (let q = right.length - 4; q >= 0; q -= 2) sh.push(right[q], right[q + 1]);
    shadows.push(sh);
    if (!low) {
      // faint highlight cap on the upper lit face
      const cu = r.range(0.06, 0.12);
      const lx = p.ax - cu / Math.max(0.3, p.L[0][1]);
      const ly = p.ay + cu;
      const cap = [p.ax, p.ay, lx, ly];
      const m = 4;
      for (let s = 1; s < m; s++) {
        const u = s / m;
        cap.push(lx + (p.ax + reach * 0.2 - lx) * u + r.range(-0.004, 0.004), ly + (s % 2 ? 0.01 : -0.006) - cu * 0.15 * u);
      }
      cap.push(p.ax + reach * 0.25, p.ay + cu * 0.9);
      caps.push(cap);
    }
  });

  const trees = [];
  if (cfg.pines) {
    for (let tx = 0; tx < W; tx += r.range(0.006, 0.02)) {
      if (r.next() > cfg.pines) {
        tx += r.range(0.02, 0.08);
        continue;
      }
      const y = env[Math.min(N, Math.round((tx / W) * N))];
      if (y < cfg.top + cfg.range * 0.5) continue;
      trees.push(pine(tx, y + 0.003, r.range(0.016, 0.03), r));
    }
  }
  return { outline, shadows, caps, trees };
}

/** Rolling hills (tileable sum of sines) densely covered with pines. */
function hills(r, cfg, W) {
  const waves = [
    [2, r.range(0, 6.28), 0.5],
    [5, r.range(0, 6.28), 0.3],
    [9, r.range(0, 6.28), 0.15],
    [17, r.range(0, 6.28), 0.06],
  ];
  const yAt = (x) => {
    let v = 0;
    for (const [f, ph, a] of waves) v += Math.sin((x / W) * Math.PI * 2 * f + ph) * a;
    return cfg.top + cfg.range * (0.5 + 0.5 * v);
  };
  const outline = [];
  const N = 180;
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * W;
    outline.push(x, yAt(x));
  }
  const trees = [];
  // forest density varies along the strip (also tileable)
  const dens = (x) => 0.5 + 0.5 * Math.sin((x / W) * Math.PI * 2 * 3 + 1.3);
  for (let x = 0; x < W; ) {
    const d = dens(x);
    if (r.next() < 0.25 + d * 0.75) {
      const hgt = r.range(0.022, 0.042) * (0.8 + d * 0.4);
      trees.push(pine(x, yAt(x) + 0.006, hgt, r));
    }
    x += r.range(0.004, 0.011) / (0.4 + d);
  }
  // hills also get a soft shadow on the lee side of each bump: none (kept flat on purpose)
  return { outline, shadows: [], caps: [], trees };
}

/** A small tiered pine silhouette polygon (screen-height units). */
function pine(x, y, h, r) {
  const w = h * r.range(0.26, 0.34);
  const tiers = 3;
  const pts = [x, y - h];
  const right = [];
  for (let t = 0; t < tiers; t++) {
    const u = (t + 1) / tiers;
    const yy = y - h + h * u * 0.92;
    const ww = w * (0.45 + 0.55 * u);
    right.push(x + ww, yy);
    if (t < tiers - 1) right.push(x + ww * 0.45, yy - h * 0.04);
  }
  pts.push(...right);
  pts.push(x + w * 0.12, y, x - w * 0.12, y);
  for (let j = right.length - 2; j >= 0; j -= 2) pts.push(2 * x - right[j], right[j + 1]);
  return pts;
}
