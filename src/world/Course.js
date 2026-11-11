/**
 * Procedural downhill course: a pure function of (seed, settings).
 *
 * Pipeline
 *   1. Zones        biome sequence (slopes / forest / village / ridge), a few hundred metres each.
 *   2. Layout       "set pieces" (kicker, rock field, chasm, bunting chain, rooftops, ice, drop,
 *                   campfire) separated by breathing room; the gaps get minor elements
 *                   (coin trails, a single rock, power-ups). First 150 m are hazard free.
 *   3. Slope        slope (dy/dx) control points every 160 px from layered Perlin noise plus a
 *                   per-biome grade, joined with Catmull-Rom (so the slope itself is smooth),
 *                   then shaped by the set pieces (flattened lips, steep drops, short rises,
 *                   smoothed spans under grind lines) and by the start platform / run-out.
 *   4. Height       slope integrated into a height table every 8 px, kicker bumps added on top,
 *                   per-sample tangents by central differences. `heightAt` is a cubic Hermite
 *                   lookup in that table: O(1) and C1 continuous (no kinks). Chasms override
 *                   it with a pit floor far below the lips.
 *   5. Features     geometry-dependent objects (rocks, grind lines, coins...) placed on the
 *                   final surface, checked for fairness (no rock after a blind crest or on a
 *                   landing line), sorted by x and given stable ids.
 *   6. Decor        pines, huts, poles, windmills, lanterns, ruins..., never inside a chasm.
 *
 * Everything uses the seeded RNG from src/math, so every client builds the same course.
 */
import { COURSE_LENGTHS, DEFAULT_SETTINGS, FeatureType, GrindKind, PickupKind, PX_PER_M } from '../contracts.js';
import { createRandom } from '../math/random.js';
import { PerlinNoise1D } from '../math/perlin.js';
import { catmullRomScalar, hermite, hermiteDerivative } from '../math/splines.js';
import { clamp, lerp, smoothstep, lowerBound } from '../math/utils.js';
import { GRAVITY, JUMP_VY, rampPop, BODY_CENTER, terminalSpeed } from '../math/physics.js';

/** Course-generation tunables (px unless noted). */
export const COURSE = Object.freeze({
  SAMPLE_STEP: 8, // height table resolution
  CP_SPACING: 160, // slope control point spacing
  RUN_IN: 1500, // terrain before startX
  RUN_OUT: 3000, // terrain after finishX
  PLATFORM_HALF: 200, // flat-ish start platform half width
  PLATFORM_SLOPE: 0.03,
  FREE_START_M: 150, // no hazards in the first 150 m
  FINISH_CLEAR: 400, // no set piece in the last 400 px
  ZONE_MIN_M: 260,
  ZONE_MAX_M: 460,
  ZONE_BLEND: 800, // grade blend half-width across zone borders
  // Base grade (dy/dx) per biome; the relief below adds on top (its mean is slightly positive).
  GRADE: { slopes: 0.165, forest: 0.165, village: 0.14, ridge: 0.175 },
  // Rolling relief: slope deviation amplitude per biome. Two noise layers, hump spacing
  // ≈ 1500 px and ≈ 560 px, give rounded humps, scooped valleys and shelves (50-250 px of
  // height relief per 2500 px window).
  RELIEF_AMP: { slopes: 0.34, forest: 0.38, village: 0.2, ridge: 0.5 },
  RELIEF_WAVE: [1500, 560], // px per noise lattice unit (long, short layer)
  RELIEF_MIX: 0.48, // weight of the short layer
  RELIEF_STEEP: 1.25, // >1 stretches the steep side (short pitches), <1 side stays gentle (long shelves)
  GRADE_RAMP: 0.02, // extra grade by the end of the course (difficulty ramp)
  LONG_AMP: 0.05, // very long-wavelength grade variation
  ROLLER_CHANCE: { slopes: 0.55, forest: 0.5, village: 0.25, ridge: 0.7 }, // per gap between set pieces
  RELIEF_LO: -0.105, // soft lower bound of the slope (≈ −6°: short gentle uphills)
  RELIEF_HI: 0.58, // soft upper bound (≈ 30° steep pitches; drop pieces go beyond)
  SLOPE_MIN: -0.12,
  SLOPE_MAX: 0.75,
  GAP_MIN_M: 60, // breathing room between set pieces (scaled down to 75% at the end)
  GAP_MAX_M: 125,
  // Pits: guaranteed count per length (first one within the first ~30%), three width classes.
  PITS: { sprint: 3, classic: 5, marathon: 8 },
  // Pits [width px] and their launch ramps [height px]. Every pit has a scooped ramp on its near
  // lip whose run-up length follows from the lip angle above the approach: L = 2h / tan(angle).
  PIT_NARROW: [80, 120], // crevasse: any jump clears it
  PIT_MEDIUM: [220, 270], // riding off the ramp at cruise is not enough: jump
  PIT_WIDE: [300, 345], // gorge: jump from the ramp (or boost speed); + up to 25 px with difficulty
  RAMP_H_NARROW: [25, 35],
  RAMP_H_MEDIUM: [45, 60],
  RAMP_H_WIDE: [72, 88],
  RAMP_LIP_DEG: [14, 24], // lip angle above the approach slope
  KICKER_H: [45, 65], // standalone ramps on open slopes
  LANDING_SLOPE: [0.45, 0.55], // downslope after a pit / kicker that receives the jump arc (≈ 24-29°)
  LANDING_LEN: 500, // px of steep landing hill…
  GORGE_LANDING_SLOPE: [0.72, 0.82], // wide gorges: steep landing hill (≈ 36-39°) — big air, doubles at speed
  GORGE_LANDING_LEN: 650,
  RUNOUT_SLOPE: 0.1, // …then a gentle run-out that bleeds the landing speed off
  RUNOUT_LEN: 700,
  CLEAR_AFTER_AIR: 1500,
  FINALE_FRAC: 0.08, // the last ~8% of the course is a set-piece finale…
  FINALE_MIN: 4600, // …but at least this long (px) // px after a big-air landing zone with no obstacle / set piece
  INRUN_SLOPE: [0.28, 0.34], // approach under a ramp: descends about as fast as the scoop rises
  PIT_DOUBLE_PAD: [2300, 2500], // room for a boosted landing + 1.2 s at speed, then the second ramp
  PIT_DEPTH: 560, // pit floor below the lower lip
  ROCK_R: [14, 30],
  // Obstacle kinds per biome (weights) and box sizes (px). Boxes are {x (centre), w, h}.
  OBSTACLE_MIX: {
    slopes: { rock: 0.55, log: 0.15, snowman: 0.1, spikes: 0.2 },
    forest: { log: 0.55, rock: 0.3, snowman: 0.15 },
    village: { snowman: 0.45, campfire: 0.2, rock: 0.15, log: 0.2 },
    ridge: { spikes: 0.45, rock: 0.4, log: 0.15 },
  },
  LOG_W: [70, 110],
  LOG_H: [18, 24],
  SNOWMAN_W: [24, 28],
  SNOWMAN_H: [34, 42], // a plain, reasonably timed tap clears it (hop apex ≈ 90 px); still taller than wide
  SPIKES_W: [95, 130], // a plain tap must clear them at 15 m/s with a ≥ 0.18 s timing window
  SPIKES_H: 12,
  CREST_CLEAR: 700, // no rock within this distance after a natural launch point
  LAUNCH_SPEED: 470, // speed used to find natural launch points (crests)
  COIN_SPACING_T: 0.075, // s between coins on an arc
});

const BIOMES = ['slopes', 'forest', 'village', 'ridge'];

/** Set-piece weights per biome. */
const PIECE_WEIGHTS = {
  slopes: { kicker: 5, obstacles: 2.5, bunting: 3, chasm: 0.8, drop: 1.5, ice: 1 },
  forest: { obstacles: 3, kicker: 3.5, bunting: 3.5, drop: 1, campfire: 0.8, chasm: 0.6 },
  village: { roofs: 3, bunting: 3.5, kicker: 2, campfire: 1, ice: 1 },
  ridge: { chasm: 2, drop: 2, obstacles: 2.5, kicker: 3, bunting: 1.5 },
};

/**
 * @param {number} seed
 * @param {import('../contracts.js').RaceSettings} settings
 * @returns {import('../contracts.js').Course}
 */
export function generateCourse(seed, settings) {
  const set = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  seed = seed >>> 0;
  const rngZones = createRandom(seed ^ 0x2f6b1c3d);
  const rngLayout = createRandom(seed ^ 0x51ed270b);
  const rngFeat = createRandom(seed ^ 0x7a3c9e55);
  const rngDecor = createRandom(seed ^ 0x1b873593);
  const noiseRoll = new PerlinNoise1D(seed ^ 0x68e31da4);
  const noiseLong = new PerlinNoise1D(seed ^ 0x3c6ef372);
  const noiseShort = new PerlinNoise1D(seed ^ 0x4cf5ad43);

  const lengthM = COURSE_LENGTHS[set.length] || COURSE_LENGTHS.classic;
  const step = COURSE.SAMPLE_STEP;
  const startX = 0;
  const finishX = lengthM * PX_PER_M;
  const minX = startX - COURSE.RUN_IN;
  const maxX = finishX + COURSE.RUN_OUT;
  const length = finishX - startX;
  const progressOf = (x) => clamp((x - startX) / length, 0, 1);

  /* ---------------- 1. zones ---------------- */
  const zones = [];
  {
    let x = minX;
    let biome = 'slopes';
    let first = true;
    while (x < maxX) {
      const lenPx = rngZones.range(COURSE.ZONE_MIN_M, COURSE.ZONE_MAX_M) * PX_PER_M;
      let x1 = (first ? startX : x) + lenPx;
      if (maxX - x1 < COURSE.ZONE_MIN_M * PX_PER_M * 0.6) x1 = maxX;
      zones.push({ x0: x, x1: Math.min(x1, maxX), biome });
      x = x1;
      first = false;
      const options = BIOMES.filter((b) => b !== biome);
      biome = options[rngZones.int(0, options.length - 1)];
    }
  }
  const zoneIndexAt = (x) => {
    const i = lowerBound(zones, x, (z) => z.x1);
    return clamp(i, 0, zones.length - 1);
  };
  const biomeAt = (x) => zones[zoneIndexAt(x)].biome;
  /** Per-biome quantity blended smoothly across zone borders. */
  const zoneValue = (x, table) => {
    const i = zoneIndexAt(x);
    const z = zones[i];
    let v = table[z.biome];
    const b = COURSE.ZONE_BLEND;
    if (i > 0 && x < z.x0 + b) {
      const w = smoothstep(z.x0 - b, z.x0 + b, x);
      v = lerp(table[zones[i - 1].biome], v, w);
    } else if (i < zones.length - 1 && x > z.x1 - b) {
      const w = smoothstep(z.x1 - b, z.x1 + b, x);
      v = lerp(v, table[zones[i + 1].biome], w);
    }
    return v;
  };

  /* ---------------- 2. layout (set pieces) ---------------- */
  const finaleStart = finishX - Math.max(COURSE.FINALE_FRAC * length, COURSE.FINALE_MIN);
  const pieces = [];
  const minorSlots = []; // gaps: {x0, x1, d}
  {
    // The hazard-free intro gets one kicker: an early, readable first flip.
    const intro = planPiece(rngLayout, 'kicker', startX + 800, 0);
    pieces.push(intro);
    let x = Math.max(startX + COURSE.FREE_START_M * PX_PER_M, intro.x1 + COURSE.CLEAR_AFTER_AIR);
    minorSlots.push({ x0: intro.x1, x1: x - 200, d: 0, safe: true });
    let prevType = 'kicker';
    // Pit schedule (progress fractions): first within the first ~30%, the rest spread out.
    const pitCount = COURSE.PITS[set.length] || COURSE.PITS.classic;
    const firstPit = rngLayout.range(0.08, 0.2);
    const pitAt = [];
    for (let k = 0; k < pitCount; k++) pitAt.push(firstPit + (k * (0.9 - firstPit)) / Math.max(1, pitCount - 1) + (k ? rngLayout.range(-0.03, 0.03) : 0));
    while (true) {
      const biome = biomeAt(x);
      const d = progressOf(x);
      let type = pickPiece(rngLayout, biome, prevType, d);
      if (pitAt.length && d >= pitAt[0]) {
        type = 'chasm';
        while (pitAt.length && d >= pitAt[0]) pitAt.shift();
      }
      const piece = planPiece(rngLayout, type, x, d);
      if (piece.x1 > finaleStart - (piece.bigAir ? COURSE.CLEAR_AFTER_AIR : 600)) break; // the finale starts on time
      pieces.push(piece);
      prevType = piece.type;
      let gap = rngLayout.range(COURSE.GAP_MIN_M, COURSE.GAP_MAX_M) * PX_PER_M * lerp(1, 0.75, d);
      if (piece.bigAir) gap = Math.max(gap, COURSE.CLEAR_AFTER_AIR + 300);
      const slot = { x0: piece.x1, x1: piece.x1 + gap, d: progressOf(piece.x1), clearTo: piece.bigAir ? piece.x1 + COURSE.CLEAR_AFTER_AIR : -Infinity };
      // A roller near the end of the gap: a near-flat shelf that breaks over a rounded
      // crest into a short steep pitch — the rider floats off the crest at cruise speed.
      // Rollers launch real air at speed: the crest sits early in the gap and the rest of the gap
      // (≥ CLEAR_AFTER_AIR past the pitch) stays free, so the landing never meets a hazard.
      const hb = biomeAt(slot.x0 + 900);
      const rollStart = Math.max(slot.x0, slot.clearTo) + 600;
      if (gap > 1600 && rngLayout.chance(COURSE.ROLLER_CHANCE[hb])) {
        const shelf = rngLayout.range(220, 380);
        const pitch = rngLayout.range(200, 320);
        const steep = rngLayout.range(0.42, 0.52) + (hb === 'ridge' ? 0.06 : 0);
        const crest = rollStart + shelf + rngLayout.range(0, 200);
        if (crest + pitch + COURSE.CLEAR_AFTER_AIR <= slot.x1) {
          slot.rollShelf = shelf;
          slot.rollPitch = pitch;
          slot.rollSteep = steep;
          slot.rollX = crest;
          slot.clearTo = crest + pitch + COURSE.CLEAR_AFTER_AIR;
        }
      }
      minorSlots.push(slot);
      x = piece.x1 + gap;
    }
    // No regular content inside the finale zone.
    for (const sl of minorSlots) {
      sl.x1 = Math.min(sl.x1, finaleStart - 200);
      if (sl.rollX && sl.rollX + sl.rollPitch + COURSE.CLEAR_AFTER_AIR > sl.x1) sl.rollX = 0;
    }
    // Finale set piece (seeded): A = bunting run-in → big kicker → landing hill;
    // B = ramped pit → bunting chain. Nothing in the last FINISH_CLEAR px before the line.
    const last = pieces[pieces.length - 1];
    let fx = Math.max(finaleStart, last ? last.x1 + (last.bigAir ? COURSE.CLEAR_AFTER_AIR : 600) : finaleStart);
    const variant = rngLayout.int(0, 1);
    const finale = [];
    const limit = finishX - COURSE.FINISH_CLEAR;
    const twoLines = (b) => {
      // the finale run-in / chain is two lines
      b.spans = b.spans.slice(0, 2);
      b.x1 = b.x0 + 120 + b.spans.reduce((t, [sp, g]) => t + sp + g, 0) + 450;
      b.noHazards = true;
      return b;
    };
    if (variant === 0) {
      const a = twoLines(planPiece(rngLayout, 'bunting', fx, 1));
      const k = planPiece(rngLayout, 'kicker', a.x1 + 200, 1);
      k.rampH = rngLayout.range(68, 78);
      k.rampLen = (2 * k.rampH) / Math.tan(k.lipAngle);
      k.lipX = k.x0 + 250 + k.rampLen;
      k.x1 = k.lipX + 1.6 * k.rampH + COURSE.LANDING_LEN + COURSE.RUNOUT_LEN;
      finale.push(a, k);
    } else {
      let c = planPiece(rngLayout, 'chasm', fx, 1);
      for (let t = 0; t < 8 && c.pitClass !== 'medium'; t++) c = planPiece(rngLayout, 'chasm', fx, 1);
      c.pits = [c.pits[0]];
      c.x1 = c.pits[0][1] + c.landLen + COURSE.RUNOUT_LEN;
      const b = twoLines(planPiece(rngLayout, 'bunting', c.x1 + 200, 1));
      finale.push(c, b);
    }
    for (const fp of finale) {
      if (fp.x1 > limit) break;
      fp.finale = true;
      pieces.push(fp);
    }
  }

  /* ---------------- 3. slope profile ---------------- */
  const n = Math.ceil((maxX - minX) / step) + 1;
  const sx = (i) => minX + i * step;
  const slope = new Float64Array(n);
  {
    const cpCount = Math.ceil((maxX - minX) / COURSE.CP_SPACING) + 4;
    const cp = new Float64Array(cpCount);
    for (let j = 0; j < cpCount; j++) {
      const x = minX + (j - 1) * COURSE.CP_SPACING;
      const grade = zoneValue(x, COURSE.GRADE) + COURSE.GRADE_RAMP * progressOf(x);
      const [w0, w1] = COURSE.RELIEF_WAVE;
      // Perlin 1D rarely leaves ±0.3: scale so the typical range is ≈ ±1.
      let r = 3 * ((1 - COURSE.RELIEF_MIX) * noiseRoll.noise(x / w0) + COURSE.RELIEF_MIX * noiseShort.noise(x / w1 + 17.3));
      r = r > 0 ? r * COURSE.RELIEF_STEEP : r * (2 - COURSE.RELIEF_STEEP);
      const relief = r * zoneValue(x, COURSE.RELIEF_AMP);
      const long = noiseLong.fbm(x / 3400, 2, 0.5) * COURSE.LONG_AMP;
      cp[j] = softClamp(grade + relief + long, COURSE.RELIEF_LO, COURSE.RELIEF_HI, 0.04);
    }
    for (let i = 0; i < n; i++) {
      const u = (sx(i) - minX) / COURSE.CP_SPACING + 1;
      const j = Math.floor(u);
      slope[i] = catmullRomScalar(cp[j - 1], cp[j], cp[j + 1], cp[j + 2], u - j);
    }
  }
  const idx = (x) => clamp(Math.round((x - minX) / step), 0, n - 1);
  const meanSlope = (a, b) => {
    let s = 0;
    let c = 0;
    for (let i = idx(a); i <= idx(b); i++) {
      s += slope[i];
      c++;
    }
    return s / Math.max(1, c);
  };
  /** Blends the slope toward `target(x)` with a smooth window over [a, b] (feathered by f). */
  const shapeSlope = (a, b, f, target) => {
    for (let i = idx(a - f); i <= idx(b + f); i++) {
      const x = sx(i);
      const w = smoothstep(a - f, a, x) * (1 - smoothstep(b, b + f, x));
      if (w > 0) slope[i] = lerp(slope[i], target(x, slope[i]), w);
    }
  };
  /** Pulls the slope over [a, b] toward its (clamped) mean; `strength` < 1 keeps some of the roll. */
  const flatten = (a, b, f = 160, lo = 0.12, hi = 0.3, strength = 1) => {
    const c = clamp(meanSlope(a, b), lo, hi);
    shapeSlope(a, b, f, (x, v) => lerp(v, c, strength));
  };

  for (const p of pieces) applyPieceSlope(p);
  for (const sl of minorSlots) {
    if (!sl.rollX) continue;
    const { rollX: cx, rollShelf, rollPitch, rollSteep } = sl;
    shapeSlope(cx - rollShelf, cx + rollPitch, 140, (x) => lerp(0.03, rollSteep, smoothstep(cx - 30, cx + 30, x)));
  }

  function applyPieceSlope(p) {
    switch (p.type) {
      case 'kicker': {
        // Smooth run-up, then a landing hill that falls away under the jump arc.
        flatten(p.lipX - p.rampLen - 250, p.lipX, 160, COURSE.INRUN_SLOPE[0], COURSE.INRUN_SLOPE[1]);
        const ls = p.landSlope;
        const l0 = p.lipX + 1.6 * p.rampH;
        shapeSlope(l0, l0 + COURSE.LANDING_LEN, 170, () => ls);
        shapeSlope(l0 + COURSE.LANDING_LEN + 150, l0 + COURSE.LANDING_LEN + COURSE.RUNOUT_LEN, 450, () => COURSE.RUNOUT_SLOPE); // long feather: the run-out must not end in a launch crest
        break;
      }
      case 'chasm': {
        // Smooth approach into the first ramp, then a downslope landing zone after every pit.
        // Steep in-run into the ramp (it descends about as fast as the scoop rises, so the rider
        // reaches the lip at speed), then a downslope landing zone after every pit.
        flatten(p.cx0 - p.rampLen - 320, p.cx0, 160, COURSE.INRUN_SLOPE[0], COURSE.INRUN_SLOPE[1]);
        if (p.pits.length > 1) flatten(p.pits[1][0] - p.pits[1][2] - 200, p.pits[1][0], 140, COURSE.INRUN_SLOPE[0], COURSE.INRUN_SLOPE[1]);
        for (const [, px1] of p.pits) {
          const ls = p.landSlope;
          shapeSlope(px1 - 10, px1 + p.landLen, 170, () => ls);
          shapeSlope(px1 + p.landLen + 150, px1 + p.landLen + COURSE.RUNOUT_LEN, 450, () => COURSE.RUNOUT_SLOPE); // long feather: the run-out must not end in a launch crest
        }
        break;
      }
      case 'bunting':
      case 'roofs':
      case 'ice':
        flatten(p.x0, p.x1, 180, 0.08, 0.26, p.type === 'ice' ? 0.7 : 0.85);
        break;
      case 'campfire':
        flatten(p.x0, p.x1, 150, 0.08, 0.2, 0.85);
        break;
      case 'obstacles':
        // Obstacles sit on the rolling terrain (the crest rule keeps them fair); only soften extremes.
        flatten(p.x0, p.x1, 200, 0.1, 0.32, 0.35);
        break;
      case 'drop': {
        const { dropX, lipLen, dropLen, steep } = p;
        shapeSlope(dropX - lipLen, dropX + dropLen, 160, (x) => lerp(0.05, steep, smoothstep(dropX - 28, dropX + 28, x)));
        if (p.rise) {
          const rx = dropX + dropLen + 520;
          for (let i = idx(rx - 120); i <= idx(rx + 120); i++) {
            const u = (sx(i) - rx) / 120;
            slope[i] -= 0.27 * 0.5 * (1 + Math.cos(Math.PI * u));
          }
        }
        break;
      }
    }
  }

  // Start platform and run-in.
  for (let i = 0; i < n; i++) {
    const x = sx(i);
    if (x > startX + 800) break;
    const target = lerp(0.2, COURSE.PLATFORM_SLOPE, smoothstep(startX - 750, startX - COURSE.PLATFORM_HALF, x));
    const w = 1 - smoothstep(startX + COURSE.PLATFORM_HALF, startX + 800, x);
    slope[i] = lerp(slope[i], target, w);
  }
  // Run-out: flattens, then rises very slightly so finished riders coast to a stop.
  for (let i = idx(finishX + 150); i < n; i++) {
    const x = sx(i);
    const target = lerp(0, -0.04, smoothstep(finishX + 1600, maxX, x));
    slope[i] = lerp(slope[i], target, smoothstep(finishX + 150, finishX + 1300, x));
  }
  for (let i = 0; i < n; i++) slope[i] = clamp(slope[i], COURSE.SLOPE_MIN, COURSE.SLOPE_MAX);

  /* ---------------- 4. heights ---------------- */
  const h = new Float64Array(n);
  for (let i = 1; i < n; i++) h[i] = h[i - 1] + 0.5 * (slope[i - 1] + slope[i]) * step;
  {
    const off = h[idx(startX)];
    for (let i = 0; i < n; i++) h[i] -= off;
  }
  // Kicker bumps (y up = negative offset). Quadratic face, C1 Hermite fall-off behind the lip.
  for (const p of pieces) {
    if (p.type === 'kicker') addKicker(p.lipX, p.rampLen, p.rampH, 1.6 * p.rampH);
    if (p.type === 'chasm') for (const [px0, px1, rl, rh] of p.pits) addKicker(px0, rl, rh, Math.min(1.6 * rh, (px1 - px0) * 0.4));
  }
  function addKicker(lipX, rampLen, rampH, fallLen) {
    const a = lipX - rampLen;
    const lipSlope = (2 * rampH) / rampLen;
    for (let i = idx(a) - 1; i <= idx(lipX + fallLen) + 1; i++) {
      const x = sx(i);
      let o = 0;
      if (x > a && x <= lipX) {
        const u = (x - a) / rampLen;
        o = rampH * u * u;
      } else if (x > lipX && x < lipX + fallLen) {
        o = hermite(rampH, lipSlope * fallLen, 0, 0, (x - lipX) / fallLen);
      }
      h[i] -= o;
    }
  }
  const m = new Float64Array(n); // dy/dx per sample
  for (let i = 0; i < n; i++) {
    const a = h[Math.max(0, i - 1)];
    const b = h[Math.min(n - 1, i + 1)];
    m[i] = (b - a) / ((Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * step);
  }

  function baseHeightAt(x) {
    let u = (x - minX) / step;
    if (u <= 0) return h[0] + m[0] * (x - minX);
    if (u >= n - 1) return h[n - 1] + m[n - 1] * (x - (minX + (n - 1) * step));
    const i = Math.floor(u);
    const t = u - i;
    return hermite(h[i], m[i] * step, h[i + 1], m[i + 1] * step, t);
  }
  function baseSlopeAt(x) {
    let u = (x - minX) / step;
    if (u <= 0) return m[0];
    if (u >= n - 1) return m[n - 1];
    const i = Math.floor(u);
    const t = u - i;
    return hermiteDerivative(h[i], m[i] * step, h[i + 1], m[i + 1] * step, t) / step;
  }

  /* ---------------- chasms (override) ---------------- */
  const chasms = []; // features
  const chasmCell = new Int16Array(n); // chasm index + 1 for cells overlapping a chasm
  for (const p of pieces) {
    if (p.type !== 'chasm') continue;
    for (const [px0, px1] of p.pits) {
    const c = {
      type: FeatureType.CHASM,
      x: px0,
      x0: px0,
      x1: px1,
      y0: baseHeightAt(px0),
      y1: baseHeightAt(px1),
      variant: rngFeat.int(0, 3),
    };
    c.floorY = Math.max(c.y0, c.y1) + COURSE.PIT_DEPTH;
    c.y = c.floorY;
    chasms.push(c);
    for (let i = idx(c.x0) - 1; i <= idx(c.x1) + 1; i++) chasmCell[i] = chasms.length;
    }
  }
  const chasmAt = (x) => {
    const u = Math.round((x - minX) / step);
    if (u < 0 || u >= n) return null;
    const k = chasmCell[u];
    if (!k) return null;
    const c = chasms[k - 1];
    return x > c.x0 && x < c.x1 ? c : null;
  };
  const heightAt = (x) => {
    const c = chasmAt(x);
    return c ? c.floorY : baseHeightAt(x);
  };
  const slopeAt = (x) => (chasmAt(x) ? 0 : baseSlopeAt(x));

  /* ---------------- fairness helpers ---------------- */
  // Natural launch points: where the surface curves down faster than a ballistic arc at cruise speed.
  const crestBlock = new Uint8Array(n);
  {
    const kLaunch = GRAVITY / (COURSE.LAUNCH_SPEED * COURSE.LAUNCH_SPEED);
    for (let i = 1; i < n - 1; i++) {
      const c = (m[i + 1] - m[i - 1]) / (2 * step);
      const cosA = 1 / Math.sqrt(1 + m[i] * m[i]);
      if (c * cosA * cosA > kLaunch) {
        const end = Math.min(n - 1, i + Math.ceil(COURSE.CREST_CLEAR / step));
        for (let k = i; k <= end; k++) crestBlock[k] = 1;
      }
    }
  }
  const blocked = []; // [x0, x1] ranges where no rock may stand
  for (const p of pieces) blocked.push([p.x0 - 250, p.x1 + 150]);
  const isBlockedForRock = (x, r) => {
    for (let i = idx(x - r - 450); i <= idx(x + r); i++) if (crestBlock[i]) return true;
    for (const [a, b] of blocked) if (x + r > a && x - r < b) return true;
    return false;
  };

  /** Estimated rider speed at x (used to trace coin arcs). */
  const speedEst = (x) => clamp(terminalSpeed(meanSlopeH(x - 600, x)) * 1.05, 380, 560);
  function meanSlopeH(a, b) {
    return (baseHeightAt(b) - baseHeightAt(a)) / (b - a);
  }

  /* ---------------- 5. features ---------------- */
  const features = [...chasms];
  const coinArc = (x0, y0, vx, vy, opts = {}) => {
    const out = [];
    const tStart = opts.tStart ?? 0.12;
    const tEnd = opts.tEnd ?? 2.5;
    const maxCoins = opts.max ?? 12;
    for (let t = tStart; t < tEnd && out.length < maxCoins; t += COURSE.COIN_SPACING_T) {
      const x = x0 + vx * t;
      const y = y0 + vy * t + 0.5 * GRAVITY * t * t;
      const ground = heightAt(x);
      if (y > ground - 8) break;
      if (chasmAt(x) && opts.skipChasm) continue;
      out.push(x, y - BODY_CENTER);
    }
    for (let i = 0; i < out.length; i += 2) addPickup(PickupKind.COIN, out[i], out[i + 1]);
  };
  function addPickup(kind, x, y) {
    features.push({ type: FeatureType.PICKUP, kind, x, y, variant: 0 });
  }
  const jumpArcFrom = (x, extraVy = 0, slopeOverride = null, opts = {}) => {
    const v = speedEst(x);
    const a = Math.atan(slopeOverride ?? baseSlopeAt(x));
    coinArc(x, baseHeightAt(x), v * Math.cos(a), v * Math.sin(a) - JUMP_VY - extraVy, opts);
  };
  const addGrind = (kind, x0, x1, lift0, lift1, sag) => {
    const g = {
      type: FeatureType.GRIND,
      kind,
      x: x0,
      x0,
      x1,
      y0: baseHeightAt(x0) - lift0,
      y1: baseHeightAt(x1) - lift1,
      sag,
      variant: rngFeat.int(0, 3),
    };
    features.push(g);
    return g;
  };
  /** Weighted obstacle kind for a biome. */
  const pickKind = (biome) => {
    const mix = COURSE.OBSTACLE_MIX[biome];
    let r = rngFeat.next() * Object.values(mix).reduce((a, b) => a + b, 0);
    for (const [k, w] of Object.entries(mix)) if ((r -= w) <= 0) return k;
    return 'rock';
  };
  /**
   * Places a solid obstacle near x (shifted forward past crests / blocked ranges if needed).
   * `owned` = inside its own set piece (only the crest rule applies there).
   */
  const addObstacle = (kind, x, d, owned = false) => {
    const R = (a) => lerp(a[0], a[1], rngFeat.next());
    let f;
    if (kind === 'rock') {
      const r = lerp(COURSE.ROCK_R[0], COURSE.ROCK_R[0] + 6, rngFeat.next()) + (COURSE.ROCK_R[1] - COURSE.ROCK_R[0] - 6) * d * rngFeat.next();
      f = { type: FeatureType.ROCK, x, size: Math.round(r), variant: rngFeat.int(0, 5) };
    } else if (kind === 'campfire') f = { type: FeatureType.CAMPFIRE, x, size: 16, variant: rngFeat.int(0, 2) };
    else if (kind === 'log') f = { type: FeatureType.LOG, x, w: Math.round(lerp(COURSE.LOG_W[0], COURSE.LOG_W[1], rngFeat.next() * (0.4 + 0.6 * d))), h: Math.round(R(COURSE.LOG_H)), variant: rngFeat.int(0, 3) };
    else if (kind === 'snowman') f = { type: FeatureType.SNOWMAN, x, w: Math.round(R(COURSE.SNOWMAN_W)), h: Math.round(R(COURSE.SNOWMAN_H)), variant: rngFeat.int(0, 3) };
    else f = { type: FeatureType.SPIKES, x, w: Math.round(lerp(COURSE.SPIKES_W[0], COURSE.SPIKES_W[1], rngFeat.next() * (0.5 + 0.5 * d))), h: COURSE.SPIKES_H, variant: rngFeat.int(0, 3) };
    const half = f.w ? f.w / 2 : f.size;
    const bad = (xx) => (owned ? crestNear(xx, half) : isBlockedForRock(xx, half)) || chasmNear(xx, half + 40) || xx + half > finishX - COURSE.FINISH_CLEAR;
    for (let tries = 0; tries < 6 && bad(f.x); tries++) f.x += 110;
    if (bad(f.x)) return null;
    features.push(f);
    return f;
  };
  const crestNear = (xx, half) => {
    for (let i = idx(xx - half - 450); i <= idx(xx + half); i++) if (crestBlock[i]) return true;
    return false;
  };
  const chasmNear = (xx, pad) => chasms.some((c) => xx + pad > c.x0 && xx - pad < c.x1);


  const decorFixed = []; // decor tied to features (huts, poles)
  for (const p of pieces) placePiece(p);
  function placePiece(p) {
    const d = p.d;
    switch (p.type) {
      case 'kicker': {
        features.push({ type: FeatureType.RAMP, x: p.lipX - p.rampLen, x0: p.lipX - p.rampLen, x1: p.lipX + 1.6 * p.rampH, lipX: p.lipX, size: p.rampH, lipAngle: p.lipAngle, variant: rngFeat.int(0, 2) });
        const lipSlope = baseSlopeAt(p.lipX - 1);
        jumpArcFrom(p.lipX - 2, rampPop(p.rampH), lipSlope, { max: 14 });
        break;
      }
      case 'chasm': {
        // Narrow crevasses: sometimes a bunting line spans it (grind across instead of jumping).
        if (p.pits.length === 1 && p.pitClass === 'narrow' && rngFeat.chance(0.5)) {
          const lx0 = p.cx0 - p.rampLen * 0.5;
          const lx1 = p.cx1 + 480; // long enough that a ramp-launched rider comes down onto it
          const g = addGrind(GrindKind.BUNTING, lx0, lx1, rngFeat.range(84, 90) + 0.6 * p.rampH, rngFeat.range(86, 94), rngFeat.range(6, 12));
          decorFixed.push({ type: 'pole', x: lx0, scale: (baseHeightAt(lx0) - g.y0) / 90, depth: 0, variant: 0 });
          decorFixed.push({ type: 'pole', x: lx1, scale: (baseHeightAt(lx1) - g.y1) / 90, depth: 0, variant: 0 });
        }
        // Every pit has a kicker on its near lip.
        for (const [px0, , rl, rh, la] of p.pits) features.push({ type: FeatureType.RAMP, x: px0 - rl, x0: px0 - rl, x1: px0, lipX: px0, size: rh, lipAngle: la, variant: 0 });
        jumpArcFrom(p.cx0 - 2, rampPop(p.rampH), baseSlopeAt(p.cx0 - 1), { max: 14 });
        break;
      }
      case 'obstacles': {
        let first = null;
        let x = p.x0 + 200;
        for (let i = 0; i < p.count; i++) {
          const o = addObstacle(pickKind(biomeAt(x)), x, d, true);
          if (!first) first = o;
          x = (o ? o.x + extent(o)[1] - o.x : x) + p.spacing;
        }
        if (first) jumpArcFrom(first.x - speedEst(first.x) * 0.42, 0, null, { max: 10 });
        break;
      }
      case 'campfire': {
        const fx = p.x0 + 380;
        addObstacle('campfire', fx, d, true);
        jumpArcFrom(fx - speedEst(fx) * 0.42, 0, null, { max: 10 });
        decorFixed.push({ type: 'lantern', x: fx - 90, scale: 1, depth: 0.4, variant: 0 });
        break;
      }
      case 'bunting':
      case 'roofs': {
        const isRoof = p.type === 'roofs';
        let x = p.x0 + 120;
        for (let i = 0; i < p.spans.length; i++) {
          const [len, gapAfter] = p.spans[i];
          const x0 = x;
          const x1 = x + len;
          let line;
          if (isRoof) {
            const lift = rngFeat.range(56, 70);
            line = addGrind(GrindKind.ROOF, x0, x1, lift, lift, 0);
            decorFixed.push({ type: 'hut', x: (x0 + x1) / 2, scale: len / 200, depth: 0.15, variant: rngFeat.int(0, 3), roofLift: lift });
            if (rngFeat.chance(0.5)) decorFixed.push({ type: 'lantern', x: x1 + gapAfter * 0.5, scale: 1, depth: 0.3, variant: 1 });
          } else {
            const pole0 = rngFeat.range(84, 96);
            const pole1 = rngFeat.range(84, 96);
            let sag = rngFeat.range(14, 28);
            // Keep 52..100 px of clearance along the span.
            const g = addGrind(GrindKind.BUNTING, x0, x1, pole0, pole1, sag);
            line = g;
            for (let tries = 0; tries < 8; tries++) {
              let minClear = Infinity;
              for (let k = 1; k < 16; k++) {
                const t = k / 16;
                const gx = lerp(x0, x1, t);
                minClear = Math.min(minClear, baseHeightAt(gx) - grindLineY(g, gx));
              }
              if (minClear >= 52 || g.sag <= 0) break;
              g.sag = Math.max(0, g.sag - (52 - minClear) - 1);
            }
            // Some lines are the smart route over a hazard: spikes or a pair of snowmen underneath.
            if (!p.noHazards && rngFeat.chance(0.35) && x1 - x0 > 300) {
              const mid = (x0 + x1) / 2;
              if (rngFeat.chance(0.5)) addObstacle('spikes', mid, d, true);
              else {
                addObstacle('snowman', mid - 70, d, true);
                addObstacle('snowman', mid + 70, d, true);
              }
            }
            decorFixed.push({ type: 'pole', x: x0, scale: pole0 / 90, depth: 0, variant: 0 });
            decorFixed.push({ type: 'pole', x: x1, scale: pole1 / 90, depth: 0, variant: 0 });
          }
          if (i === 0) {
            // Coins tracing the jump onto the first line, then along it.
            for (let cx = x0 + 40; cx < x1 - 20; cx += 44) addPickup(PickupKind.COIN, cx, grindLineY(line, cx) - BODY_CENTER - 4);
          }
          x = x1 + gapAfter;
        }
        break;
      }
      case 'ice': {
        addGrind(GrindKind.ICE, p.x0 + 60, p.x1 - 60, 0, 0, 0);
        break;
      }
      case 'drop': {
        jumpArcFrom(p.dropX - 20, 0, null, { max: 14 });
        break;
      }
    }
  }


  // Minor elements in the gaps.
  let powerCounter = rngFeat.int(0, 2);
  for (const slot of minorSlots) {
    const span = slot.x1 - slot.x0;
    if (span < 700) continue;
    if (rngFeat.chance(0.6)) {
      const cx = slot.x0 + span * rngFeat.range(0.2, 0.35);
      const count = rngFeat.int(5, 8);
      for (let k = 0; k < count; k++) {
        const x = cx + k * 38;
        addPickup(PickupKind.COIN, x, baseHeightAt(x) - BODY_CENTER);
      }
    }
    if (!slot.safe) {
      // Something to react to in every gap; a second one in long gaps as the course goes on.
      const two = span > 2000 && rngFeat.chance(0.05 + 0.5 * slot.d);
      const one = rngFeat.chance(0.7 + 0.3 * slot.d);
      const fr = two ? [rngFeat.range(0.4, 0.5), rngFeat.range(0.68, 0.78)] : one ? [rngFeat.range(0.5, 0.68)] : [];
      let lastX = -Infinity;
      for (const t of fr) {
        const ox = Math.max(slot.x0 + span * t, slot.clearTo ?? -Infinity, lastX + 450);
        if (ox >= slot.x1 - 300) continue;
        const o = addObstacle(pickKind(biomeAt(ox)), ox, slot.d);
        if (o) lastX = o.x + (o.w ? o.w / 2 : o.size);
      }
    }
    if (!slot.safe && ++powerCounter % 4 === 0) {
      const kind = rngFeat.chance(0.5) ? PickupKind.FEATHER : PickupKind.MAGNET;
      const x = slot.x0 + span * 0.45;
      const high = rngFeat.chance(0.5);
      addPickup(kind, x, baseHeightAt(x) - (high ? 78 : BODY_CENTER + 6));
    }
  }

  // Sort, assign stable ids, freeze.
  // A short coin arc over every snowman, tracing the tap jump line.
  for (const f of features.filter((q) => q.type === FeatureType.SNOWMAN)) jumpArcFrom(f.x - speedEst(f.x) * 0.31, 0, null, { max: 6, tStart: 0.18 });
  features.sort((a, b) => a.x - b.x || typeOrder(a.type) - typeOrder(b.type));
  let maxRight = 0; // max(end - x)
  let maxLeft = 0; // max(x - start)
  features.forEach((f, i) => {
    f.id = i;
    if (f.y !== undefined) f.y = round2(f.y);
    const [a, b] = extent(f);
    maxRight = Math.max(maxRight, b - f.x);
    maxLeft = Math.max(maxLeft, f.x - a);
    Object.freeze(f);
  });
  const maxFeatureSpan = maxRight;
  // Flat tables for fast range queries.
  const fX = new Float64Array(features.length);
  const fStart = new Float64Array(features.length);
  const fEnd = new Float64Array(features.length);
  features.forEach((f, i) => {
    const [a, b] = extent(f);
    fX[i] = f.x;
    fStart[i] = a;
    fEnd[i] = b;
  });
  Object.freeze(features);

  function grindLineY(f, x) {
    if (f.kind === GrindKind.ICE) return heightAt(x);
    const t = clamp((x - f.x0) / (f.x1 - f.x0), 0, 1);
    return lerp(f.y0, f.y1, t) + f.sag * 4 * t * (1 - t);
  }

  /* ---------------- 6. decor ---------------- */
  const decor = [...decorFixed];
  decor.push({ type: 'startGate', x: startX, scale: 1, depth: 0, variant: 0 });
  decor.push({ type: 'finishArch', x: finishX, scale: 1, depth: 0, variant: 0 });
  // Distance boards (banner, variant = metres to go) and a lantern-lit final approach.
  for (const m of [500, 250, 100]) if (finishX - m * PX_PER_M > startX) decor.push({ type: 'banner', x: finishX - m * PX_PER_M, scale: 1, depth: 0.3, variant: m });
  for (let lx = finishX - 2200; lx < finishX - 60; lx += 240) decor.push({ type: 'lantern', x: lx, scale: 1, depth: 0.35, variant: 2 });
  const nearChasm = (x, pad) => chasms.some((c) => x > c.x0 - pad && x < c.x1 + pad);
  const nearHazard = (x, pad) => {
    const lo = lowerBound(features, x - pad - maxFeatureSpan, (f) => f.x);
    for (let i = lo; i < features.length && features[i].x < x + pad; i++) {
      const f = features[i];
      if (f.type === FeatureType.PICKUP) continue;
      const fx1 = f.x1 ?? f.x;
      if (fx1 > x - pad) return true;
    }
    return false;
  };
  {
    const DENSITY = { slopes: [160, 420], forest: [34, 95], village: [220, 520], ridge: [260, 640] };
    let x = minX + rngDecor.range(0, 80);
    while (x < maxX) {
      const biome = biomeAt(x);
      const [a, b] = DENSITY[biome];
      x += rngDecor.range(a, b);
      if (x >= maxX) break;
      if (nearChasm(x, 40)) continue;
      const front = rngDecor.chance(biome === 'forest' ? 0.12 : 0.07);
      if (front && (nearHazard(x, 220) || Math.abs(x - startX) < 250 || Math.abs(x - finishX) < 250)) continue;
      let type = 'pine';
      const r = rngDecor.next();
      if (biome === 'ridge') type = r < 0.35 ? 'deadTree' : r < 0.55 ? 'ruin' : r < 0.7 ? 'shrub' : 'pine';
      else if (biome === 'village') type = r < 0.25 ? 'hut' : r < 0.4 ? 'lantern' : r < 0.5 ? 'windmill' : r < 0.6 ? 'shrub' : 'pine';
      else if (biome === 'slopes') type = r < 0.06 ? 'windmill' : r < 0.2 ? 'shrub' : r < 0.26 ? 'deadTree' : 'pine';
      else type = r < 0.08 ? 'deadTree' : r < 0.16 ? 'shrub' : 'pine';
      if (front && type !== 'pine' && type !== 'shrub' && type !== 'deadTree') type = 'pine';
      const depth = front ? -rngDecor.range(0.3, 1) : type === 'windmill' ? rngDecor.range(1, 1.6) : rngDecor.range(0.25, 1.5);
      const scale = type === 'pine' ? rngDecor.range(0.6, 1.55) : type === 'lantern' ? 1 : rngDecor.range(0.75, 1.25);
      decor.push({ type, x: round2(x), scale: round2(scale), depth: round2(depth), variant: rngDecor.int(0, 3) });
    }
  }
  const finalDecor = decor.filter((dd) => !nearChasm(dd.x, 20) || dd.type === 'pole');
  finalDecor.sort((a, b) => a.x - b.x || a.depth - b.depth);
  finalDecor.forEach((dd) => Object.freeze(dd));
  Object.freeze(finalDecor);
  zones.forEach((z) => Object.freeze(z));
  Object.freeze(zones);

  /* ---------------- queries ---------------- */
  function featuresIn(x0, x1) {
    return featuresInto(x0, x1, []);
  }
  /** Like featuresIn, filling (and returning) a caller-owned array: no allocation. */
  function featuresInto(x0, x1, out) {
    out.length = 0;
    // binary search on the precomputed x table (no closures, no temporary arrays)
    const v = x0 - maxRight;
    let lo = 0;
    let hi = fX.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (fX[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    const lim = x1 + maxLeft;
    for (let i = lo; i < fX.length && fX[i] <= lim; i++) if (fEnd[i] >= x0 && fStart[i] <= x1) out.push(features[i]);
    return out;
  }
  function decorIn(x0, x1) {
    const out = [];
    for (let i = lowerBound(finalDecor, x0, (dd) => dd.x); i < finalDecor.length && finalDecor[i].x <= x1; i++) out.push(finalDecor[i]);
    return out;
  }

  return Object.freeze({
    seed,
    settings: Object.freeze(set),
    startX,
    finishX,
    length,
    minX,
    maxX,
    heightAt,
    slopeAt,
    features,
    featuresIn,
    decor: finalDecor,
    decorIn,
    zones,
    grindY: grindLineY,
    // private helpers (not in the contract; used by sim/tests)
    _baseHeightAt: baseHeightAt,
    _baseSlopeAt: baseSlopeAt,
    _chasmAt: chasmAt,
    _chasms: Object.freeze(chasms),
    _biomeAt: biomeAt,
    _extent: extent,
    _featuresInto: featuresInto,
  });
}

/** Smooth clamp (softplus on both sides, width k): continuous slope, no kinks. */
function softClamp(v, lo, hi, k) {
  const sp = (z) => (z > 30 ? z : Math.log1p(Math.exp(z)));
  v = lo + k * sp((v - lo) / k);
  return hi - k * sp((hi - v) / k);
}

function typeOrder(t) {
  return ['chasm', 'ramp', 'grind', 'rock', 'log', 'snowman', 'spikes', 'campfire', 'pickup'].indexOf(t);
}

/** Horizontal extent [start, end] of a feature (ranges, boxes centred on x, circles of radius size). */
function extent(f) {
  if (f.x1 !== undefined) return [f.x0 ?? f.x, f.x1];
  if (f.w !== undefined) return [f.x - f.w / 2, f.x + f.w / 2];
  if (f.size !== undefined && f.type !== 'ramp') return [f.x - f.size, f.x + f.size];
  return [f.x, f.x];
}

const round2 = (v) => Math.round(v * 100) / 100;

/* ---------------- piece planning ---------------- */

function pickPiece(rng, biome, prevType, d) {
  const weights = { ...PIECE_WEIGHTS[biome] };
  if (d < 0.12) delete weights.chasm;
  if (weights[prevType]) weights[prevType] *= 0.3;
  const entries = Object.entries(weights);
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = rng.next() * total;
  for (const [type, w] of entries) {
    r -= w;
    if (r <= 0) return type;
  }
  return entries[entries.length - 1][0];
}

/** Decides the extent and parameters of a set piece starting at x. */
function planPiece(rng, type, x, d) {
  const p = { type, x0: x, x1: x, d };
  switch (type) {
    case 'kicker': {
      // Standalone scooped ramp on an open slope (trick opportunity).
      p.rampH = lerp(COURSE.KICKER_H[0], COURSE.KICKER_H[1], rng.next());
      p.lipAngle = (lerp(COURSE.RAMP_LIP_DEG[0], COURSE.RAMP_LIP_DEG[1], rng.next()) * Math.PI) / 180;
      p.rampLen = (2 * p.rampH) / Math.tan(p.lipAngle);
      p.lipX = x + 250 + p.rampLen;
      p.landSlope = lerp(COURSE.LANDING_SLOPE[0], COURSE.LANDING_SLOPE[1], rng.next());
      p.x1 = p.lipX + 1.6 * p.rampH + COURSE.LANDING_LEN + COURSE.RUNOUT_LEN;
      p.bigAir = true;
      break;
    }
    case 'chasm': {
      // Width class: narrow crevasse, medium, or wide gorge; sometimes a double pit.
      const r = rng.next();
      const cls = r < 0.3 ? 'narrow' : r < 0.72 ? 'medium' : 'wide';
      const R = (a) => lerp(a[0], a[1], rng.next());
      const width = cls === 'narrow' ? R(COURSE.PIT_NARROW) : cls === 'medium' ? R(COURSE.PIT_MEDIUM) : R(COURSE.PIT_WIDE) + 25 * d * rng.next();
      p.pitClass = cls;
      // Scooped ramp on the near lip of every pit: [x0, x1, rampLen, rampH, lipAngle].
      const ramp = (hRange) => {
        const h = R(hRange);
        const ang = (R(COURSE.RAMP_LIP_DEG) * Math.PI) / 180;
        return [(2 * h) / Math.tan(ang), h, ang];
      };
      const [rl, rh, ra] = ramp(cls === 'narrow' ? COURSE.RAMP_H_NARROW : cls === 'medium' ? COURSE.RAMP_H_MEDIUM : COURSE.RAMP_H_WIDE);
      p.rampLen = rl;
      p.rampH = rh;
      p.landSlope = R(cls === 'wide' ? COURSE.GORGE_LANDING_SLOPE : COURSE.LANDING_SLOPE);
      p.landLen = cls === 'wide' ? COURSE.GORGE_LANDING_LEN : COURSE.LANDING_LEN;
      p.cx0 = x + 320 + rl;
      p.cx1 = p.cx0 + width;
      p.pits = [[p.cx0, p.cx1, rl, rh, ra]];
      if (cls !== 'wide' && rng.chance(0.18 + 0.12 * d)) {
        const a = p.cx1 + R(COURSE.PIT_DOUBLE_PAD);
        const [rl2, rh2, ra2] = ramp(COURSE.RAMP_H_NARROW);
        p.pits.push([a, a + R(COURSE.PIT_NARROW) + 20 * rng.next(), rl2, rh2, ra2]);
      }
      p.x1 = p.pits[p.pits.length - 1][1] + p.landLen + COURSE.RUNOUT_LEN;
      p.bigAir = true;
      break;
    }
    case 'obstacles':
      p.count = Math.min(3, 1 + Math.floor(rng.next() * (1.4 + 2 * d)));
      p.spacing = rng.range(360, 480) - 80 * d; // rows tighten along the course
      p.x1 = x + 200 + p.count * p.spacing + 250;
      break;
    case 'campfire':
      p.x1 = x + 900;
      break;
    case 'bunting':
    case 'roofs': {
      const isRoof = type === 'roofs';
      const count = isRoof ? rng.int(2, 4) : rng.int(2, 4);
      p.spans = [];
      let len = 120;
      for (let i = 0; i < count; i++) {
        const span = isRoof ? rng.range(150, 230) : rng.range(260, 560);
        const gap = isRoof ? rng.range(90, 170) : rng.range(110, 200);
        p.spans.push([span, gap]);
        len += span + gap;
      }
      p.x1 = x + len + 450;
      p.bigAir = true; // riding off a line at speed is real air: keep the gap after it clear
      break;
    }
    case 'ice':
      p.x1 = x + rng.range(500, 850);
      break;
    case 'drop':
      p.lipLen = 220;
      p.dropLen = rng.range(280, 470);
      p.steep = rng.range(0.5, 0.68);
      p.dropX = x + 200 + p.lipLen;
      p.rise = rng.chance(0.5);
      p.bigAir = true;
      p.x1 = p.dropX + p.dropLen + 950;
      break;
  }
  return p;
}
