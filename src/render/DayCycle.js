/**
 * Day/night + weather model.
 *
 *   sampleAtmosphere(timeMs, course) → Atmosphere      (pure, no state)
 *
 * Pacing: a race should have ONE dominant mood and at most one transition. The start time picks
 * an arc (dawn→day, day, golden→dusk, dusk→night, night); during the expected race time
 * T = course.length / 20 m/s the phase holds the first mood for ~40 % of T and then eases into
 * the second by ~95 % of T. After that (long runs, home/lobby backdrop) the clock keeps going at
 * a cycle length of 2.5 × T. 'auto' favours the photogenic transitions (golden→dusk, dusk→night,
 * dawn→day). Moods are keyframes on the cycle phase
 * (0..1). A few "helper" keys (morning, twilight, predawn) sit between the
 * big moods so a blend never passes through a muddy grey; between keys the
 * colours are mixed in OKLab with a smoothstep, which also makes every mood
 * linger a moment before it changes.
 *
 * Weather comes from course.settings.weather. 'auto' is a seed-derived
 * schedule: the race is cut in WEATHER_SEG_MS windows, each one rolls a
 * weather, and it fades in/out at the edges (held across equal neighbours).
 * Storm desaturates and darkens the palette, fog pulls every layer towards
 * the haze, lightning flashes are a pure function of time too.
 */
import { clamp, lerp, smoothstep } from '../math/utils.js';
import { hex, rgbToOklab, oklabToRgb, toHex, mix, desaturate, scale } from './color.js';

export const CYCLE_MS = 150000; // fallback cycle when the course has no length

/** Race arcs: [from phase, to phase]. */
export const ARCS = Object.freeze({
  dawn: [0.0, 0.2], // dawn → day
  day: [0.2, 0.37], // day holds
  golden: [0.47, 0.585], // golden → dusk
  dusk: [0.585, 0.76], // dusk → night (through twilight)
  night: [0.78, 0.9], // night holds
});
const AUTO_ARCS = [
  ['golden', 0.3],
  ['dusk', 0.3],
  ['dawn', 0.25],
  ['day', 0.1],
  ['night', 0.05],
];

/** Expected race time in s for a course (nominal 20 m/s = 480 px/s). */
export function expectedRaceS(course) {
  return course?.length > 0 ? course.length / 480 : 120;
}

/** Arc used by a course (explicit start time, or a seed-derived photogenic pick for 'auto'). */
export function arcOf(course) {
  const st = course?.settings?.startTime ?? 'auto';
  if (st in ARCS) return ARCS[st];
  let r = hash01(course?.seed ?? 1, 77);
  for (const [name, p] of AUTO_ARCS) {
    if (r < p) return ARCS[name];
    r -= p;
  }
  return ARCS.golden;
}

/** Cycle phase (0..1) at a race time. Pure. */
export function phaseAt(timeMs, course) {
  const [from, to] = arcOf(course);
  const T = expectedRaceS(course) * 1000;
  const u = timeMs / T;
  let ph;
  if (u <= 1) ph = from + (to - from) * smoothstep(0.4, 0.95, Math.max(0, u));
  else ph = to + (timeMs - T) / (2.5 * T);
  return ((ph % 1) + 1) % 1;
}
const WEATHER_SEG_MS = 42000;
const WEATHER_FADE_MS = 9000;
const FLASH_SLOT_MS = 1900;

/** Phase of the cycle at race time 0 for each named start time. */
export const START_PHASE = Object.freeze({ dawn: 0.0, day: 0.2, golden: 0.455, dusk: 0.57, night: 0.76 });

const COLOR_KEYS = ['skyTop', 'skyMid', 'skyBottom', 'sun', 'glow', 'r0', 'r1', 'r2', 'r3', 'r4', 'snow', 'snowShade', 'silhouette', 'accent', 'cloud', 'moon'];

/* Keyframes. phase, hour, night, sunR (sun radius as a fraction of screen height) + colours. */
const KEYS = [
  {
    phase: 0.0, hour: 6, night: 0.25, sunR: 0.07,
    skyTop: '#6E7FB0', skyMid: '#C7A2BC', skyBottom: '#F4BEA2', sun: '#FFF0DA', glow: '#FFC6A6',
    r0: '#E8B9AF', r1: '#CC9BA6', r2: '#A57E99', r3: '#7A6187', r4: '#524669',
    snow: '#FBEDEA', snowShade: '#AE9FC6', silhouette: '#342B4C', accent: '#FFC27A', cloud: '#FCD9CC', moon: '#F6EEE6',
  },
  {
    phase: 0.1, hour: 8, night: 0.05, sunR: 0.06,
    skyTop: '#76A0D6', skyMid: '#B4CBE6', skyBottom: '#F2E0D2', sun: '#FFFBEF', glow: '#FFE7CF',
    r0: '#D5D2E0', r1: '#B3B8D2', r2: '#8E98BC', r3: '#6874A0', r4: '#47527E',
    snow: '#FCF9F7', snowShade: '#A6B4D4', silhouette: '#2C3554', accent: '#FFD08A', cloud: '#FFF4EC', moon: '#F6EEE6',
  },
  {
    phase: 0.2, hour: 10.5, night: 0, sunR: 0.055,
    skyTop: '#73AEE0', skyMid: '#ADD5EE', skyBottom: '#E8F4FA', sun: '#FFFFF6', glow: '#FFFFFF',
    r0: '#C9E1EC', r1: '#A3C8DB', r2: '#7CABC6', r3: '#588BAA', r4: '#3A6684',
    snow: '#FFFFFF', snowShade: '#A9C7DF', silhouette: '#233A4E', accent: '#FFD38A', cloud: '#FFFFFF', moon: '#F6EEE6',
  },
  {
    phase: 0.37, hour: 14.5, night: 0, sunR: 0.055,
    skyTop: '#6FA9DE', skyMid: '#A9D2EC', skyBottom: '#EAF2F4', sun: '#FFFDF0', glow: '#FFF8E6',
    r0: '#CFDFE6', r1: '#A9C5D5', r2: '#82A8C0', r3: '#5D88A4', r4: '#3D637E',
    snow: '#FFFFFF', snowShade: '#ABC5DB', silhouette: '#243A4C', accent: '#FFD38A', cloud: '#FFFFFF', moon: '#F6EEE6',
  },
  {
    // helper: late afternoon — sky top turns periwinkle while the horizon warms, so
    // the blue → orange blend goes through lavender/rose instead of grey
    phase: 0.425, hour: 16.2, night: 0, sunR: 0.07,
    skyTop: '#8C98D6', skyMid: '#C9B6D4', skyBottom: '#FAD7B4', sun: '#FFF8E4', glow: '#FFE6C2',
    r0: '#E6D2D6', r1: '#CDB2C4', r2: '#AE92B2', r3: '#8A7099', r4: '#624F7A',
    snow: '#FFF6F0', snowShade: '#BCA9CF', silhouette: '#2F2744', accent: '#FFD38A', cloud: '#FFF0E8', moon: '#F6EEE6',
  },
  {
    phase: 0.475, hour: 17.4, night: 0, sunR: 0.095,
    skyTop: '#EC9457', skyMid: '#F5B26B', skyBottom: '#FCE6B6', sun: '#FFF6DC', glow: '#FFE0A0',
    r0: '#F6CB92', r1: '#E9A46C', r2: '#CF7A50', r3: '#A6523E', r4: '#713233',
    snow: '#FFF0DC', snowShade: '#E0A58C', silhouette: '#4A2026', accent: '#FFD27A', cloud: '#FFE9C8', moon: '#FFF2E0',
  },
  {
    phase: 0.585, hour: 19.2, night: 0.35, sunR: 0.085,
    skyTop: '#3E3A78', skyMid: '#9C5D90', skyBottom: '#EC8F86', sun: '#FFD6B4', glow: '#F7A39C',
    r0: '#D88A93', r1: '#AE6B8B', r2: '#83527F', r3: '#5C3E6C', r4: '#392B50',
    snow: '#F2D9E4', snowShade: '#9B89BB', silhouette: '#291E3B', accent: '#FFB66B', cloud: '#F6AFB2', moon: '#FBEFE6',
  },
  {
    phase: 0.67, hour: 20.4, night: 0.72, sunR: 0.08,
    skyTop: '#1C2058', skyMid: '#3F3B7A', skyBottom: '#86689C', sun: '#FFCDB8', glow: '#B79CD0',
    r0: '#7D6C9E', r1: '#62598C', r2: '#4A4677', r3: '#34345E', r4: '#222445',
    snow: '#C8C8E6', snowShade: '#6A6FA4', silhouette: '#18193A', accent: '#FFB868', cloud: '#7F71A6', moon: '#F4F1E2',
  },
  {
    phase: 0.76, hour: 22, night: 1, sunR: 0.06,
    skyTop: '#0A0F2E', skyMid: '#16204D', skyBottom: '#2C3C72', sun: '#F4F1E0', glow: '#8FA8E4',
    r0: '#3B4B84', r1: '#304072', r2: '#263361', r3: '#1C274E', r4: '#131B3A',
    snow: '#AFC2EA', snowShade: '#4D5E98', silhouette: '#0D1228', accent: '#FFC46B', cloud: '#3E4E84', moon: '#F4F1E0',
  },
  {
    phase: 0.915, hour: 3.5, night: 1, sunR: 0.06,
    skyTop: '#0B1131', skyMid: '#18234F', skyBottom: '#2E3E74', sun: '#F4F1E0', glow: '#93A9E2',
    r0: '#3E4D86', r1: '#324274', r2: '#283563', r3: '#1D2850', r4: '#141C3B',
    snow: '#B2C3EA', snowShade: '#50619A', silhouette: '#0E1329', accent: '#FFC46B', cloud: '#405086', moon: '#F4F1E0',
  },
  {
    phase: 0.965, hour: 5, night: 0.65, sunR: 0.07,
    skyTop: '#232A5C', skyMid: '#5A5288', skyBottom: '#B98AA2', sun: '#FFE6D0', glow: '#D6A2B4',
    r0: '#977C9E', r1: '#78678E', r2: '#5B527A', r3: '#413F64', r4: '#2B2C4A',
    snow: '#D8CCE4', snowShade: '#7C77A6', silhouette: '#1F1C38', accent: '#FFC27A', cloud: '#B48FAE', moon: '#F6EEE6',
  },
];

// Pre-convert every keyframe colour to OKLab once.
for (const k of KEYS) {
  k.lab = {};
  for (const name of COLOR_KEYS) k.lab[name] = rgbToOklab(hex(k[name]));
}

/** Small integer hash → [0, 1). Pure, no state (renderer must not use Math.random for anything shared). */
export function hash01(a, b = 0) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Cycle phase at race time 0. */
export function startPhase(course) {
  const st = course?.settings?.startTime ?? 'auto';
  if (st in START_PHASE) return START_PHASE[st];
  // 'auto': one of the moods (slightly jittered) picked from the seed.
  const names = ['dawn', 'day', 'day', 'golden', 'dusk', 'night'];
  const r = hash01(course?.seed ?? 1, 77);
  const pick = names[Math.floor(r * names.length)];
  return (START_PHASE[pick] + (hash01(course?.seed ?? 1, 78) - 0.5) * 0.04 + 1) % 1;
}

const WEATHER_TABLE = [
  ['clear', 0.36],
  ['snow', 0.32],
  ['fog', 0.16],
  ['storm', 0.16],
];

function weatherForSegment(seed, seg) {
  if (seg < 0) seg = 0;
  let r = hash01(seed, 1000 + seg);
  for (const [w, p] of WEATHER_TABLE) {
    if (r < p) return w;
    r -= p;
  }
  return 'clear';
}

/** Weather + intensity at a race time. */
export function sampleWeather(timeMs, course) {
  const setting = course?.settings?.weather ?? 'auto';
  const t = Math.max(0, timeMs);
  if (setting !== 'auto') {
    // A fixed weather still breathes a little.
    const amt = setting === 'clear' ? 0 : 0.82 + 0.18 * Math.sin(t / 7300);
    return { weather: setting, weatherAmt: amt };
  }
  const seed = course?.seed ?? 1;
  const seg = Math.floor(t / WEATHER_SEG_MS);
  const local = t - seg * WEATHER_SEG_MS;
  const w = weatherForSegment(seed, seg);
  if (w === 'clear') return { weather: 'clear', weatherAmt: 0 };
  const prevSame = seg > 0 && weatherForSegment(seed, seg - 1) === w;
  const nextSame = weatherForSegment(seed, seg + 1) === w;
  const fin = prevSame || seg === 0 ? 1 : smoothstep(0, WEATHER_FADE_MS, local);
  const fout = nextSame ? 1 : 1 - smoothstep(WEATHER_SEG_MS - WEATHER_FADE_MS, WEATHER_SEG_MS, local);
  return { weather: w, weatherAmt: Math.min(fin, fout) * (0.85 + 0.15 * Math.sin(t / 5100)) };
}

function lightning(timeMs, seed, amt) {
  if (amt <= 0.05) return 0;
  const slot = Math.floor(timeMs / FLASH_SLOT_MS);
  let flash = 0;
  // look at this slot and the previous one so a decay can cross the boundary
  for (let s = slot - 1; s <= slot; s++) {
    if (hash01(seed, 5000 + s) > 0.16 * amt) continue;
    const at = s * FLASH_SLOT_MS + hash01(seed, 6000 + s) * FLASH_SLOT_MS * 0.6;
    const dt = timeMs - at;
    if (dt < 0) continue;
    // double flicker: a bright stroke, a short dip, a second weaker stroke
    const a = Math.exp(-dt / 70);
    const b = dt > 140 ? 0.7 * Math.exp(-(dt - 140) / 110) : 0;
    flash = Math.max(flash, Math.min(1, a + b));
  }
  return flash < 0.01 ? 0 : flash;
}

/** Wraps an hour difference so 22 → 3.5 means +5.5. */
function hourLerp(h0, h1, t) {
  let d = h1 - h0;
  if (d < 0) d += 24;
  return (h0 + d * t) % 24;
}

/** Sun (or moon) height curve: s = 0 rising, 0.5 zenith, 1 setting. */
function arc(s, xFrom, xTo) {
  const x = lerp(xFrom, xTo, s);
  // flattened arc: the disc lingers above the ridges at dawn / golden hour, then sinks
  // behind them; past the ends of the arc y keeps growing (> 1 = below the horizon)
  if (s < 0 || s > 1) return { x, y: 0.52 + Math.abs(s < 0 ? s : s - 1) * 4 };
  const y = 0.52 - 0.44 * Math.sin(Math.PI * s) ** 0.6;
  return { x, y };
}

const labScratch = [0, 0, 0];

/**
 * @param {number} timeMs  race clock
 * @param {import('../contracts.js').Course} course
 * @returns {import('../contracts.js').Atmosphere}
 */
export function sampleAtmosphere(timeMs, course) {
  const phase = phaseAt(timeMs, course);

  // Find the surrounding keyframes.
  let i = KEYS.length - 1;
  for (let k = 0; k < KEYS.length; k++) if (KEYS[k].phase <= phase) i = k;
  const a = KEYS[i];
  const b = KEYS[(i + 1) % KEYS.length];
  const span = (b.phase > a.phase ? b.phase : b.phase + 1) - a.phase;
  const raw = (phase - a.phase) / span;
  const t = raw * raw * (3 - 2 * raw);

  const c = {};
  for (const name of COLOR_KEYS) {
    const A = a.lab[name];
    const B = b.lab[name];
    labScratch[0] = A[0] + (B[0] - A[0]) * t;
    labScratch[1] = A[1] + (B[1] - A[1]) * t;
    labScratch[2] = A[2] + (B[2] - A[2]) * t;
    c[name] = oklabToRgb(labScratch);
  }
  const hour = hourLerp(a.hour, b.hour, raw);
  let night = lerp(a.night, b.night, t);
  const sunR = lerp(a.sunR, b.sunR, t);

  // Weather grading.
  const { weather, weatherAmt } = sampleWeather(timeMs, course);
  const seed = course?.seed ?? 1;
  let flash = 0;
  let fogAmt = 0;
  if (weather === 'storm') {
    const k = weatherAmt;
    const storm = [96, 104, 122];
    for (const name of ['skyTop', 'skyMid', 'skyBottom', 'cloud']) c[name] = mix(desaturate(c[name], 0.55 * k), scale(storm, 0.55 + 0.45 * (1 - night)), 0.35 * k);
    for (const name of ['r0', 'r1', 'r2', 'r3', 'r4']) c[name] = scale(desaturate(c[name], 0.4 * k), 1 - 0.18 * k);
    c.snow = desaturate(scale(c.snow, 1 - 0.12 * k), 0.3 * k);
    c.snowShade = desaturate(scale(c.snowShade, 1 - 0.12 * k), 0.3 * k);
    c.glow = mix(c.glow, c.skyMid, 0.6 * k);
    night = Math.min(1, night + 0.15 * k);
    flash = lightning(timeMs, seed, k);
  } else if (weather === 'fog') {
    fogAmt = weatherAmt;
    const haze = mix(c.skyBottom, [236, 238, 242], 0.25 * (1 - night));
    c.skyBottom = mix(c.skyBottom, haze, 0.6 * fogAmt);
    c.skyMid = mix(c.skyMid, haze, 0.45 * fogAmt);
    c.skyTop = mix(c.skyTop, haze, 0.2 * fogAmt);
    const pull = [0.55, 0.48, 0.4, 0.3, 0.2];
    pull.forEach((p, n) => (c[`r${n}`] = mix(c[`r${n}`], c.skyBottom, p * fogAmt)));
  } else if (weather === 'snow') {
    const k = weatherAmt;
    for (const name of ['skyTop', 'skyMid', 'cloud']) c[name] = desaturate(c[name], 0.22 * k);
    c.skyBottom = mix(c.skyBottom, [225, 230, 238], 0.15 * k * (1 - night));
    for (const name of ['r0', 'r1', 'r2']) c[name] = mix(c[name], c.skyBottom, 0.18 * k);
  }

  // Sun and moon arcs (screen fractions). Sun up from hour 5.3 to 19.4.
  const sunS = ((hour - 5.3 + 24) % 24) / 14.1;
  const moonS = ((hour - 19.0 + 24) % 24) / 10.6;
  const sunPos = arc(sunS > 1.5 ? sunS - 24 / 14.1 : sunS, 0.16, 0.8);
  const moonPos = arc(moonS > 1.5 ? moonS - 24 / 10.6 : moonS, 0.2, 0.78);

  const stars = clamp((night - 0.45) / 0.5, 0, 1) * (weather === 'storm' || weather === 'fog' ? 1 - 0.85 * weatherAmt : 1);

  return {
    hour,
    night,
    skyTop: toHex(c.skyTop),
    skyMid: toHex(c.skyMid),
    skyBottom: toHex(c.skyBottom),
    sun: toHex(c.sun),
    glow: toHex(c.glow),
    ridges: [toHex(c.r0), toHex(c.r1), toHex(c.r2), toHex(c.r3), toHex(c.r4)],
    snow: toHex(c.snow),
    snowShade: toHex(c.snowShade),
    silhouette: toHex(c.silhouette),
    accent: toHex(c.accent),
    sunPos,
    moonPos,
    stars,
    weather,
    weatherAmt,
    flash,
    // private extras for the renderer (contract allows additions)
    _phase: phase,
    _sunR: sunR,
    _moon: toHex(c.moon),
    _cloud: toHex(c.cloud),
    _fog: fogAmt,
  };
}
