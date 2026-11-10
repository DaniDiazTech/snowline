/**
 * Seeded 1D Perlin noise plus fractal Brownian motion (fBm).
 *
 * This is Ken Perlin's gradient noise reduced to one dimension: every
 * integer lattice point gets a random slope (gradient), and between two
 * lattice points we blend both slopes with the smooth "fade" curve
 * 6t^5 - 15t^4 + 10t^3. Adding several octaves (each one double the
 * frequency and half the amplitude) gives natural looking hills.
 *
 * We implement it ourselves (instead of p5's noise()) so the terrain
 * generator has no dependency on the renderer and can be seeded per run.
 */
import { createRandom } from './random.js';

const PERMUTATION_SIZE = 256;

export class PerlinNoise1D {
  constructor(seed) {
    const random = createRandom(seed);

    // A random slope in [-1, 1] for each lattice point.
    this.gradients = Array.from({ length: PERMUTATION_SIZE }, () => random.range(-1, 1));

    // Shuffled index table (Fisher-Yates) so the pattern does not repeat obviously.
    const table = Array.from({ length: PERMUTATION_SIZE }, (_, i) => i);
    for (let i = PERMUTATION_SIZE - 1; i > 0; i--) {
      const j = random.int(0, i);
      [table[i], table[j]] = [table[j], table[i]];
    }
    this.permutation = table;
  }

  /** Gradient value for an integer lattice coordinate. */
  gradientAt(i) {
    const index = this.permutation[((i % PERMUTATION_SIZE) + PERMUTATION_SIZE) % PERMUTATION_SIZE];
    return this.gradients[index];
  }

  /** Single octave of noise. Output is roughly in [-0.5, 0.5]. */
  noise(x) {
    const i0 = Math.floor(x);
    const t = x - i0;

    // Each lattice point contributes "slope * distance to that point".
    const left = this.gradientAt(i0) * t;
    const right = this.gradientAt(i0 + 1) * (t - 1);

    return lerp(left, right, fade(t));
  }

  /**
   * Fractal Brownian motion: sum of octaves, normalised to roughly [-1, 1].
   * @param {number} x          sample position (already scaled by frequency)
   * @param {number} octaves    number of layers to add
   * @param {number} persistence amplitude multiplier per octave (0..1)
   */
  fbm(x, octaves = 4, persistence = 0.5) {
    let total = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;

    for (let octave = 0; octave < octaves; octave++) {
      total += this.noise(x * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= 2;
    }

    // A single octave peaks around ±0.5, so multiply by 2 to approach ±1.
    return (2 * total) / maxValue;
  }
}

/** Perlin's quintic smoothstep: zero 1st and 2nd derivative at t = 0 and 1. */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
