/**
 * Gameplay features, drawn in WORLD space (camera transform already applied):
 * rocks (angular facets + snow cap), ramps (marker flags at the lip),
 * grinds (bunting rope with fluttering flags / snowy chalet roof / ice ledge),
 * pickups (spinning coins with a glint, feather + magnet in glowing bubbles)
 * and campfires (flickering layered flames + warm glow).
 * Chasms are part of the terrain renderer.
 */
import { FeatureType, GrindKind, PickupKind } from '../contracts.js';
import { hash01 } from './DayCycle.js';
import { mix, rgba } from './color.js';

const TAU = Math.PI * 2;

export class FeatureRenderer {
  constructor() {
    this.rockShapes = Array.from({ length: 4 }, (_, v) => buildRock(v));
  }

  /** Features drawn before decor/riders (on the ground). */
  draw(ctx, f, P, course, consumed) {
    if (!Number.isFinite(f.x) || (f.x0 != null && !(Number.isFinite(f.x0) && Number.isFinite(f.x1)))) return;
    if (f.type === FeatureType.GRIND && !(Number.isFinite(f.y0) && Number.isFinite(f.y1))) return;
    switch (f.type) {
      case FeatureType.ROCK:
        if (!consumed.has(f.id)) this.rock(ctx, f, P, course);
        break;
      case FeatureType.LOG:
        if (!consumed.has(f.id)) log(ctx, f, P, course);
        break;
      case FeatureType.SNOWMAN:
        if (!consumed.has(f.id)) snowman(ctx, f, P, course);
        break;
      case FeatureType.SPIKES:
        if (!consumed.has(f.id)) spikes(ctx, f, P, course);
        break;
      case FeatureType.RAMP:
        ramp(ctx, f, P, course);
        break;
      case FeatureType.GRIND:
        if (f.kind === GrindKind.BUNTING) bunting(ctx, f, P, course);
        else if (f.kind === GrindKind.ROOF) roof(ctx, f, P, course);
        else ice(ctx, f, P, course);
        break;
      case FeatureType.CAMPFIRE:
        campfire(ctx, f, P, course, consumed.has(f.id));
        break;
      default:
        break;
    }
  }

  /** Pickups are drawn after the riders' ghosts so they stay readable. */
  drawPickup(ctx, f, P, consumed) {
    if (consumed.has(f.id) || !Number.isFinite(f.y) || !Number.isFinite(f.x)) return;
    if (f.kind === PickupKind.COIN) coin(ctx, f, P);
    else bubble(ctx, f, P);
  }

  rock(ctx, f, P, course) {
    const r = f.size || 20;
    const shape = this.rockShapes[((f.variant | 0) % 4 + 4) % 4];
    const y = course.heightAt(f.x);
    const ang = Math.atan(course.slopeAt(f.x));
    contactShadow(ctx, f.x, y, r * 1.5, P);
    ctx.save();
    ctx.translate(f.x, y + r * 0.28);
    ctx.rotate(ang * 0.6);
    ctx.scale(r, r);
    ctx.fillStyle = rgba(P.rockDark);
    ctx.fill(shape.body);
    ctx.fillStyle = rgba(P.rockLit);
    ctx.fill(shape.lit);
    ctx.fillStyle = rgba(P.snow);
    ctx.fill(shape.cap);
    ctx.restore();
  }
}

function buildRock(v) {
  const h = (i) => hash01(v * 31 + 5, i);
  // irregular angular boulder, wider than tall, base below 0 (buried)
  const n = 7;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i / (n - 1)) * Math.PI; // left → over the top → right
    const rad = 0.8 + 0.35 * h(i);
    pts.push([Math.cos(a) * rad * 1.25, Math.sin(a) * rad * (0.95 + 0.2 * h(i + 9))]);
  }
  const body = new Path2D();
  body.moveTo(-1.3, 0.6);
  for (const [x, y] of pts) body.lineTo(x, y);
  body.lineTo(1.3, 0.6);
  body.closePath();
  // lit facet: left/top portion split by a line from a top vertex down to the base
  const split = 3 + (v % 2);
  const lit = new Path2D();
  lit.moveTo(-1.3, 0.6);
  for (let i = 0; i <= split; i++) lit.lineTo(pts[i][0], pts[i][1]);
  lit.lineTo(pts[split][0] * 0.4 - 0.15, 0.1);
  lit.lineTo(-0.2, 0.6);
  lit.closePath();
  // snow cap over the top vertices
  const cap = new Path2D();
  const a = pts[1];
  const b = pts[5];
  cap.moveTo(a[0] - 0.05, a[1] - 0.02);
  for (let i = 2; i <= 4; i++) cap.lineTo(pts[i][0], pts[i][1] - 0.06);
  cap.lineTo(b[0] + 0.05, b[1] - 0.02);
  cap.lineTo(b[0] - 0.15, b[1] + 0.12);
  cap.lineTo(pts[4][0] * 0.6, pts[4][1] + 0.24);
  cap.lineTo(pts[3][0], pts[3][1] + 0.16);
  cap.lineTo(pts[2][0] * 0.7, pts[2][1] + 0.26);
  cap.lineTo(a[0] + 0.12, a[1] + 0.14);
  cap.closePath();
  return { body, lit, cap };
}

function ramp(ctx, f, P, course) {
  // two little marker flags just before the lip
  const lip = f.lipX ?? f.x1 ?? f.x;
  for (const [dx, col] of [
    [-8, 0],
    [-46, 1],
  ]) {
    const x = lip + dx;
    const gy = course.heightAt(x);
    ctx.fillStyle = rgba(P.sil);
    ctx.fillRect(x - 1, gy - 34, 2, 37);
    ctx.fillStyle = rgba(P.festive[col]);
    const w = Math.sin(P.t * 8 + dx) * 2;
    ctx.beginPath();
    ctx.moveTo(x + 1, gy - 34);
    ctx.lineTo(x + 15, gy - 29 + w);
    ctx.lineTo(x + 1, gy - 24);
    ctx.closePath();
    ctx.fill();
  }
}

function bunting(ctx, f, P, course) {
  const t = P.t;
  const x0 = f.x0;
  const x1 = f.x1;
  // poles
  ctx.fillStyle = rgba(P.sil);
  for (const [x, y] of [
    [x0, f.y0],
    [x1, f.y1],
  ]) {
    const g = course.heightAt(x);
    ctx.fillRect(x - 2.2, y - 10, 4.4, g - y + 14);
    ctx.beginPath();
    ctx.arc(x, y - 10, 3, 0, TAU);
    ctx.fill();
  }
  // rope
  ctx.strokeStyle = rgba(P.sil);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  const step = 10;
  for (let x = x0; x <= x1 + 0.1; x += step) {
    const y = course.grindY(f, Math.min(x, x1));
    if (x === x0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // flags hanging under the rope
  const spacing = 19;
  let i = 0;
  for (let x = x0 + 12; x < x1 - 8; x += spacing, i++) {
    const ya = course.grindY(f, x - 6);
    const yb = course.grindY(f, x + 6);
    const col = P.festive[(i + (f.variant | 0)) % P.festive.length];
    const fl = Math.sin(t * 6.5 + i * 0.9 + x0 * 0.01) * (2.5 + 2 * P.wind);
    ctx.fillStyle = rgba(col);
    ctx.beginPath();
    ctx.moveTo(x - 6, ya + 1);
    ctx.lineTo(x + 6, yb + 1);
    ctx.lineTo(x + fl, (ya + yb) / 2 + 15 + Math.cos(t * 5 + i) * 1.2);
    ctx.closePath();
    ctx.fill();
  }
}

function roof(ctx, f, P, course) {
  // a long chalet whose snowy roof line IS the grind line
  const x0 = f.x0;
  const x1 = f.x1;
  const y0 = f.y0;
  const y1 = f.y1;
  const thick = 12;
  const g0 = course.heightAt(x0 + 10);
  const g1 = course.heightAt(x1 - 10);
  ctx.fillStyle = rgba(P.sil);
  // walls
  ctx.beginPath();
  ctx.moveTo(x0 + 12, y0 + thick);
  ctx.lineTo(x1 - 12, y1 + thick);
  ctx.lineTo(x1 - 12, g1 + 8);
  ctx.lineTo(x0 + 12, g0 + 8);
  ctx.closePath();
  ctx.fill();
  // roof slab (slight overhang)
  ctx.beginPath();
  ctx.moveTo(x0 - 4, y0 + 1);
  ctx.lineTo(x1 + 4, y1 + 1);
  ctx.lineTo(x1 + 10, y1 + thick + 3);
  ctx.lineTo(x0 - 10, y0 + thick + 3);
  ctx.closePath();
  ctx.fill();
  // snow on top (the grindable surface)
  ctx.fillStyle = rgba(P.snow);
  ctx.beginPath();
  ctx.moveTo(x0 - 6, y0 - 4);
  ctx.lineTo(x1 + 6, y1 - 4);
  ctx.lineTo(x1 + 8, y1 + 2);
  ctx.lineTo(x1 - 20, y1 + 3);
  ctx.lineTo(x1 - 28, y1 + 7);
  ctx.lineTo(x1 - 36, y1 + 3);
  ctx.lineTo(x0 + 30, y0 + 3);
  ctx.lineTo(x0 + 22, y0 + 8);
  ctx.lineTo(x0 + 14, y0 + 3);
  ctx.lineTo(x0 - 8, y0 + 2);
  ctx.closePath();
  ctx.fill();
  // windows
  const lit = P.lights;
  const win = rgba(lit > 0.02 ? mix(mix(P.sil, P.haze, 0.25), P.accent, lit) : mix(P.sil, P.haze, 0.25));
  ctx.fillStyle = win;
  const n = Math.max(2, Math.floor((x1 - x0) / 70));
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const x = x0 + 12 + (x1 - x0 - 24) * u;
    const top = y0 + (y1 - y0) * ((x - x0) / (x1 - x0)) + thick + 14;
    ctx.fillRect(x - 6, top, 12, 14);
    if (lit > 0.02) P.glow(x, top + 7, 50, 0.45 * lit);
  }
}

/** True when an ice grind lies on the surface (an icy patch) rather than above it (a ledge). */
export function isGroundIce(f, course) {
  return f.kind === GrindKind.ICE && Math.abs(course.heightAt(f.x0) - f.y0) < 4 && Math.abs(course.heightAt(f.x1) - f.y1) < 4;
}

/** Glossy sheet of ice lying on the snow, following the surface. */
function iceSheet(ctx, f, P, course) {
  const x0 = f.x0;
  const x1 = f.x1;
  const iceCol = mix(P.snow, [130, 205, 238], 0.6);
  const deep = mix(iceCol, P.shade, 0.5);
  const step = 12;
  const g = ctx.createLinearGradient(0, course.heightAt(x0), 0, course.heightAt(x0) + 14);
  ctx.beginPath();
  ctx.moveTo(x0 - 6, course.heightAt(x0 - 6) + 2);
  for (let x = x0; x <= x1; x += step) ctx.lineTo(x, course.heightAt(x) - 1.2);
  ctx.lineTo(x1 + 6, course.heightAt(x1 + 6) + 2);
  for (let x = x1; x >= x0; x -= step) ctx.lineTo(x, course.heightAt(x) + 10 + 2 * Math.sin(x * 0.05));
  ctx.closePath();
  void g;
  ctx.fillStyle = rgba(iceCol, 0.95);
  ctx.fill();
  // darker underside band
  ctx.fillStyle = rgba(deep, 0.6);
  ctx.beginPath();
  for (let x = x0; x <= x1; x += step) ctx.lineTo(x, course.heightAt(x) + 6.5);
  for (let x = x1; x >= x0; x -= step) ctx.lineTo(x, course.heightAt(x) + 10 + 2 * Math.sin(x * 0.05));
  ctx.closePath();
  ctx.fill();
  // sheen streaks
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let x = x0 + 20, i = 0; x < x1 - 20; x += 46 + 20 * hash01(f.id, i), i++) {
    const y = course.heightAt(x);
    ctx.moveTo(x, y + 4);
    ctx.lineTo(x + 9, y + 0.5);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += step) ctx.lineTo(x, course.heightAt(x) - 1);
  ctx.stroke();
  const u = (P.t * 0.3 + f.id * 0.17) % 1.5;
  if (u < 1) {
    const gx = x0 + (x1 - x0) * u;
    sparkle(ctx, gx, course.heightAt(gx) - 1, 7, 0.9);
  }
}

function ice(ctx, f, P, course) {
  if (isGroundIce(f, course)) {
    iceSheet(ctx, f, P, course);
    return;
  }
  const x0 = f.x0;
  const x1 = f.x1;
  const iceCol = mix(P.snow, [150, 215, 240], 0.45);
  const deep = mix(iceCol, P.shade, 0.45);
  // pillars
  ctx.fillStyle = rgba(deep, 0.9);
  const n = 3;
  for (let i = 0; i < n; i++) {
    const x = x0 + 18 + ((x1 - x0 - 36) * i) / (n - 1);
    const y = course.grindY(f, x);
    const g = course.heightAt(x);
    ctx.beginPath();
    ctx.moveTo(x - 7, y + 6);
    ctx.lineTo(x + 7, y + 6);
    ctx.lineTo(x + 10, g + 6);
    ctx.lineTo(x - 10, g + 6);
    ctx.closePath();
    ctx.fill();
  }
  // slab
  ctx.fillStyle = rgba(iceCol, 0.95);
  ctx.beginPath();
  ctx.moveTo(x0 - 4, f.y0);
  ctx.lineTo(x1 + 4, f.y1);
  ctx.lineTo(x1 - 2, f.y1 + 9);
  ctx.lineTo(x0 + 2, f.y0 + 9);
  ctx.closePath();
  ctx.fill();
  // icicles
  ctx.fillStyle = rgba(iceCol, 0.85);
  ctx.beginPath();
  for (let x = x0 + 6, i = 0; x < x1 - 6; x += 9, i++) {
    const y = course.grindY(f, x) + 8;
    const len = 5 + hash01(f.id, i) * 12;
    ctx.moveTo(x - 3, y);
    ctx.lineTo(x, y + len);
    ctx.lineTo(x + 3, y);
  }
  ctx.fill();
  // glossy top highlight with a moving glint
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0 - 3, f.y0 + 0.5);
  ctx.lineTo(x1 + 3, f.y1 + 0.5);
  ctx.stroke();
  const u = (P.t * 0.35 + f.id * 0.17) % 1.6;
  if (u < 1) {
    const gx = x0 + (x1 - x0) * u;
    const gy = course.grindY(f, gx);
    sparkle(ctx, gx, gy + 2, 6, 0.8);
  }
}

function campfire(ctx, f, P, course, out) {
  const x = f.x;
  const y = course.heightAt(x);
  const r = f.size || 18;
  const t = P.t;
  // stones
  ctx.fillStyle = rgba(P.rockDark);
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.ellipse(x + i * r * 0.45, y + 1, r * 0.26, r * 0.18, 0, 0, TAU);
    ctx.fill();
  }
  // logs
  ctx.fillStyle = rgba(mix(P.sil, [90, 50, 30], 0.35));
  ctx.save();
  ctx.translate(x, y - 3);
  ctx.rotate(-0.35);
  ctx.fillRect(-r * 0.8, -2.5, r * 1.6, 5);
  ctx.rotate(0.7);
  ctx.fillRect(-r * 0.8, -2.5, r * 1.6, 5);
  ctx.restore();
  if (out) return;
  // glow
  const flick = 0.85 + 0.1 * Math.sin(t * 11 + x) + 0.05 * Math.sin(t * 23);
  P.glow(x, y - r * 0.6, r * (5 + 3 * P.lights), (0.45 + 0.55 * P.lights) * flick);
  // flames: three layered tongues
  const layers = [
    [[255, 120, 50], 1.0],
    [[255, 186, 70], 0.72],
    [[255, 240, 190], 0.42],
  ];
  for (const [col, k] of layers) {
    ctx.fillStyle = rgba(col);
    ctx.beginPath();
    const n = 3;
    for (let i = 0; i < n; i++) {
      const ox = (i - 1) * r * 0.32 * k;
      const hh = r * (1.5 + 0.5 * Math.sin(t * 9 + i * 2.1 + k * 3)) * k * (i === 1 ? 1.25 : 0.85);
      const sway = Math.sin(t * 7 + i + k) * r * 0.15;
      const w = r * 0.42 * k;
      ctx.moveTo(x + ox - w, y - 3);
      ctx.quadraticCurveTo(x + ox - w * 0.9, y - hh * 0.5, x + ox + sway, y - 3 - hh);
      ctx.quadraticCurveTo(x + ox + w * 0.9, y - hh * 0.5, x + ox + w, y - 3);
      ctx.closePath();
    }
    ctx.fill();
  }
}

function coin(ctx, f, P) {
  const t = P.t;
  const bob = Math.sin(t * 2.6 + f.x * 0.02) * 3;
  const spin = Math.cos(t * 3.2 + f.x * 0.013);
  const w = Math.max(0.18, Math.abs(spin));
  const r = 8;
  const x = f.x;
  const y = f.y + bob;
  // soft halo so coins read at night
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2.4);
  halo.addColorStop(0, `rgba(255,200,90,${0.18 + 0.3 * P.lights})`);
  halo.addColorStop(1, 'rgba(255,200,90,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#c98a1b';
  ctx.beginPath();
  ctx.ellipse(x, y, r * w, r, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = spin > 0 ? '#ffd75a' : '#f2b739';
  ctx.beginPath();
  ctx.ellipse(x - 0.8 * w, y, (r - 1.8) * w, r - 1.8, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,248,210,0.85)';
  ctx.beginPath();
  ctx.ellipse(x - 2 * w, y - 2, 1.6 * w, 3.2, 0, 0, TAU);
  ctx.fill();
  // glint: a quick star every ~2.4 s per coin
  const g = (t * 0.42 + hash01(f.id, 7)) % 1;
  if (g < 0.12) sparkle(ctx, x + 3 * w, y - 4, 9 * Math.sin((g / 0.12) * Math.PI), 1);
}

function bubble(ctx, f, P) {
  const t = P.t;
  const x = f.x;
  const y = f.y + Math.sin(t * 2 + f.x * 0.03) * 4;
  const pulse = 1 + 0.05 * Math.sin(t * 4 + f.id);
  const R = 17 * pulse;
  const feather = f.kind === PickupKind.FEATHER;
  const tint = feather ? [150, 235, 220] : [255, 150, 160];
  // glow
  const g = ctx.createRadialGradient(x, y, R * 0.3, x, y, R * 2.3);
  g.addColorStop(0, rgba(tint, 0.35));
  g.addColorStop(1, rgba(tint, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, R * 2.3, 0, TAU);
  ctx.fill();
  // bubble
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.beginPath();
  ctx.arc(x, y, R, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, R * 0.75, -2.6, -1.9);
  ctx.stroke();
  // icon
  ctx.save();
  ctx.translate(x, y);
  if (feather) {
    ctx.rotate(-0.6 + Math.sin(t * 2) * 0.1);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.quadraticCurveTo(7, -4, 3, 8);
    ctx.lineTo(0, 10);
    ctx.lineTo(-3, 8);
    ctx.quadraticCurveTo(-7, -4, 0, -11);
    ctx.fill();
    ctx.strokeStyle = rgba(mix(tint, [40, 90, 100], 0.6));
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(0, 13);
    for (let i = 0; i < 4; i++) {
      ctx.moveTo(0, -5 + i * 3.5);
      ctx.lineTo(4 - i * 0.4, -8 + i * 3.5);
      ctx.moveTo(0, -5 + i * 3.5);
      ctx.lineTo(-4 + i * 0.4, -8 + i * 3.5);
    }
    ctx.stroke();
  } else {
    // horseshoe magnet
    ctx.rotate(0.5);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#e8453c';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(0, 1, 6.5, 0, Math.PI);
    ctx.moveTo(6.5, 1);
    ctx.lineTo(6.5, -6);
    ctx.moveTo(-6.5, 1);
    ctx.lineTo(-6.5, -6);
    ctx.stroke();
    ctx.strokeStyle = '#f2f2f2';
    ctx.beginPath();
    ctx.moveTo(6.5, -5);
    ctx.lineTo(6.5, -10);
    ctx.moveTo(-6.5, -5);
    ctx.lineTo(-6.5, -10);
    ctx.stroke();
  }
  ctx.restore();
}

/** Four-point star (also used by particles). */
export function sparkle(ctx, x, y, r, a) {
  if (r <= 0.2) return;
  ctx.fillStyle = `rgba(255,255,255,${a})`;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
}

/* ---------------- solid obstacles: log / snowman / spikes ---------------- */

/** Soft elongated shadow where an obstacle meets the snow (reads on white snow in every palette). */
function contactShadow(ctx, x, y, halfW, P) {
  const g = ctx.createRadialGradient(x, y + 1, 0, x, y + 1, halfW);
  const c = P.shadeDeep;
  g.addColorStop(0, rgba(c, 0.38));
  g.addColorStop(1, rgba(c, 0));
  ctx.save();
  ctx.translate(x, y + 1);
  ctx.scale(1, 0.16);
  ctx.translate(-x, -(y + 1));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y + 1, halfW, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function log(ctx, f, P, course) {
  const w = f.w || 90;
  const h = f.h || 20;
  const y = course.heightAt(f.x);
  const ang = Math.atan2(course.heightAt(f.x + w / 2) - course.heightAt(f.x - w / 2), w);
  contactShadow(ctx, f.x, y, w * 0.62, P);
  const bark = P.bark;
  const barkDark = mix(bark, P.sil, 0.45);
  const barkLit = mix(bark, P.snow, 0.18);
  const wood = P.wood;
  const r = h / 2;
  ctx.save();
  ctx.translate(f.x, y + 2);
  ctx.rotate(ang);
  // trunk body
  ctx.fillStyle = rgba(bark);
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h, w, h, [r * 0.5, r * 0.3, r * 0.3, r * 0.5]);
  ctx.fill();
  // lower shadow facet + lit upper facet
  ctx.fillStyle = rgba(barkDark);
  ctx.fillRect(-w / 2 + 2, -h * 0.42, w - 4, h * 0.42);
  ctx.fillStyle = rgba(barkLit);
  ctx.fillRect(-w / 2 + 3, -h * 0.86, w - 8, h * 0.18);
  // bark grooves
  ctx.strokeStyle = rgba(barkDark, 0.8);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const gy = -h * (0.25 + i * 0.17);
    const x0 = -w / 2 + 6 + hash01(f.id, i) * 12;
    ctx.moveTo(x0, gy);
    ctx.lineTo(x0 + w * (0.35 + 0.3 * hash01(f.id, i + 9)), gy + (i % 2 ? 0.8 : -0.8));
  }
  ctx.stroke();
  // broken branch stubs
  ctx.fillStyle = rgba(bark);
  for (let i = 0; i < 2; i++) {
    const bx = -w * 0.25 + i * w * 0.42 + hash01(f.id, 20 + i) * 8;
    ctx.beginPath();
    ctx.moveTo(bx - 3, -h + 1);
    ctx.lineTo(bx + 4 + i * 2, -h - 7 - i * 3);
    ctx.lineTo(bx + 7 + i * 2, -h - 6 - i * 3);
    ctx.lineTo(bx + 4, -h + 1);
    ctx.closePath();
    ctx.fill();
  }
  // cut end (downhill side) with rings
  const ex = w / 2 - r * 0.25;
  ctx.fillStyle = rgba(wood);
  ctx.beginPath();
  ctx.ellipse(ex, -r, r * 0.42, r * 0.96, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(mix(wood, bark, 0.55));
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.ellipse(ex, -r, r * 0.27, r * 0.62, 0, 0, TAU);
  ctx.moveTo(ex + r * 0.12, -r);
  ctx.ellipse(ex, -r, r * 0.12, r * 0.3, 0, 0, TAU);
  ctx.stroke();
  // snow cap along the top
  ctx.fillStyle = rgba(P.snow);
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 2, -h + 1);
  ctx.quadraticCurveTo(-w / 2 + 4, -h - 4, -w / 2 + 12, -h - 3.5);
  ctx.lineTo(w / 2 - 14, -h - 3);
  ctx.quadraticCurveTo(w / 2 - 6, -h - 3, w / 2 - 5, -h + 1.5);
  for (let i = 8; i >= 0; i--) {
    const u = i / 8;
    ctx.lineTo(-w / 2 + 4 + (w - 10) * u, -h + 2 + (i % 2 ? 2.5 : 0.5));
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function snowman(ctx, f, P, course) {
  const h = f.h || 56;
  const y = course.heightAt(f.x);
  const r1 = h * 0.21;
  const r2 = h * 0.165;
  const r3 = h * 0.125;
  const x = f.x;
  contactShadow(ctx, x + 3, y, r1 * 1.9, P);
  const lit = mix(P.snow, [255, 255, 255], 0.35);
  const shade = mix(P.snow, P.shadeDeep, 0.55);
  const balls = [
    [x, y - r1 + 2, r1],
    [x + 0.5, y - 2 * r1 - r2 + 5, r2],
    [x + 1, y - 2 * r1 - 2 * r2 - r3 + 8, r3],
  ];
  for (const [bx, by, br] of balls) {
    const g = ctx.createLinearGradient(bx - br, by - br, bx + br, by + br);
    g.addColorStop(0, rgba(lit));
    g.addColorStop(0.55, rgba(mix(lit, shade, 0.35)));
    g.addColorStop(1, rgba(shade));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, TAU);
    ctx.fill();
  }
  const [hx, hy, hr] = balls[2];
  const [mx, my, mr] = balls[1];
  const dark = rgba(P.sil);
  // twig arms
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(mx - mr * 0.8, my - 2);
  ctx.lineTo(mx - mr * 2.1, my - mr * 0.9);
  ctx.moveTo(mx - mr * 1.6, my - mr * 0.6);
  ctx.lineTo(mx - mr * 1.9, my - mr * 1.3);
  ctx.moveTo(mx + mr * 0.8, my - 2);
  ctx.lineTo(mx + mr * 2.0, my - mr * 1.4 + Math.sin(P.t * 2 + f.id) * 1.2);
  ctx.moveTo(mx + mr * 1.5, my - mr * 1.0);
  ctx.lineTo(mx + mr * 1.9, my - mr * 0.6);
  ctx.stroke();
  // tiny scarf (festive colour) with a tail
  ctx.fillStyle = rgba(P.festive[(f.variant | 0) % 2 === 0 ? 0 : 3]);
  ctx.fillRect(hx - hr * 0.95, hy + hr * 0.62, hr * 1.95, hr * 0.42);
  ctx.beginPath();
  ctx.moveTo(hx - hr * 0.4, hy + hr * 0.9);
  ctx.lineTo(hx - hr * 0.95, hy + hr * 1.9 + Math.sin(P.t * 4 + f.id) * 1.5);
  ctx.lineTo(hx - hr * 0.4, hy + hr * 1.75);
  ctx.closePath();
  ctx.fill();
  // top hat
  ctx.fillStyle = dark;
  ctx.fillRect(hx - hr * 1.0, hy - hr * 0.95, hr * 2.0, hr * 0.28);
  ctx.fillRect(hx - hr * 0.62, hy - hr * 2.0, hr * 1.24, hr * 1.1);
  // face: eyes + carrot nose
  ctx.beginPath();
  ctx.arc(hx + hr * 0.15, hy - hr * 0.2, 1.1, 0, TAU);
  ctx.arc(hx + hr * 0.6, hy - hr * 0.2, 1.1, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(mix([240, 130, 40], P.sil, 0.15 + 0.3 * P.night));
  ctx.beginPath();
  ctx.moveTo(hx + hr * 0.45, hy + hr * 0.05);
  ctx.lineTo(hx + hr * 1.55, hy + hr * 0.2);
  ctx.lineTo(hx + hr * 0.45, hy + hr * 0.35);
  ctx.closePath();
  ctx.fill();
  // buttons
  ctx.fillStyle = dark;
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    ctx.arc(mx + 1.5, my - mr * 0.3 + i * mr * 0.55, 1.2, 0, TAU);
    ctx.fill();
  }
}

function spikes(ctx, f, P, course) {
  const w = f.w || 150;
  const h = f.h || 12;
  const x0 = f.x - w / 2;
  contactShadow(ctx, f.x, course.heightAt(f.x), w * 0.55, P);
  // saturated glacier blue so the row reads on white snow (day) and on blue snow (night)
  const ice = mix(mix(P.snow, [95, 180, 235], 0.62), [255, 255, 255], 0.1);
  const deep = mix(mix(ice, [30, 70, 120], 0.45), P.sil, 0.2 * P.night);
  const n = Math.max(4, Math.round(w / 11));
  const shards = [];
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const x = x0 + w * u + (hash01(f.id, i) - 0.5) * 5;
    const hh = h * (0.8 + 1.0 * hash01(f.id, i + 40)) * (0.8 + 0.5 * Math.sin(u * Math.PI));
    const bw = 5 + 5 * hash01(f.id, i + 80);
    const lean = (hash01(f.id, i + 120) - 0.5) * hh * 0.5;
    shards.push([x, course.heightAt(x) + 2, hh, bw, lean]);
  }
  // back row (darker) then front row (paler, translucent)
  for (const [pass, col, a] of [
    [0, deep, 0.95],
    [1, ice, 0.88],
  ]) {
    ctx.fillStyle = rgba(col, a);
    ctx.beginPath();
    for (let i = pass; i < shards.length; i += 2) {
      const [x, gy, hh, bw, lean] = shards[i];
      ctx.moveTo(x - bw / 2, gy);
      ctx.lineTo(x + lean, gy - hh);
      ctx.lineTo(x + bw / 2, gy);
      ctx.closePath();
    }
    ctx.fill();
  }
  // bright rims on the lit (left) edges
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [x, gy, hh, bw, lean] of shards) {
    ctx.moveTo(x - bw / 2 + 1, gy - 1);
    ctx.lineTo(x + lean, gy - hh);
  }
  ctx.stroke();
  // travelling glint
  const g = (P.t * 0.45 + f.id * 0.13) % 1.3;
  if (g < 1) {
    const k = Math.min(shards.length - 1, Math.floor(g * shards.length));
    const [x, gy, hh, , lean] = shards[k];
    sparkle(ctx, x + lean * 0.6, gy - hh * 0.7, 6, 0.95);
  }
}
