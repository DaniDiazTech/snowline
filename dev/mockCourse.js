/**
 * Contract-conformant stand-in for generateCourse (dev harness only).
 * A smooth descending slope with a little of everything on it: rocks,
 * chasms, ramps, all grind kinds, pickups, campfires and every decor type.
 */
import { PerlinNoise1D } from '../src/math/perlin.js';
import { createRandom } from '../src/math/random.js';
import { FeatureType, GrindKind, PickupKind, DEFAULT_SETTINGS, PX_PER_M } from '../src/contracts.js';

export function generateMockCourse(seed = 1, settings = DEFAULT_SETTINGS) {
  const noise = new PerlinNoise1D(seed);
  const rnd = createRandom(seed ^ 0xabc);
  const startX = 0;
  const length = 2400 * PX_PER_M;
  const finishX = startX + length;
  const minX = -1500;
  const maxX = finishX + 3000;

  const chasms = [];
  const ramps = [];
  const features = [];
  const decor = [];
  let id = 1;

  const base = (x) => 0.36 * x + 260 * noise.fbm(x / 2600, 3, 0.45) + 40 * noise.fbm(x / 500 + 30, 2, 0.5);
  const rampBump = (x) => {
    let y = 0;
    for (const r of ramps) {
      const d = x - r.x; // lip at d = 0
      if (d > -r.len && d <= 0) {
        const u = (d + r.len) / r.len;
        y -= r.h * u * u;
      }
    }
    return y;
  };
  const surface = (x) => base(x) + rampBump(x);
  const heightAt = (x) => {
    for (const c of chasms) if (x > c.x0 && x < c.x1) return surface(c.x0) + 900;
    return surface(x);
  };
  const slopeAt = (x) => {
    for (const c of chasms) if (x > c.x0 && x < c.x1) return 0;
    return (surface(x + 1) - surface(x - 1)) / 2;
  };

  // Lay out features.
  let x = 1400;
  const kinds = ['rock', 'decorRun', 'grind', 'pickup', 'chasm', 'ramp', 'campfire', 'roof', 'ice', 'decorRun', 'rock', 'pickup'];
  let k = 0;
  while (x < finishX - 1500) {
    const kind = kinds[k++ % kinds.length];
    if (kind === 'rock') {
      features.push({ id: id++, type: FeatureType.ROCK, x, size: 14 + rnd.range(0, 16), variant: rnd.int(0, 3) });
      x += 700;
    } else if (kind === 'chasm') {
      const w = 220 + rnd.range(0, 160);
      ramps.push({ x: x - 40, len: 260, h: 34 });
      chasms.push({ x0: x, x1: x + w });
      features.push({ id: id++, type: FeatureType.RAMP, x: x - 40, variant: 0 });
      features.push({ id: id++, type: FeatureType.CHASM, x, x0: x, x1: x + w, variant: rnd.int(0, 3) });
      x += w + 800;
    } else if (kind === 'ramp') {
      ramps.push({ x, len: 300, h: 46 });
      features.push({ id: id++, type: FeatureType.RAMP, x, variant: 0 });
      // coin arc after the ramp
      for (let i = 0; i < 6; i++) {
        const cx = x + 120 + i * 70;
        features.push({ id: id++, type: FeatureType.PICKUP, kind: PickupKind.COIN, x: cx, y: base(cx) - 130 - Math.sin((i / 5) * Math.PI) * 90 });
      }
      x += 1100;
    } else if (kind === 'grind') {
      const len = 520;
      features.push({ id: id++, type: FeatureType.GRIND, kind: GrindKind.BUNTING, x, x0: x, x1: x + len, y0: base(x) - 78, y1: base(x + len) - 78, sag: 26, variant: rnd.int(0, 3) });
      x += len + 600;
    } else if (kind === 'roof') {
      const len = 300;
      features.push({ id: id++, type: FeatureType.GRIND, kind: GrindKind.ROOF, x, x0: x, x1: x + len, y0: base(x) - 92, y1: base(x + len) - 92, sag: 0, variant: rnd.int(0, 3) });
      x += len + 650;
    } else if (kind === 'ice') {
      const len = 380;
      features.push({ id: id++, type: FeatureType.GRIND, kind: GrindKind.ICE, x, x0: x, x1: x + len, y0: base(x) - 36, y1: base(x + len) - 36, sag: 0, variant: rnd.int(0, 3) });
      x += len + 650;
    } else if (kind === 'pickup') {
      const pk = [PickupKind.FEATHER, PickupKind.MAGNET, PickupKind.COIN][rnd.int(0, 2)];
      features.push({ id: id++, type: FeatureType.PICKUP, kind: pk, x, y: base(x) - 70 });
      for (let i = 1; i <= 4; i++) features.push({ id: id++, type: FeatureType.PICKUP, kind: PickupKind.COIN, x: x + i * 60, y: base(x + i * 60) - 40 });
      x += 800;
    } else if (kind === 'campfire') {
      features.push({ id: id++, type: FeatureType.CAMPFIRE, x, size: 18, variant: 0 });
      decor.push({ type: 'lantern', x: x - 90, scale: 1, depth: 0.4, variant: 0 });
      x += 750;
    } else {
      x += 500;
    }
  }

  // Decor: forest runs, villages, poles, ruins, shrubs...
  const occupied = (dx) => features.some((f) => dx > (f.x0 ?? f.x) - 80 && dx < (f.x1 ?? f.x) + 80);
  for (let dx = minX; dx < maxX; ) {
    const biome = Math.floor((dx + 5000) / 6000) % 4;
    const r = rnd.next();
    if (!chasms.some((c) => dx > c.x0 - 30 && dx < c.x1 + 30)) {
      if (biome !== 2 && r < 0.55) {
        decor.push({ type: 'pine', x: dx, scale: 0.7 + rnd.range(0, 0.7), depth: rnd.chance(0.55) ? rnd.range(0.2, 1) : rnd.chance(0.25) ? -rnd.range(0.3, 1) : 0, variant: rnd.int(0, 5) });
      } else if (r < 0.62) {
        decor.push({ type: 'shrub', x: dx, scale: 0.6 + rnd.range(0, 0.6), depth: rnd.range(-0.3, 0.6), variant: rnd.int(0, 3) });
      } else if (r < 0.66) {
        decor.push({ type: 'deadTree', x: dx, scale: 0.8 + rnd.range(0, 0.5), depth: rnd.range(0, 0.8), variant: rnd.int(0, 3) });
      } else if (r < 0.7 && !occupied(dx)) {
        decor.push({ type: 'hut', x: dx, scale: 0.9 + rnd.range(0, 0.3), depth: rnd.range(0.3, 0.9), variant: rnd.int(0, 3) });
      } else if (r < 0.72) {
        decor.push({ type: 'windmill', x: dx, scale: 1, depth: 0.8, variant: rnd.int(0, 2) });
      } else if (r < 0.75) {
        decor.push({ type: 'lantern', x: dx, scale: 1, depth: rnd.range(0, 0.5), variant: 0 });
      } else if (r < 0.77) {
        decor.push({ type: 'ruin', x: dx, scale: 0.8 + rnd.range(0, 0.6), depth: rnd.range(0.3, 1), variant: rnd.int(0, 3) });
      } else if (r < 0.79) {
        decor.push({ type: 'pole', x: dx, scale: 1, depth: 0.2, variant: 0 });
      } else if (r < 0.8) {
        decor.push({ type: 'banner', x: dx, scale: 1, depth: 0.3, variant: rnd.int(0, 3) });
      }
    }
    dx += 50 + rnd.range(0, biome === 1 ? 70 : 220);
  }
  decor.push({ type: 'startGate', x: startX, scale: 1, depth: 0, variant: 0 });
  decor.push({ type: 'finishArch', x: finishX, scale: 1, depth: 0, variant: 0 });

  features.sort((a, b) => a.x - b.x);
  decor.sort((a, b) => a.x - b.x);

  const zones = [];
  for (let zx = minX, n = 0; zx < maxX; zx += 6000, n++) zones.push({ x0: zx, x1: Math.min(maxX, zx + 6000), biome: ['slopes', 'forest', 'village', 'ridge'][n % 4] });

  return {
    seed,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    startX,
    finishX,
    length,
    minX,
    maxX,
    heightAt,
    slopeAt,
    features,
    featuresIn: (a, b) => features.filter((f) => (f.x1 ?? f.x) >= a && (f.x0 ?? f.x) <= b),
    decor,
    decorIn: (a, b) => decor.filter((d) => d.x >= a && d.x <= b),
    zones,
    grindY: (f, gx) => {
      const u = Math.min(1, Math.max(0, (gx - f.x0) / (f.x1 - f.x0)));
      return f.y0 + (f.y1 - f.y0) * u + (f.sag || 0) * 4 * u * (1 - u);
    },
  };
}
