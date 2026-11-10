/**
 * Decor on (or just behind / in front of) the riding line.
 *
 * Drawn in WORLD space (the camera transform is applied by the caller).
 * Shapes that repeat a lot (pines) are cached as Path2D per variant in unit
 * size and only translated/scaled per instance. Colours come from the frame
 * palette `P` (see Renderer.palette) so every object sits in the atmosphere.
 * Warm light sources (windows, lanterns) queue a glow that the renderer adds
 * in one additive pass afterwards.
 */
import { hash01 } from './DayCycle.js';
import { mix, rgba } from './color.js';

const PINE_H = 135;
const PINE_VARIANTS = 6;

export const FESTIVE = [
  [232, 85, 61],
  [244, 211, 94],
  [46, 196, 182],
  [61, 155, 233],
  [239, 106, 168],
  [247, 243, 232],
];

export class DecorRenderer {
  constructor() {
    this.pines = Array.from({ length: PINE_VARIANTS }, (_, v) => buildPine(v));
  }

  /**
   * @param {CanvasRenderingContext2D} ctx  (world transform applied)
   * @param {Object} d   Decor
   * @param {Object} P   frame palette
   * @param {Object} course
   * @param {number} layer  -1 front, 0 line, 1 back (used for tint)
   */
  draw(ctx, d, P, course) {
    // The building under a roof grind is drawn by the grind itself (FeatureRenderer),
    // and bunting grinds draw their own poles: skip the matching decor.
    if (d.type === 'hut' && d.roofLift != null) return;
    if (!Number.isFinite(d.x)) return;
    if (d.type === 'pole' && isBuntingEnd(course, d.x)) return;
    const depth = d.depth || 0;
    const back = depth > 0 ? Math.min(depth, 1.5) : 0;
    const front = depth < 0 ? -depth : 0;
    const s = (d.scale || 1) * (1 - 0.22 * back) * (1 + 0.35 * front);
    const ground = course.heightAt(d.x);
    const y = ground + (back ? 6 + back * 10 : front ? 10 + front * 26 : 3);
    // colour: back objects fade towards the haze, front ones get darker
    const sil = back ? mix(P.sil, P.haze, 0.08 + back * 0.24) : front ? mix(P.sil, P.deep, 0.5 * front) : P.sil;
    const snow = back ? mix(P.snow, P.haze, 0.08 + back * 0.2) : front ? mix(P.snow, P.shade, 0.25 + front * 0.3) : P.snow;
    const C = { sil: rgba(sil), silArr: sil, snow: rgba(snow), snowArr: snow };
    // how far below the anchor the ground drops across a footprint (crests, steep sides): foundations reach that deep
    C.ext = (half) => Math.max(0, Math.max(course.heightAt(d.x - half), course.heightAt(d.x + half)) - (y - 3)) + 10;
    ctx.save();
    ctx.translate(d.x, y);
    switch (d.type) {
      case 'pine':
        this.pine(ctx, d, s, C, P);
        break;
      case 'deadTree':
        deadTree(ctx, d, s, C);
        break;
      case 'hut':
        hut(ctx, d, s, C, P, d.x);
        break;
      case 'windmill':
        windmill(ctx, d, s, C, P);
        break;
      case 'pole':
        pole(ctx, d, s, C, P);
        break;
      case 'banner':
        banner(ctx, d, s, C, P);
        break;
      case 'lantern':
        lantern(ctx, d, s, C, P, d.x, y);
        break;
      case 'ruin':
        ruin(ctx, d, s, C);
        break;
      case 'shrub':
        shrub(ctx, d, s, C);
        break;
      case 'startGate':
        gate(ctx, s, C, P, false, course, d.x);
        break;
      case 'finishArch':
        gate(ctx, s, C, P, true, course, d.x);
        break;
      default:
        break;
    }
    ctx.restore();
  }

  pine(ctx, d, s, C, P) {
    const v = ((d.variant | 0) % PINE_VARIANTS + PINE_VARIANTS) % PINE_VARIANTS;
    const shape = this.pines[v];
    const jitter = 0.85 + 0.3 * hash01(Math.round(d.x), 3);
    const flip = hash01(Math.round(d.x), 4) < 0.5 ? -1 : 1;
    // gentle sway at the tips only would need per-vertex work; a tiny whole-tree lean is enough
    const sway = Math.sin(P.t * 0.9 + d.x * 0.01) * 0.012 * (1 + P.wind);
    ctx.transform(1, 0, sway, 1, 0, 0);
    ctx.scale(s * PINE_H * jitter * flip, s * PINE_H);
    ctx.fillStyle = C.sil;
    ctx.fill(shape.body);
    if (shape.snow) {
      ctx.fillStyle = C.snow;
      ctx.fill(shape.snow);
    }
  }
}

function isBuntingEnd(course, x) {
  for (const f of course.featuresIn(x - 4, x + 4)) if (f.type === 'grind' && f.kind === 'bunting' && (Math.abs(f.x0 - x) < 4 || Math.abs(f.x1 - x) < 4)) return true;
  return false;
}

/* ---------------- pine geometry (unit height, base at 0, up = -1) ---------------- */

function buildPine(v) {
  const r = (i) => hash01(v * 97 + 11, i);
  const tiers = 4 + (v % 3);
  const width = 0.3 + 0.08 * r(1);
  const body = new Path2D();
  const snow = v >= 3 ? new Path2D() : null;
  const trunkW = 0.035;
  // trunk
  body.rect(-trunkW / 2, -0.09, trunkW, 0.1);
  // tiers from the bottom up; each a drooping triangle
  for (let t = 0; t < tiers; t++) {
    const u0 = t / tiers; // 0 bottom
    const yb = -0.06 - u0 * 0.82 + (r(10 + t) - 0.5) * 0.02;
    const top = -0.06 - (u0 + 1.7 / tiers) * 0.82 - (t === tiers - 1 ? 0.07 : 0);
    const w = width * (1 - u0 * 0.78) * (0.92 + 0.16 * r(20 + t));
    const droop = 0.03 + 0.02 * r(30 + t);
    const lean = (r(40 + t) - 0.5) * 0.03;
    body.moveTo(lean, Math.max(top, -1));
    body.lineTo(w * 0.55 + lean * 0.5, yb - (yb - top) * 0.42);
    body.lineTo(w * 0.42, yb - (yb - top) * 0.38);
    body.lineTo(w, yb + droop);
    body.lineTo(w * 0.3, yb - 0.005);
    body.lineTo(-w * 0.3, yb - 0.005);
    body.lineTo(-w, yb + droop * 0.8);
    body.lineTo(-w * 0.42, yb - (yb - top) * 0.36);
    body.lineTo(-w * 0.55 + lean * 0.5, yb - (yb - top) * 0.44);
    body.closePath();
    if (snow && t > 0) {
      // snow lying along the upper edge of both drooping wings of the tier
      const ny = yb - (yb - top) * 0.38;
      const tipY = yb + droop;
      for (const side of [-1, 1]) {
        const k = side < 0 ? 0.8 : 1;
        snow.moveTo(side * w * 0.42, ny - 0.004);
        snow.lineTo(side * w * 1.0, tipY * 1 - 0.002 * k);
        snow.lineTo(side * w * 0.86, tipY + 0.008);
        snow.lineTo(side * w * 0.66, yb - (yb - top) * 0.12 + 0.01);
        snow.lineTo(side * w * 0.5, ny + 0.022);
        snow.closePath();
      }
    }
  }
  return { body, snow };
}

/* ---------------- other decor (world units, origin = ground point) ---------------- */

function deadTree(ctx, d, s, C) {
  const h = 95 * s;
  ctx.strokeStyle = C.sil;
  ctx.fillStyle = C.sil;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-3.5 * s, 0);
  ctx.lineTo(-1.2 * s, -h);
  ctx.lineTo(1.2 * s, -h);
  ctx.lineTo(3.5 * s, 0);
  ctx.fill();
  const v = d.variant | 0;
  ctx.lineWidth = 2.2 * s;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const u = 0.35 + i * 0.1;
    const dir = (i + v) % 2 ? 1 : -1;
    const len = (30 - i * 3.5) * s * (0.8 + 0.4 * hash01(v, i));
    const by = -h * u;
    ctx.moveTo(0, by);
    ctx.quadraticCurveTo(dir * len * 0.5, by - len * 0.2, dir * len, by - len * 0.6);
    ctx.moveTo(dir * len * 0.55, by - len * 0.25);
    ctx.lineTo(dir * len * 0.7, by - len * 0.75);
  }
  ctx.stroke();
}

function hut(ctx, d, s, C, P, wx) {
  const v = (d.variant | 0) % 3;
  const w = (80 + v * 16) * s;
  const wall = (44 + v * 6) * s;
  const roofH = (34 + v * 6) * s;
  const over = 9 * s;
  ctx.fillStyle = C.sil;
  // walls, extended below the ground so a steep slope never shows the bottom
  const ext = C.ext(w * 0.5 + over);
  ctx.fillRect(-w / 2, -wall, w, wall + ext);
  // chimney
  ctx.fillRect(w * 0.18, -wall - roofH * 0.95, 9 * s, roofH * 0.7);
  // roof
  ctx.beginPath();
  ctx.moveTo(-w / 2 - over, -wall + 2 * s);
  ctx.lineTo(0, -wall - roofH);
  ctx.lineTo(w / 2 + over, -wall + 2 * s);
  ctx.closePath();
  ctx.fill();
  // snow on the roof
  ctx.fillStyle = C.snow;
  ctx.beginPath();
  ctx.moveTo(-w / 2 - over - 1, -wall + 1 * s);
  ctx.lineTo(0, -wall - roofH - 3 * s);
  ctx.lineTo(w / 2 + over + 1, -wall + 1 * s);
  ctx.lineTo(w / 2 + over - 3 * s, -wall + 5 * s);
  ctx.lineTo(w * 0.25, -wall - roofH * 0.45);
  ctx.lineTo(w * 0.05, -wall - roofH * 0.62);
  ctx.lineTo(-w * 0.2, -wall - roofH * 0.42);
  ctx.lineTo(-w / 2 - over + 3 * s, -wall + 5 * s);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(w * 0.18 - 1, -wall - roofH * 0.95 - 3 * s, 9 * s + 2, 4 * s);
  // windows: dark by day, warm at night
  const lit = P.lights;
  const win = lit > 0.02 ? rgba(mix(mix(C.silArr, P.haze, 0.25), P.accent, lit)) : rgba(mix(C.silArr, P.haze, 0.25));
  ctx.fillStyle = win;
  const ww = 11 * s;
  const wh = 13 * s;
  const n = v === 2 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const cx = -w / 2 + (w * (i + 1)) / (n + 1);
    if (i === 0 && v !== 1) {
      // door
      ctx.fillRect(cx - 7 * s, -24 * s, 14 * s, 24 * s);
      continue;
    }
    ctx.fillRect(cx - ww / 2, -wall * 0.7, ww, wh);
    if (lit > 0.02) P.glow(wx + cx, -wall * 0.7 + wh / 2, 46 * s, 0.5 * lit);
  }
  // chimney smoke (day and night), deterministic puffs
  const t = P.t;
  ctx.fillStyle = rgba(mix(P.haze, [255, 255, 255], 0.4), 1);
  for (let i = 0; i < 5; i++) {
    const u = ((t * 0.25 + i / 5 + hash01(wx | 0, 1)) % 1);
    ctx.globalAlpha = 0.28 * (1 - u) * (1 - P.lights * 0.6);
    ctx.beginPath();
    ctx.arc(w * 0.18 + 4.5 * s - u * 40 * s, -wall - roofH * 0.95 - u * 70 * s, (4 + u * 12) * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function windmill(ctx, d, s, C, P) {
  const h = 150 * s;
  ctx.fillStyle = C.sil;
  ctx.beginPath();
  const ext = C.ext(20 * s);
  ctx.moveTo(-20 * s, ext);
  ctx.lineTo(-9 * s, -h);
  ctx.lineTo(9 * s, -h);
  ctx.lineTo(20 * s, ext);
  ctx.closePath();
  ctx.fill();
  // cap
  ctx.beginPath();
  ctx.moveTo(-13 * s, -h + 2);
  ctx.quadraticCurveTo(0, -h - 22 * s, 13 * s, -h + 2);
  ctx.fill();
  ctx.fillStyle = C.snow;
  ctx.beginPath();
  ctx.moveTo(-11 * s, -h - 4 * s);
  ctx.quadraticCurveTo(0, -h - 22 * s, 11 * s, -h - 4 * s);
  ctx.quadraticCurveTo(0, -h - 12 * s, -11 * s, -h - 4 * s);
  ctx.fill();
  // door + window
  ctx.fillStyle = rgba(mix(mix(C.silArr, P.haze, 0.25), P.accent, P.lights));
  ctx.fillRect(-5 * s, -18 * s, 10 * s, 18 * s);
  ctx.fillRect(-3.5 * s, -h * 0.6, 7 * s, 9 * s);
  // blades
  const a = P.t * (0.55 + 0.4 * P.wind) + (d.variant | 0) * 0.7;
  ctx.save();
  ctx.translate(0, -h - 4 * s);
  ctx.rotate(a);
  ctx.fillStyle = C.sil;
  ctx.strokeStyle = C.sil;
  ctx.lineWidth = 2.5 * s;
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -88 * s);
    ctx.stroke();
    // lattice sail
    ctx.globalAlpha = 0.9;
    ctx.fillRect(1.5 * s, -86 * s, 15 * s, 62 * s);
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.arc(0, 0, 4.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function flagShape(ctx, x, y, len, hgt, t, phase, amp) {
  // a fluttering pennant: top edge from the pole, wavy tip
  const w1 = Math.sin(t * 7 + phase) * amp;
  const w2 = Math.sin(t * 7 + phase + 1.4) * amp;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + len * 0.5, y + w1, x + len, y + hgt * 0.5 + w2);
  ctx.quadraticCurveTo(x + len * 0.5, y + hgt + w1, x, y + hgt);
  ctx.closePath();
  ctx.fill();
}

function pole(ctx, d, s, C, P) {
  const h = 74 * s;
  ctx.fillStyle = C.sil;
  ctx.fillRect(-1.6 * s, -h, 3.2 * s, h + 4);
  ctx.fillStyle = rgba(P.festive[(d.variant | 0) % P.festive.length]);
  flagShape(ctx, 1.5 * s, -h, 22 * s, 13 * s, P.t, d.x * 0.1, 2.5 * s * (1 + P.wind));
}

function banner(ctx, d, s, C, P) {
  const h = 118 * s;
  ctx.fillStyle = C.sil;
  ctx.fillRect(-1.8 * s, -h, 3.6 * s, h + 4);
  ctx.fillRect(-1.8 * s, -h, 26 * s, 2.5 * s);
  // tall vertical cloth hanging from the arm, rippling
  const col = P.festive[(d.variant | 0) % P.festive.length];
  ctx.fillStyle = rgba(col);
  const t = P.t;
  ctx.beginPath();
  const top = -h + 2 * s;
  const len = 64 * s;
  const n = 6;
  ctx.moveTo(2 * s, top);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    ctx.lineTo(24 * s + Math.sin(t * 5 + u * 3 + d.x) * 3 * s * u * (1 + P.wind), top + len * u);
  }
  ctx.lineTo(13 * s, top + len + 9 * s);
  for (let i = n; i >= 0; i--) {
    const u = i / n;
    ctx.lineTo(2 * s + Math.sin(t * 5 + u * 3 + d.x) * 3 * s * u * (1 + P.wind), top + len * u);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = rgba(mix(col, [255, 255, 255], 0.5), 0.8);
  ctx.beginPath();
  ctx.arc(13 * s, top + len * 0.35, 5 * s, 0, Math.PI * 2);
  ctx.fill();
}

function lantern(ctx, d, s, C, P, wx, wy) {
  const h = 58 * s;
  ctx.fillStyle = C.sil;
  ctx.fillRect(-1.6 * s, -h, 3.2 * s, h + 4);
  ctx.fillRect(-1.6 * s, -h, 16 * s, 2.4 * s);
  ctx.fillRect(10 * s, -h, 1.4 * s, 6 * s);
  // lamp body
  const flick = 0.85 + 0.15 * Math.sin(P.t * 13 + wx) * Math.sin(P.t * 7.3 + wx * 0.3);
  const glowC = mix(mix(C.silArr, P.haze, 0.3), P.accent, Math.max(0.35, P.lights) * flick);
  ctx.fillStyle = C.sil;
  ctx.fillRect(6.5 * s, -h + 6 * s, 9 * s, 2 * s);
  ctx.fillStyle = rgba(glowC);
  ctx.fillRect(7.5 * s, -h + 8 * s, 7 * s, 10 * s);
  ctx.fillStyle = C.sil;
  ctx.fillRect(6.5 * s, -h + 18 * s, 9 * s, 2 * s);
  P.glow(wx + 11 * s, wy - h + 13 * s, 70 * s, (0.25 + 0.75 * P.lights) * flick * 0.85);
}

function ruin(ctx, d, s, C) {
  const v = (d.variant | 0) % 3;
  ctx.fillStyle = C.sil;
  // foundation under the whole footprint (hidden by the snow)
  ctx.fillRect(-44 * s, 0, 88 * s, C.ext(44 * s));
  if (v === 0) {
    // broken arch
    ctx.beginPath();
    ctx.moveTo(-40 * s, 4);
    ctx.lineTo(-40 * s, -70 * s);
    ctx.lineTo(-30 * s, -78 * s);
    ctx.lineTo(-18 * s, -80 * s);
    ctx.lineTo(-6 * s, -76 * s);
    ctx.lineTo(2 * s, -66 * s);
    ctx.lineTo(4 * s, -58 * s);
    ctx.lineTo(-8 * s, -55 * s);
    ctx.quadraticCurveTo(-20 * s, -66 * s, -26 * s, -48 * s);
    ctx.lineTo(-26 * s, 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(14 * s, -34 * s, 14 * s, 38 * s);
  } else if (v === 1) {
    // column stubs
    for (const [x, h] of [
      [-30, 62],
      [-8, 40],
      [14, 74],
      [34, 22],
    ]) {
      ctx.fillRect(x * s, -h * s, 13 * s, h * s + 4);
      ctx.fillRect((x - 2) * s, -h * s, 17 * s, 4 * s);
    }
  } else {
    // wall with a window hole
    ctx.beginPath();
    ctx.moveTo(-44 * s, 4);
    ctx.lineTo(-44 * s, -46 * s);
    ctx.lineTo(-30 * s, -58 * s);
    ctx.lineTo(-20 * s, -52 * s);
    ctx.lineTo(-6 * s, -66 * s);
    ctx.lineTo(10 * s, -60 * s);
    ctx.lineTo(24 * s, -38 * s);
    ctx.lineTo(40 * s, -30 * s);
    ctx.lineTo(44 * s, 4);
    ctx.closePath();
    ctx.moveTo(-14 * s, -24 * s);
    ctx.lineTo(-14 * s, -42 * s);
    ctx.quadraticCurveTo(-6 * s, -50 * s, 2 * s, -42 * s);
    ctx.lineTo(2 * s, -24 * s);
    ctx.closePath();
    ctx.fill('evenodd');
  }
  // snow dusting on tops
  ctx.fillStyle = C.snow;
  if (v === 0) {
    ctx.beginPath();
    ctx.moveTo(-41 * s, -70 * s);
    ctx.lineTo(-30 * s, -79 * s);
    ctx.lineTo(-18 * s, -81 * s);
    ctx.lineTo(-6 * s, -77 * s);
    ctx.lineTo(-8 * s, -73 * s);
    ctx.lineTo(-30 * s, -74 * s);
    ctx.closePath();
    ctx.fill();
  } else if (v === 1) {
    for (const [x, h] of [
      [-30, 62],
      [-8, 40],
      [14, 74],
      [34, 22],
    ])
      ctx.fillRect((x - 2) * s, (-h - 2.5) * s, 17 * s, 3 * s);
  } else {
    ctx.beginPath();
    ctx.moveTo(-45 * s, -46 * s);
    ctx.lineTo(-30 * s, -59 * s);
    ctx.lineTo(-20 * s, -53 * s);
    ctx.lineTo(-6 * s, -67 * s);
    ctx.lineTo(10 * s, -61 * s);
    ctx.lineTo(8 * s, -57 * s);
    ctx.lineTo(-6 * s, -62 * s);
    ctx.lineTo(-20 * s, -49 * s);
    ctx.lineTo(-30 * s, -55 * s);
    ctx.closePath();
    ctx.fill();
  }
}

function shrub(ctx, d, s, C) {
  ctx.fillStyle = C.sil;
  const v = d.variant | 0;
  ctx.beginPath();
  const n = 3 + (v % 2);
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 9 * s;
    const h = (14 + 10 * hash01(v * 9 + i, d.x | 0)) * s;
    ctx.moveTo(x - 9 * s, 4);
    ctx.lineTo(x - 2 * s, -h);
    ctx.lineTo(x + 1 * s, -h + 2 * s);
    ctx.lineTo(x + 9 * s, 4);
  }
  ctx.fill();
  ctx.fillStyle = C.snow;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 9 * s;
    const h = (14 + 10 * hash01(v * 9 + i, d.x | 0)) * s;
    ctx.moveTo(x - 2 * s, -h);
    ctx.lineTo(x - 5 * s, -h + 7 * s);
    ctx.lineTo(x + 1 * s, -h + 4 * s);
    ctx.closePath();
  }
  ctx.fill();
}

function gate(ctx, s, C, P, finish, course, wx) {
  const span = finish ? 150 : 110;
  const h = finish ? 150 : 100;
  const yL = 0;
  const yR = course.heightAt(wx + span) - course.heightAt(wx);
  ctx.fillStyle = C.sil;
  ctx.fillRect(-3 * s, yL - h * s, 6 * s, h * s + 6);
  ctx.fillRect(span - 3 * s, yR - h * s, 6 * s, h * s + 6);
  // banner between the posts (checkered)
  const top0 = yL - h * s + 6;
  const top1 = yR - h * s + 6;
  const bh = 22 * s;
  const cells = 12;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < cells; i++) {
      const u0 = i / cells;
      const u1 = (i + 1) / cells;
      const light = (i + row) % 2 === 0;
      ctx.fillStyle = light ? rgba(mix(P.snow, [255, 255, 255], 0.5)) : C.sil;
      const ya = top0 + (top1 - top0) * u0 + (bh / 2) * row;
      const yb = top0 + (top1 - top0) * u1 + (bh / 2) * row;
      ctx.beginPath();
      ctx.moveTo(u0 * span, ya);
      ctx.lineTo(u1 * span, yb);
      ctx.lineTo(u1 * span, yb + bh / 2);
      ctx.lineTo(u0 * span, ya + bh / 2);
      ctx.closePath();
      ctx.fill();
    }
  }
  // flags on top of the posts
  ctx.fillStyle = rgba(P.festive[0]);
  flagShape(ctx, 3 * s, yL - h * s - 20 * s, 22 * s, 13 * s, P.t, 0, 2 * s);
  ctx.fillStyle = rgba(P.festive[3]);
  flagShape(ctx, span + 3 * s, yR - h * s - 20 * s, 22 * s, 13 * s, P.t, 1, 2 * s);
  ctx.fillStyle = C.sil;
  ctx.fillRect(-1.5 * s, yL - h * s - 22 * s, 3 * s, 24 * s);
  ctx.fillRect(span - 1.5 * s, yR - h * s - 22 * s, 3 * s, 24 * s);
  // post caps of snow
  ctx.fillStyle = C.snow;
  ctx.fillRect(-4 * s, yL - h * s - 1, 8 * s, 3 * s);
  ctx.fillRect(span - 4 * s, yR - h * s - 1, 8 * s, 3 * s);
  if (finish) {
    // a festive garland sagging above the banner, flags fluttering
    const ya = yL - h * s - 12 * s;
    const yb = yR - h * s - 12 * s;
    ctx.strokeStyle = C.sil;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      const u = i / 16;
      const y = ya + (yb - ya) * u + Math.sin(u * Math.PI) * 18 * s;
      if (i === 0) ctx.moveTo(u * span, y);
      else ctx.lineTo(u * span, y);
    }
    ctx.stroke();
    for (let i = 1; i < 12; i++) {
      const u = i / 12;
      const y = ya + (yb - ya) * u + Math.sin(u * Math.PI) * 18 * s;
      const fl = Math.sin(P.t * 6 + i) * 2 * s;
      ctx.fillStyle = rgba(P.festive[i % P.festive.length]);
      ctx.beginPath();
      ctx.moveTo(u * span - 5 * s, y);
      ctx.lineTo(u * span + 5 * s, y);
      ctx.lineTo(u * span + fl, y + 12 * s);
      ctx.closePath();
      ctx.fill();
    }
  }
  // lanterns at the foot of each post, glowing at dusk / night
  const lit = Math.max(0.3, P.lights);
  for (const [x, y] of [
    [-10 * s, yL],
    [span + 10 * s, yR],
  ]) {
    ctx.fillStyle = C.sil;
    ctx.fillRect(x - 1.2 * s, y - 30 * s, 2.4 * s, 32 * s);
    ctx.fillStyle = rgba(mix(mix(C.silArr, P.haze, 0.3), P.accent, lit));
    ctx.fillRect(x - 4 * s, y - 38 * s, 8 * s, 9 * s);
    ctx.fillStyle = C.sil;
    ctx.fillRect(x - 5 * s, y - 40 * s, 10 * s, 2.2 * s);
    P.glow(wx + x, course.heightAt(wx) + y - 33 * s, 60 * s, 0.25 + 0.7 * P.lights);
  }
}
