/**
 * Small, seedable pseudo-random number generator (mulberry32).
 *
 * Math.random() cannot be seeded, but a seed lets us rebuild the exact same
 * track, which helps with debugging, testing and sharing runs (?seed=42).
 */
export function createRandom(seed) {
  let state = seed >>> 0;

  /** Returns a float in [0, 1). */
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    /** Float in [min, max). */
    range: (min, max) => min + (max - min) * next(),
    /** Integer in [min, max] (inclusive). */
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    /** true with the given probability. */
    chance: (probability) => next() < probability,
  };
}

/** Random 31-bit seed for a fresh run. */
export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}
