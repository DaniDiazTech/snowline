/**
 * Render harness: runs the Renderer full-window, driven either by the real
 * course + RiderSim/Bot (when src/world and src/sim import cleanly) or by the
 * mock course + MockRider fallback.
 *
 * Query params
 *   t=<ms>        race time to show (default 0 / live from 0)
 *   seed= weather= start=      course seed + settings (weather/startTime)
 *   length=sprint|classic|marathon
 *   near=<type>   POSE at the nth (nth=) feature/decor of a type (rock, chasm, bunting, roof, ice, campfire, hut, windmill…), offset dx=
 *   mode=land&lt=<ms after touchdown>&tilt=<deg>&impact=&sketchy=1   scripted landing
 *   mode=crashslide&ct=<ms after crash>                                 scripted sliding crash + get-up
 *   mode=rescue&ru=<ms after lift start (0..3000, >3000 = set down)>   scripted pit rescue (near=chasm)
 *   x=<world x>   POSE mode: put the local rider at x (instead of simulating)
 *   mode=air|grind|ground|crashed|idle|finished   pose mode (with x)
 *   air=<px>      height above ground for mode=air (default 170)
 *   speed=<px/s>  pose speed (default 500 = cruising)
 *   crouch= scarf= angle=     pose overrides (angle in degrees)
 *   boost=0..3 shield=1 hover=1
 *   event=land|crash|smash|pickup|boost|jump|finish|combo (level=1..3 for boost; evframes=k frames before the end)   fire one effect shortly before the frame
 *   pit=<n>&warm=<ms>  (sim mode) drop the local rider into the nth pit at the start of the frozen window
 *   ghosts=<n>    number of other riders (bots)
 *   freeze=1      render a deterministic warm-up, then stop (for screenshots)
 *   rate=<k>      live playback speed multiplier
 *   cinematic=1   home/lobby camera
 *   mock=1        force the mock course/rider
 *   perf=1        frame-time overlay (also exposed as window.__perf)
 *   camzoom=<k>  extra camera magnification (close-ups of the rider)
 *   dpr=<n>       pixel density (default devicePixelRatio, max 2)
 */
import { Renderer } from '../src/render/Renderer.js';
import { surfaceY } from '../src/render/TerrainRenderer.js';
import { generateMockCourse } from './mockCourse.js';
import { MockRider } from './mockRider.js';
import { DEFAULT_SETTINGS, PLAYER_COLORS, RiderMode, TICK_MS, TICK_DT, SimEvent, FeatureType } from '../src/contracts.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? Number(Q.get(k)) : d);
const NAMES = ['MAYA', 'IZAN', 'LUCÍA', 'BRUNO', 'NOA', 'TEO', 'VERA', 'OMAR', 'ZOE', 'LIAM', 'ADA'];

async function loadModules() {
  if (Q.get('mock') === '1') return { generateCourse: null };
  const out = { generateCourse: null, RiderSim: null, Bot: null };
  try {
    const m = await import('../src/world/Course.js');
    out.generateCourse = m.generateCourse || null;
  } catch (e) {
    console.info('[harness] real Course not available, using mock:', e.message);
  }
  try {
    const m = await import('../src/sim/RiderSim.js');
    out.RiderSim = m.RiderSim || null;
    const b = await import('../src/sim/Bot.js');
    out.Bot = b.Bot || null;
  } catch (e) {
    console.info('[harness] real RiderSim/Bot not available, using mock rider:', e.message);
  }
  return out;
}

function viewOf(state, id, i, isLocal) {
  return {
    id,
    name: isLocal ? 'YOU' : NAMES[i % NAMES.length],
    color: PLAYER_COLORS[isLocal ? 0 : (i * 5 + 3) % PLAYER_COLORS.length],
    isLocal,
    x: state.x,
    y: state.y,
    vx: state.vx,
    vy: state.vy,
    angle: state.angle,
    mode: state.mode,
    crouch: state.crouch ?? 0,
    scarf: state.scarf ?? 0.4,
    boostLevel: state.boostT > 0 ? state.boostLevel || 1 : 0,
    shield: !!state.shield,
    hover: (state.hoverT ?? 0) > 0,
  };
}

async function main() {
  const mods = await loadModules();
  const settings = {
    ...DEFAULT_SETTINGS,
    weather: Q.get('weather') || 'clear',
    startTime: Q.get('start') || 'day',
    length: Q.get('length') || 'classic',
    bots: num('ghosts', 0),
  };
  const seed = num('seed', 7);
  let course = null;
  let usingReal = false;
  if (mods.generateCourse) {
    try {
      course = mods.generateCourse(seed, settings);
      usingReal = true;
    } catch (e) {
      console.warn('[harness] generateCourse threw, falling back to mock', e);
    }
  }
  if (!course) course = generateMockCourse(seed, settings);
  const useSim = usingReal && mods.RiderSim && mods.Bot;
  // near=<feature type|grind kind|decor type>[&nth=k][&dx=offset]: resolve x from the course
  if (Q.has('near') && !Q.has('x')) {
    const what = Q.get('near');
    const nth = num('nth', 0);
    const list = [
      ...course.features.filter((f) => f.type === what || f.kind === what),
      ...course.decor.filter((d) => d.type === what),
    ].filter((o) => o.x > course.startX + 200).sort((a, b) => a.x - b.x);
    const o = list[Math.min(nth, list.length - 1)];
    if (o) Q.set('x', String((o.x0 ?? o.x) + num('dx', -260)));
    else console.warn('[harness] near: nothing of type', what);
  }
  const pose = Q.has('x');
  const freeze = Q.get('freeze') === '1';
  const targetMs = num('t', 0);
  const nGhosts = num('ghosts', 0);
  const rate = num('rate', 1);

  // ---- riders ----
  const makeRider = (i) => {
    if (useSim) {
      const sim = new mods.RiderSim(course);
      const bot = new mods.Bot(course, seed * 13 + i * 101, i === 0 ? 0.8 : 0.45 + 0.08 * (i % 6));
      const r = { sim, bot, mute: false, start: () => sim.start() };
      r.step = () => sim.step(r.mute ? { held: false } : bot.decide(sim.state));
      return r;
    }
    const sim = new MockRider(course, seed * 13 + i * 101, 0.7);
    return { sim, step: () => sim.step(), start: () => sim.start() };
  };
  const riders = Array.from({ length: 1 + nGhosts }, (_, i) => makeRider(i));
  riders.forEach((r) => r.start());
  let tick = 0;
  let pendingEvents = [];
  const stepAll = () => {
    tick++;
    riders.forEach((r, i) => {
      const ev = r.step() || [];
      if (i === 0) pendingEvents.push(...ev);
    });
  };

  // ---- pose mode: synthetic RiderView at x ----
  const poseView = (x, i, timeMs) => {
    const mode = Q.get('mode') || 'ground';
    const speed = num('speed', 500);
    const off = i * -95;
    const px = x + off;
    const slope = course.slopeAt(px);
    const ang = Math.atan(slope);
    const v = {
      x: px, y: surfaceY(course, px), vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, angle: ang,
      mode: RiderMode.GROUND, crouch: num('crouch', 0.15), scarf: num('scarf', 0.7), boostT: num('boost', 0) ? 1 : 0, boostLevel: num('boost', 0),
      shield: Q.get('shield') === '1', hoverT: Q.get('hover') === '1' ? 1 : 0,
    };
    if (mode === 'air') {
      v.mode = RiderMode.AIR;
      v.y -= num('air', 170);
      v.vx = speed;
      v.vy = -120;
      v.angle = Q.has('angle') ? (num('angle', 0) * Math.PI) / 180 : -0.15;
      v.crouch = num('crouch', 0);
    } else if (mode === 'grind') {
      v.mode = RiderMode.GRIND;
      const g = course.features.filter((f) => f.type === FeatureType.GRIND).sort((a, b) => Math.abs(a.x0 - px) - Math.abs(b.x0 - px))[0];
      if (g) {
        const gx = Math.min(g.x1 - 10, Math.max(g.x0 + 10, px));
        v.x = gx;
        v.y = course.grindY(g, gx);
        v.angle = Math.atan2(course.grindY(g, gx + 2) - course.grindY(g, gx - 2), 4);
        v.vx = speed * Math.cos(v.angle);
        v.vy = speed * Math.sin(v.angle);
      }
      v.crouch = num('crouch', 0.3);
    } else if (mode === 'crashed') {
      v.mode = RiderMode.CRASHED;
      v.angle = 2.2 + timeMs * 0.008;
      v.y -= 10;
    } else if (mode === 'idle' || mode === 'finished') {
      v.mode = mode;
      v.vx = mode === 'idle' ? 0 : 120;
      v.vy = 0;
    }
    if (Q.has('angle') && mode !== 'air') v.angle = (num('angle', 0) * Math.PI) / 180;
    if (i % 2 === 1 && mode === 'ground') {
      // every other ghost is mid-hop so the pack reads
      v.mode = RiderMode.AIR;
      v.y -= 45 + i * 6;
      v.crouch = 0.2;
    }
    if (i > 0) v.scarf = 0.3 + ((i * 0.37) % 0.7);
    return viewOf(v, i === 0 ? 'local' : `g${i}`, i, i === 0);
  };

  // ---- scripted sequences (pose mode): landing / sliding crash / pit rescue ----
  // rel = ms relative to the key moment (touchdown, crash, lift start)
  const SEQ = ['land', 'crashslide', 'rescue'];
  const seqMode = SEQ.includes(Q.get('mode')) ? Q.get('mode') : null;
  const seqRel = () => num(seqMode === 'land' ? 'lt' : seqMode === 'crashslide' ? 'ct' : 'ru', 0);
  let seqChasm = null;
  if (seqMode === 'rescue') {
    const x = num('x', course.startX + 500);
    seqChasm = course.features.filter((f) => f.type === FeatureType.CHASM).sort((a, b) => Math.abs(a.x0 - x) - Math.abs(b.x0 - x))[0];
  }
  const seqView = (rel, i) => {
    const speed = num('speed', 520);
    const X0 = num('x', course.startX + 500) + (i ? -95 * i : 0);
    const id = i === 0 ? 'local' : `g${i}`;
    const base = { mode: RiderMode.GROUND, crouch: 0.1, scarf: num('scarf', 0.7), boostT: 0, boostLevel: 0, shield: false, hoverT: 0 };
    let st;
    if (seqMode === 'land') {
      const x = X0 + (speed * rel) / 1000;
      const ang = Math.atan(course.slopeAt(x));
      if (rel < 0) {
        const tau = -rel / 1000;
        const vy = 420 + 300 * num('impact', 0.7);
        const h = vy * tau - 0.5 * 1200 * tau * tau * 0.4;
        st = { ...base, mode: RiderMode.AIR, x, y: surfaceY(course, x) - Math.max(0, h), vx: speed, vy, angle: ang + (num('tilt', 12) * Math.PI) / 180 * Math.min(1, tau * 3 + 0.4), crouch: 0.25 };
      } else {
        const v = speed * 0.92;
        st = { ...base, x, y: course.heightAt(x), vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, angle: ang, crouch: Math.max(0.1, 0.8 * Math.exp(-rel / 160) * num('impact', 0.7)) };
      }
    } else if (seqMode === 'crashslide') {
      const T = rel / 1000;
      const decay = Math.exp(-Math.max(0, T) / 0.9);
      const dist = rel < 0 ? (speed * rel) / 1000 : speed * 0.9 * (1 - decay);
      const x = X0 + dist;
      const ang = Math.atan(course.slopeAt(x));
      const v = rel < 0 ? speed : speed * decay;
      if (rel < 0) st = { ...base, x, y: course.heightAt(x), vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, angle: ang };
      else if (T < 1.3) st = { ...base, mode: RiderMode.CRASHED, x, y: course.heightAt(x), vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, angle: ang + 9 * (1 - decay) * 0.9, crouch: 0.6 };
      else st = { ...base, x, y: course.heightAt(x), vx: Math.cos(ang) * Math.max(v, 140), vy: Math.sin(ang) * Math.max(v, 140), angle: ang, crouch: 0.4 * Math.exp(-(T - 1.3) / 0.3) };
    } else {
      // rescue: from the pit up and over to the far lip in 3 s
      const c = seqChasm;
      const u = rel / 3000;
      const ya = Number.isFinite(c.y0) ? c.y0 : course.heightAt(c.x0 - 1);
      const yb = Number.isFinite(c.y1) ? c.y1 : course.heightAt(c.x1 + 1);
      if (u < 0) {
        const x = c.x0 + 40 + u * 400;
        st = { ...base, mode: RiderMode.AIR, x, y: ya + 80 + u * 260, vx: 400, vy: 600, angle: 0.5 };
      } else if (u <= 1) {
        const e = u * u * (3 - 2 * u);
        const x = c.x0 + 40 + (c.x1 + 40 - (c.x0 + 40)) * e;
        const lift = Math.sin(Math.PI * Math.min(1, u * 1.05)) * 170;
        const y = ya + 80 + (yb - (ya + 80)) * Math.min(1, u * 1.3) - lift;
        st = { ...base, mode: RiderMode.RESCUE, x, y, vx: 120, vy: -40, angle: 0.2 };
      } else {
        const x = c.x1 + 40 + (u - 1) * 600;
        const ang = Math.atan(course.slopeAt(x));
        st = { ...base, x, y: course.heightAt(x), vx: Math.cos(ang) * 300, vy: Math.sin(ang) * 300, angle: ang };
      }
    }
    return viewOf(st, id, i, i === 0);
  };
  const seqEvent = (prevRel, rel) => {
    if (prevRel >= 0 || rel < 0) return null;
    if (seqMode === 'land') return { type: SimEvent.LAND, data: { clean: Q.get('sketchy') !== '1', sketchy: Q.get('sketchy') === '1', impact: num('impact', 0.7) } };
    if (seqMode === 'crashslide') return { type: SimEvent.CRASH, data: { cause: 'landing' } };
    return { type: SimEvent.RESCUE_START, data: { featureId: seqChasm?.id, duration: 3, toX: seqChasm?.x1, toY: 0 } };
  };

  // ---- p5 ----
  const perfEl = document.getElementById('perf');
  const showPerf = Q.get('perf') === '1';
  if (showPerf) perfEl.style.display = 'block';
  const samples = [];
  const frameGaps = [];
  let lastNow = 0;
  window.__perf = null;
  window.__info = { usingReal, useSim: !!useSim };

  // eslint-disable-next-line no-undef
  new p5((p) => {
    let renderer;
    let raceMs = 0;
    let acc = 0;
    p.setup = () => {
      p.createCanvas(window.innerWidth, window.innerHeight);
      p.pixelDensity(Math.min(2, num('dpr', window.devicePixelRatio || 1)));
      renderer = new Renderer(p, course);
      renderer.camera.debugZoom = num('camzoom', 1);
      window.__renderer = renderer;
      if (freeze) {
        p.noLoop();
        renderFrozen();
      }
    };

    const framePose = (timeMs, dtMs, events) => {
      const x = num('x', course.startX + 500);
      const local = poseView(x, 0, timeMs);
      const others = [];
      for (let i = 1; i <= nGhosts; i++) others.push(poseView(x, i, timeMs));
      return { timeMs, dtMs, local, others, events, phase: 'racing', cinematic: Q.get('cinematic') === '1' };
    };

    const frameSim = (timeMs, dtMs) => {
      const local = viewOf(riders[0].sim.state, 'local', 0, true);
      const others = riders.slice(1).map((r, i) => viewOf(r.sim.state, `g${i + 1}`, i + 1, false));
      const events = pendingEvents;
      pendingEvents = [];
      return { timeMs, dtMs, local, others, events, phase: 'racing', cinematic: Q.get('cinematic') === '1' };
    };

    const eventFor = (name, v) => {
      switch (name) {
        case 'land': return { type: SimEvent.LAND, data: { clean: true, impact: 0.9 } };
        case 'crash': return { type: SimEvent.CRASH, data: { cause: 'landing', x: v.x, y: v.y } };
        case 'smash': {
          // smash the nearest solid obstacle ahead (hidden from then on)
          const solid = ['rock', 'log', 'snowman', 'spikes', 'campfire'];
          const f = course.featuresIn(v.x - 50, v.x + 400).find((o) => solid.includes(o.type));
          return f ? { type: SimEvent.ROCK_SMASH, data: { featureId: f.id, x: f.x, y: course.heightAt(f.x) } } : { type: SimEvent.ROCK_SMASH, data: { featureId: -1, x: v.x + 30, y: course.heightAt(v.x + 30) } };
        }
        case 'combo': return { type: SimEvent.COMBO, data: { points: 100, mult: 2, total: 200, tricks: ['backflip'] } };
        case 'pickup': return { type: SimEvent.PICKUP, data: { featureId: -1, kind: 'coin', x: v.x + 10, y: v.y - 30 } };
        case 'boost': return { type: SimEvent.BOOST, data: { level: num('level', 2), duration: 3 } };
        case 'jump': return { type: SimEvent.JUMP, data: {} };
        case 'finish': return { type: SimEvent.FINISH, data: { tick: 0, timeMs: 0 } };
        default: return null;
      }
    };

    /** Deterministic warm-up: 1.5 s of frames at a fixed 60 Hz ending exactly at t. */
    const renderFrozen = () => {
      const warm = num('warm', 1500);
      const dtMs = 1000 / 60;
      const t0 = pose ? targetMs - warm : Math.max(0, targetMs - warm);
      if (seqMode) {
        const frames = Math.round(warm / dtMs);
        const endRel = seqRel();
        let prevRel = -1e9;
        for (let k = 0; k <= frames; k++) {
          const rel = endRel - (frames - k) * dtMs;
          const local = seqView(rel, 0);
          const others = [];
          for (let i = 1; i <= nGhosts; i++) others.push(seqView(rel + 120 * i, i));
          const ev = seqEvent(prevRel, rel);
          prevRel = rel;
          renderer.draw({ timeMs: t0 + k * dtMs, dtMs, local, others, events: ev ? [ev] : [], phase: 'racing' });
        }
      } else if (pose) {
        const x = num('x', 0);
        const speed = num('speed', 500);
        const frames = Math.round((targetMs - t0) / dtMs);
        const evName = Q.get('event');
        for (let k = 0; k <= frames; k++) {
          const tm = t0 + k * dtMs;
          // ride into x over the warm-up so scarf/spray are "live"
          const back = ((frames - k) * dtMs) / 1000;
          Q.set('x', String(x - speed * back * 0.98));
          const f = framePose(tm, dtMs, []);
          if (evName && k === frames - num('evframes', 14)) {
            const e = eventFor(evName, f.local);
            if (e) f.events.push(e);
          }
          renderer.draw(f);
        }
        Q.set('x', String(x));
      } else {
        // simulate up to t0, then render the last 1.5 s
        const t0Tick = Math.floor(t0 / TICK_MS);
        while (tick < t0Tick) stepAll();
        pendingEvents = [];
        if (Q.has('pit') && useSim) {
          // drop the local rider at the lip of the nth pit, slowly: the real sim's RESCUE takes over
          const ch = course.features.filter((f) => f.type === FeatureType.CHASM)[num('pit', 0)];
          const st = riders[0].sim.state;
          riders[0].mute = true;
          if (ch) Object.assign(st, { x: ch.x0 - 4, y: course.heightAt(ch.x0 - 4), vx: 90, vy: 10, mode: RiderMode.GROUND, angle: Math.atan(course.slopeAt(ch.x0 - 4)) });
        }
        const endTick = Math.floor(targetMs / TICK_MS);
        while (tick < endTick) {
          stepAll();
          renderer.draw(frameSim(tick * TICK_MS, TICK_MS));
        }
        if (tick === t0Tick) renderer.draw(frameSim(tick * TICK_MS, TICK_MS));
      }
      window.__ready = true;
      document.title = 'ready';
    };

    p.draw = () => {
      // p5 calls draw() once after setup even with noLoop(): a frozen frame must stay as rendered
      if (freeze) return;
      const now = performance.now();
      const dtMs = lastNow ? Math.min(100, now - lastNow) : 16.7;
      if (lastNow) frameGaps.push(now - lastNow);
      lastNow = now;
      let f;
      if (pose) {
        raceMs += dtMs * rate;
        if (raceMs < targetMs) raceMs = targetMs;
        // in live pose mode the rider moves forward from x
        const x0 = num('x', 0);
        f = framePose(raceMs, dtMs, []);
        Q.set('x', String(x0));
        void x0;
      } else {
        if (raceMs === 0 && targetMs > 0) {
          const tt = Math.floor(targetMs / TICK_MS);
          while (tick < tt) stepAll();
          pendingEvents = [];
          raceMs = tick * TICK_MS;
        }
        acc += dtMs * rate;
        while (acc >= TICK_MS) {
          acc -= TICK_MS;
          stepAll();
        }
        raceMs = tick * TICK_MS;
        f = frameSim(raceMs, dtMs);
      }
      renderer.draw(f);
      samples.push(renderer.lastDrawMs);
      if (samples.length > 240) samples.shift();
      if (frameGaps.length > 240) frameGaps.shift();
      if (p.frameCount % 15 === 0) {
        const s = [...samples].sort((a, b) => a - b);
        const g = [...frameGaps].sort((a, b) => a - b);
        const avg = s.reduce((a, b) => a + b, 0) / s.length;
        const gavg = g.reduce((a, b) => a + b, 0) / Math.max(1, g.length);
        window.__perf = { drawAvg: avg, drawP95: s[Math.floor(s.length * 0.95)] || 0, frameAvg: gavg, frameP95: g[Math.floor(g.length * 0.95)] || 0, fps: 1000 / gavg, n: s.length };
        if (showPerf) {
          const a = renderer.atmosphere;
          perfEl.textContent =
            `draw  ${avg.toFixed(2)} ms  p95 ${window.__perf.drawP95.toFixed(2)}\n` +
            `frame ${gavg.toFixed(2)} ms  (${(1000 / gavg).toFixed(0)} fps)\n` +
            `${p.width}x${p.height} @${p.pixelDensity()}  particles ${renderer.particles.alive}\n` +
            `t ${(raceMs / 1000).toFixed(1)}s  hour ${a.hour.toFixed(1)}  ${a.weather} ${a.weatherAmt.toFixed(2)}\n` +
            `${usingReal ? 'real course' : 'mock course'} / ${useSim ? 'RiderSim+Bot' : pose ? 'pose' : 'mock rider'}`;
        }
      }
    };

    p.windowResized = () => {
      p.resizeCanvas(window.innerWidth, window.innerHeight);
      renderer.resize(p.width, p.height);
      if (freeze) renderFrozen();
    };
  });
}

main();
void TICK_DT;
