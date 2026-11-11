/**
 * Renderer — draws one frame of the world. Contract: see src/contracts.js.
 *
 * Back to front:
 *   sky gradient · stars · sun/moon · high clouds · lightning sky flash
 *   5 ridge layers (cached tinted strips) with valley mist + clouds between
 *   back decor (depth > 0) · snow body (gradient follows the surface) · chasms · lip
 *   features · decor on the line · warm glows (additive)
 *   ghosts · local rider (last) · particles · pickups
 *   front decor (depth < 0) · fog · huge foreground pines · precipitation
 *   boost streaks / warmth · vignette · lightning white-out · name tags
 *
 * Everything ambient runs off frame.timeMs so clients (and screenshots) agree.
 * Uses the raw Canvas2D context (p.drawingContext) for speed; p5 is only the host.
 *
 * Performance
 *   The whole background (sky, sun/moon, clouds, 5 ridge layers, mist, valley haze) is drawn
 *   into an offscreen buffer at reduced resolution (≤ 1 CSS px per px, lower on weak devices)
 *   and blitted once; only the playfield is drawn at full pixel density.
 *
 * Quality API (for the settings UI)
 *   renderer.quality            → { mode, level, name, pixelDensity, fps }   (read-only snapshot)
 *   renderer.setQuality(mode)   mode: 'auto' (default) | 'high' | 'medium' | 'low'
 *   In 'auto' a governor watches the smoothed frame time and steps through QUALITY_LEVELS
 *   (pixel density 2 → 1.5 → 1.25 → 1 → 0.75 → 0.6, then particles, foreground pines, weather density,
 *   fog bands, vignette, background resolution) to hold ~60 fps, with hysteresis: it steps down
 *   after ~0.7 s over budget, up only after ~4 s with headroom, and backs off from a level that
 *   failed (10 s, doubling). It starts conservatively at density min(devicePixelRatio, 1.5).
 *   renderer.setFrameInterval(ms)  the frame budget the caller is drawing at (default 16.7; e.g. 33.3
 *                                  for a 30 fps menu backdrop): the governor steps down above ~1.17×
 *                                  that budget and up below ~1.03× with draw-time headroom.
 *   renderer.setReducedEffects(on) calm mode for players who want less motion: no camera shake,
 *                                  landing dip or boost zoom pulse / radial burst, lightning is a soft
 *                                  sky brightening instead of a white-out, gentler confetti; the scarf
 *                                  glow and a mild boost streak remain.
 */
import { clamp, smoothstep } from '../math/utils.js';
import { BODY_CENTER } from '../math/physics.js';
import { RiderMode, SimEvent } from '../contracts.js';
import { sampleAtmosphere } from './DayCycle.js';
import { Camera } from './Camera.js';
import { Sky } from './Sky.js';
import { Parallax } from './Parallax.js';
import { TerrainRenderer, surfaceY } from './TerrainRenderer.js';
import { DecorRenderer, FESTIVE } from './DecorRenderer.js';
import { FeatureRenderer, isGroundIce } from './FeatureRenderer.js';
import { RiderRenderer } from './RiderRenderer.js';
import { Particles, PK } from './Particles.js';
import { Weather } from './Weather.js';
import { Effects } from './Effects.js';
import { hex, mix, rgba, scale } from './color.js';
import { makeCanvas, sizeCanvas } from './canvas.js';

const DECOR_MARGIN = 420;

/** Quality ladder, best first. dens = max pixel density; bg = background buffer scale (CSS px). */
export const QUALITY_LEVELS = Object.freeze([
  { name: 'high', dens: 2, bg: 1, particles: 1, fg: true, weather: 1, vignette: true, fog: true, cols: 10 },
  { name: 'high-1.5x', dens: 1.5, bg: 1, particles: 1, fg: true, weather: 1, vignette: true, fog: true, cols: 10 },
  { name: 'medium', dens: 1.25, bg: 0.8, particles: 0.8, fg: true, weather: 0.8, vignette: true, fog: true, cols: 12 },
  { name: 'medium-1x', dens: 1, bg: 0.7, particles: 0.6, fg: true, weather: 0.7, vignette: true, fog: true, cols: 14 },
  { name: 'low', dens: 1, bg: 0.55, particles: 0.4, fg: false, weather: 0.5, vignette: false, fog: false, cols: 18 },
  { name: 'lowest', dens: 0.75, bg: 0.45, particles: 0.3, fg: false, weather: 0.35, vignette: false, fog: false, cols: 24 },
  // last resort for machines without GPU canvas (software raster)
  { name: 'minimal', dens: 0.6, bg: 0.35, particles: 0.25, fg: false, weather: 0.25, vignette: false, fog: false, cols: 32 },
]);
const MODE_LEVEL = { high: 0, medium: 2, low: 4 };
/** Fonts are set once per pass (assigning ctx.font is a style parse each time). */
const BOARD_FONT = '800 15px system-ui, -apple-system, "Segoe UI", sans-serif';
const TAG_FONT = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
const MARKER_FONT = '700 12px system-ui, -apple-system, "Segoe UI", sans-serif';
const HAZARDS = new Set(['rock', 'log', 'snowman', 'spikes', 'campfire']); // world px: widest decor, so nothing pops in at the edges
const MAX_GLOWS = 64;

export class Renderer {
  /** @param {import('p5')} p @param {import('../contracts.js').Course} course */
  constructor(p, course) {
    this.p = p;
    this.camera = new Camera();
    this.sky = new Sky(course?.seed ?? 1);
    this.parallax = new Parallax(course?.seed ?? 1);
    this.terrain = new TerrainRenderer();
    this.decor = new DecorRenderer();
    this.features = new FeatureRenderer();
    this.riders = new RiderRenderer();
    this.particles = new Particles();
    this.weather = new Weather();
    this.effects = new Effects();
    /** feature ids the LOCAL rider collected / smashed, tracked from PICKUP / ROCK_SMASH events (reset on setCourse) */
    this.consumed = new Set();
    this.flyers = [];
    this.trail = { x: new Float32Array(64), y: new Float32Array(64), age: new Float32Array(64), n: 0 };
    this.atmosphere = sampleAtmosphere(0, course);
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.forceTint = true;
    this.boostFx = 0;
    this.pulse = 0;
    this.emit = { spray: 0, sparkle: 0, ember: 0, feather: 0, ghost: 0 };
    this.prevLocal = null;
    this.glows = { n: 0, x: new Float32Array(MAX_GLOWS), y: new Float32Array(MAX_GLOWS), r: new Float32Array(MAX_GLOWS), a: new Float32Array(MAX_GLOWS), c: new Array(MAX_GLOWS) };
    /** last frame's CPU time for the draw call, ms */
    this.lastDrawMs = 0;
    // background buffer + quality governor
    this.bg = makeCanvas(1, 1);
    this.bgCtx = this.bg.getContext('2d');
    this.qMode = 'auto';
    const deviceDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.deviceDpr = Math.min(2, deviceDpr);
    this.level = this.deviceDpr >= 1.5 ? 1 : 0;
    this.gov = { ft: 0, lastNow: 0, since: 0, blocked: new Float64Array(QUALITY_LEVELS.length), backoff: 10000 };
    this.quality = { mode: 'auto', level: this.level, name: QUALITY_LEVELS[this.level].name, pixelDensity: 0, fps: 0 };
    this.setCourse(course);
    this.resize(p.width, p.height);
  }

  setCourse(course) {
    this.course = course;
    this.sky.setSeed(course?.seed ?? 1);
    this.parallax.setSeed(course?.seed ?? 1);
    this.consumed.clear();
    this.flyers.length = 0;
    if (this.trail) this.trail.n = 0;
    this.camera.rescueSpan = null;
    this.riders.reset();
    this.riders.groundAt = course ? (x) => surfaceY(course, x) : null;
    this.riders.surfaceAt = course ? (x) => course.heightAt(x) : null;
    // take-off puff for every rider, scaled by speed
    this.riders.onTakeoff = (v) => {
      const sp = Math.hypot(v.vx, v.vy);
      const ps = this.particles;
      const n = Math.round((v.isLocal ? 6 : 3) + (v.isLocal ? 1 : 0.4) * sp / 70);
      for (let i = 0; i < n; i++) ps.spawn(PK.PUFF, v.x + ps.rand(-10, 6), v.y - ps.rand(0, 3), v.vx * ps.rand(0.05, 0.3) + ps.rand(-40, 30), -ps.rand(30, 90) - sp * ps.rand(0.03, 0.1), ps.rand(0.35, 0.75), ps.rand(1.6, 3.8) * (0.8 + sp / 1400), 0, 400, 3);
    };
    this.particles.reset();
    this.camera.initialized = false;
    this.forceTint = true;
    if (this.height) this.parallax.build(this.height, this.dpr);
  }

  resize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = this.p.pixelDensity ? this.p.pixelDensity() : 1;
    this.camera.resize(this.width, this.height);
    // ridge strips are drawn into the ≤ 1x background buffer: build at 1x, only when the height changes
    if (this.parallax.h !== this.height) {
      this.parallax.build(this.height, 1);
      this.forceTint = true;
    }
    this.effects.resize(this.width, this.height);
  }

  worldToScreen(x, y) {
    return this.camera.worldToScreen(x, y);
  }

  /** Frame budget in ms the caller draws at (see the header). */
  setFrameInterval(ms) {
    const budget = Number.isFinite(ms) && ms > 4 ? ms : 16.7;
    // Callers may set this every frame: only a real change restarts the governor's measurement.
    if (budget === this.frameBudget) return;
    this.frameBudget = budget;
    this.gov.since = 0;
    this.gov.ft = this.frameBudget;
  }

  /** Calm mode: less motion (see the header). */
  setReducedEffects(on) {
    this.reduced = !!on;
    this.camera.reduced = this.reduced;
  }

  /** 'auto' | 'high' | 'medium' | 'low' — see the header. */
  setQuality(mode) {
    this.qMode = mode in MODE_LEVEL || mode === 'auto' ? mode : 'auto';
    if (this.qMode !== 'auto') this.level = MODE_LEVEL[this.qMode];
    this.gov.since = 0;
    this.quality.mode = this.qMode;
  }

  /** Frame-time governor + pixel density application. Runs at the start of every frame. */
  govern() {
    const g = this.gov;
    const now = performance.now();
    const gap = g.lastNow ? now - g.lastNow : 16.7;
    g.lastNow = now;
    if (gap < 250) {
      g.ft = g.ft ? g.ft + (gap - g.ft) * 0.08 : gap;
      g.since += gap;
    }
    const max = QUALITY_LEVELS.length - 1;
    if (this.qMode === 'auto' && g.since > 700) {
      const budget = this.frameBudget || 16.7;
      if (g.ft > budget * 1.17 && this.level < max) {
        // over budget: step down, and keep away from the failed level for a while (doubling)
        g.blocked[this.level] = now + g.backoff;
        g.backoff = Math.min(60000, g.backoff * 2);
        this.level++;
        g.since = 0;
        g.ft = budget;
      } else if (g.ft < budget * 1.03 && this.lastDrawMs < budget * 0.42 && g.since > 4000 && this.level > 0 && now > g.blocked[this.level - 1]) {
        this.level--;
        g.since = 0;
      }
    }
    const q = QUALITY_LEVELS[this.level];
    const want = Math.max(0.5, Math.min(q.dens, this.deviceDpr));
    const p = this.p;
    if (p.pixelDensity && Math.abs(p.pixelDensity() - want) > 0.01) p.pixelDensity(want);
    this.particles.budget = q.particles;
    this.terrain.colW = q.cols;
    const Q = this.quality;
    Q.mode = this.qMode;
    Q.level = this.level;
    Q.name = q.name;
    Q.pixelDensity = p.pixelDensity ? p.pixelDensity() : 1;
    Q.fps = g.ft ? Math.round(1000 / g.ft) : 0;
    return q;
  }

  /**
   * Draws one frame. Never throws: a renderer bug must not freeze the game
   * (the error is logged once per message and the canvas state is restored).
   * @param {import('../contracts.js').RenderFrame} frame
   */
  draw(frame) {
    const ctx = this.p.drawingContext;
    this._saved = false;
    try {
      this.drawFrame(frame);
    } catch (e) {
      if (this._saved) ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowBlur = 0;
      this._errors = this._errors || new Set();
      if (!this._errors.has(e.message)) {
        this._errors.add(e.message);
        console.error('[Renderer] frame skipped:', e);
      }
    }
  }

  drawFrame(frame) {
    const t0 = performance.now();
    const { p, course, camera: cam } = this;
    if (!course) return;
    const Qy = this.govern();
    if (p.width !== this.width || p.height !== this.height || (p.pixelDensity && p.pixelDensity() !== this.dpr)) this.resize(p.width, p.height);
    const ctx = p.drawingContext;
    const dpr = this.dpr;
    const dt = clamp((frame.dtMs ?? 16.7) / 1000, 0, 0.1);
    const t = frame.timeMs / 1000;
    const local = frame.local;
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return;
    const atm = sampleAtmosphere(frame.timeMs, course);
    this.atmosphere = atm;

    if (local.mode !== RiderMode.RESCUE) cam.rescueSpan = null;
    else if (!cam.rescueSpan) {
      const f = this.chasmNear(local.x);
      if (f) cam.rescueSpan = this.spanOf(f);
    }
    // spectate: follow another rider when the frame asks for it (focusId), local otherwise
    const others = frame.others || [];
    let focus = null;
    if (frame.focusId != null) for (const o of others) if (o.id === frame.focusId && Number.isFinite(o.x) && Number.isFinite(o.y)) focus = o;
    const subject = focus || local;
    cam.update(subject, course, dt, frame.timeMs, !!frame.cinematic);
    const P = this.palette(atm, t);
    P.riderX = local.x;
    P.riderV = Math.hypot(local.vx, local.vy);
    this.handleEvents(frame.events || [], local, P);

    const w = this.width;
    const h = this.height;
    const groundAtCam = course.heightAt(clamp(cam.x, course.minX, course.maxX));
    const L = {
      w,
      h,
      t,
      horizonY: h * 0.7,
      camX: cam.x,
      camY: cam.y,
      camVx: local.vx,
      baseScale: cam.baseScale,
      zoom: cam.zoom,
      vshift: clamp((groundAtCam - cam.y) * cam.baseScale - 60, -200, 900) * 0.4,
      dpr,
    };

    ctx.save();
    this._saved = true;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;

    this.mark('start');
    // ---- background (into the reduced-resolution buffer) ----
    const bs = Math.min(1, this.dpr) * Qy.bg;
    sizeCanvas(this.bg, w * bs, h * bs);
    const bctx = this.bgCtx;
    bctx.setTransform(this.bg.width / w, 0, 0, this.bg.height / h, 0, 0);
    bctx.globalAlpha = 1;
    bctx.globalCompositeOperation = 'source-over';
    // ---- sky ----
    this.sky.stormDim = atm.weather === 'storm' ? Math.max(0, 1 - 1.1 * atm.weatherAmt) : atm.weather === 'fog' ? 1 - 0.5 * atm.weatherAmt : 1;
    this.sky.drawGradient(bctx, atm, L);
    this.sky.drawStars(bctx, atm, L);
    this.sky.drawBodies(bctx, atm, L);
    this.sky.drawClouds(bctx, atm, L, 0);
    this.sky.drawBirds(bctx, atm, L);
    if (atm.flash > 0.01) {
      bctx.fillStyle = `rgba(240,244,255,${(this.reduced ? 0.18 : 0.75) * atm.flash})`;
      bctx.fillRect(0, 0, w, L.horizonY + h * 0.1);
    }

    this.mark('sky');
    // ---- distant ridges ----
    this.parallax.update(atm, this.forceTint);
    this.forceTint = false;
    const haze = P.haze;
    const mist = 0.18 + (atm._fog ?? 0) * 0.45 + (atm.weather === 'snow' ? 0.08 * atm.weatherAmt : 0);
    for (let i = 0; i < 5; i++) {
      const { base } = this.parallax.drawLayer(bctx, i, L);
      // valley mist band at the foot of the layer
      const by = base - h * 0.1;
      const bh = h * 0.12;
      const g = bctx.createLinearGradient(0, by - bh, 0, by + bh);
      g.addColorStop(0, rgba(haze, 0));
      g.addColorStop(0.55, rgba(haze, mist * (1 - i * 0.12)));
      g.addColorStop(1, rgba(haze, 0));
      bctx.fillStyle = g;
      bctx.fillRect(0, by - bh, w, bh * 2);
      if (i < 4) this.sky.drawClouds(bctx, atm, L, i + 1);
      if (i === 3) this.drawBeacon(bctx, atm, L, P, cam);
    }
    this.mark('ridges');
    // valley haze rising from below the forest line (depth when the slope is out of view)
    {
      const y0 = h * 0.74 + L.vshift * 0.3;
      const g = bctx.createLinearGradient(0, y0, 0, h);
      g.addColorStop(0, rgba(haze, 0));
      g.addColorStop(1, rgba(haze, 0.42 + (atm._fog ?? 0) * 0.3));
      bctx.fillStyle = g;
      bctx.fillRect(0, y0, w, h - y0);
    }
    // blit the background buffer once, upscaled
    ctx.drawImage(this.bg, 0, 0, this.bg.width, this.bg.height, 0, 0, w, h);

    this.mark('haze');
    // ---- slope ----
    this.terrain.sample(course, cam, L);
    const x0 = cam.worldX(0) - DECOR_MARGIN;
    const x1 = cam.worldX(w) + DECOR_MARGIN;
    const decor = course.decorIn(x0, x1);
    const feats = course.featuresIn(x0, x1);
    this.glows.n = 0;

    // Everything standing IN the snow is drawn before the snow body so the
    // slope itself hides its base (no floating huts on steep sections).
    cam.apply(ctx, dpr);
    // distance boards are drawn after the decor around them so nothing stands in front of them
    const isBoard = (d) => d.type === 'banner' && (d.variant | 0) >= 50;
    this.boardXs = this.boardXs || [];
    this.boardXs.length = 0;
    for (const d of decor) if ((d.depth || 0) > 0 && !isBoard(d)) this.decor.draw(ctx, d, P, course);
    for (const d of decor) if ((d.depth || 0) === 0 && !isBoard(d)) this.decor.draw(ctx, d, P, course);
    ctx.font = BOARD_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of decor) if (isBoard(d)) {
      this.decor.draw(ctx, d, P, course);
      this.boardXs.push(d.x);
    }
    ctx.textAlign = 'start';
    for (const f of feats) if (f.type === 'grind' && !isGroundIce(f, course)) this.features.draw(ctx, f, P, course, this.consumed);
    this.mark('decorBack');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.terrain.drawBody(ctx, atm, cam, L);
    this.mark('terrainBody');
    this.terrain.drawChasms(ctx, atm, cam, L, course);
    this.terrain.drawLip(ctx, atm, cam);

    this.mark('chasmsLip');
    // fog lies over the terrain but UNDER features, riders and pickups: it never veils a hazard
    if (Qy.fog || atm.weather === 'fog') this.weather.drawFog(ctx, atm, L);
    cam.apply(ctx, dpr);
    if (!frame.cinematic) this.drawTrail(ctx, local, dt, P);
    for (const f of feats) if (f.type !== 'pickup' && (f.type !== 'grind' || isGroundIce(f, course))) this.features.draw(ctx, f, P, course, this.consumed);
    this.drawGlows(ctx);
    this.glows.n = 0;

    this.mark('features');
    // ---- riders & effects ----
    this.emitContinuous(frame, dt, P, feats);
    this.particles.update(dt);
    for (const f of feats) if (f.type === 'pickup') this.features.drawPickup(ctx, f, P, this.consumed);
    for (const v of others) if (v !== focus) this.riders.draw(ctx, v, P, dt);
    this.riders.draw(ctx, local, P, dt);
    if (focus) {
      // the followed rider is drawn with local-level prominence, last
      const fv = Object.assign(this._focusView || (this._focusView = {}), focus);
      fv.isLocal = true;
      this.riders.draw(ctx, fv, P, dt);
    }
    this.drawWhooshes(ctx, local, others, dt);
    this.drawAccents(ctx, dt);
    this.riders.drawDeparting(ctx, P, dt);
    this.drawFlyers(ctx, local, dt);
    this.mark('riders');
    this.particles.draw(ctx, P.particleColors);
    this.drawGlows(ctx);
    this.glows.n = 0;
    this.mark('particles');
    for (const d of decor) if ((d.depth || 0) < 0 && !this.boardXs.some((bx) => Math.abs(bx - d.x) < 160)) this.decor.draw(ctx, d, P, course);
    this.drawGlows(ctx);
    this.glows.n = 0;
    this.riders.sweep();

    this.mark('front');
    // ---- screen-space overlays ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    L.weatherScale = Qy.weather;
    this.mark('fog');
    if (Qy.fg) this.effects.drawForeground(ctx, cam, P, L, course.startX, cam.sx(local.x), this.hazardsAhead(local, feats, cam));
    this.mark('fgPines');
    this.weather.drawPrecip(ctx, atm, L);
    this.mark('precip');
    const boostT = local.boostLevel ? (this.reduced ? 0.12 : 0.3) * local.boostLevel : 0;
    this.boostFx += (boostT - this.boostFx) * (1 - Math.exp(-dt * 5));
    this.pulse *= Math.exp(-dt * 4);
    this.effects.drawPost(ctx, atm, P, L, { reduced: !!this.reduced, vignette: Qy.vignette, rx: cam.sx(local.x), ryy: cam.sy(local.y) - 18 * cam.scale, boost: frame.cinematic ? 0 : this.boostFx, pulse: this.pulse, dir: Math.PI + Math.atan2(local.vy, local.vx), ry: cam.sy(local.y) - 20 * cam.scale });

    this.mark('post');
    // name tags of ghosts (not on cinematic screens), staggered when their x-ranges collide;
    // then edge markers for the nearest rider off screen ahead and behind
    if (!frame.cinematic) {
      ctx.font = TAG_FONT;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
      ctx.textBaseline = 'middle';
      this.drawTags(ctx, local, others, focus, cam, P);
      ctx.font = MARKER_FONT;
      this.drawMarkers(ctx, local, others, focus, frame.markers, cam, P, dt, feats);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    this.mark('tags');
    ctx.restore();
    this._saved = false;
    this.lastDrawMs = performance.now() - t0;
  }

  /**
   * Opt-in section profiler (renderer.profile = true): mean ms per section since the previous
   * mark, accumulated in renderer.prof. Free when off.
   */
  mark(name) {
    if (!this.profile) return;
    // force the deferred canvas to rasterise what was recorded so far, so the time is attributed
    this.p.drawingContext.getImageData(0, 0, 1, 1);
    const now = performance.now();
    if (name !== 'start') {
      const pr = (this.prof = this.prof || {});
      const e = (pr[this._markName] = pr[this._markName] || { ms: 0, n: 0 });
      e.ms += now - this._markT;
      e.n++;
    }
    this._markName = name;
    this._markT = now;
  }

  /** Per-frame palette as numeric arrays (parsed once). */
  palette(atm, t) {
    const sil = hex(atm.silhouette);
    const haze = hex(atm.skyBottom);
    const night = atm.night;
    const snow = hex(atm.snow);
    const shade = hex(atm.snowShade);
    const accent = hex(atm.accent);
    const ridge4 = hex(atm.ridges[4]);
    const deep = scale(sil, 0.6);
    const lights = smoothstep(0.25, 0.8, night) + (atm.weather === 'storm' ? 0.4 * atm.weatherAmt : 0);
    const festive = FESTIVE.map((c) => mix(mix(c, sil, 0.12 + 0.45 * night), haze, 0.08));
    const P = {
      t,
      night,
      sil,
      haze,
      snow,
      shade,
      accent,
      deep,
      lights: clamp(lights, 0, 1),
      rockDark: mix(sil, ridge4, 0.22),
      rockLit: mix(sil, ridge4, 0.55),
      shadeDeep: mix(shade, sil, 0.45),
      bark: mix([96, 62, 44], sil, 0.3 + 0.45 * night),
      wood: mix([222, 182, 132], sil, 0.15 + 0.5 * night),
      festive,
      wind: atm.weather === 'storm' ? atm.weatherAmt : atm.weather === 'snow' ? atm.weatherAmt * 0.4 : 0,
      glow: this.glowFn || (this.glowFn = (x, y, r, a, c) => this.pushGlow(x, y, r, a, c)),
    };
    // particle colours: 0 snow, 1 shade, 2 rock, 3 warm, 4 white, 5 gold, 6 local player
    P.particleColors = [rgba(mix(snow, [255, 255, 255], 0.3)), rgba(mix(snow, shade, 0.5)), rgba(P.rockDark), rgba([255, 170, 70]), '#ffffff', '#ffd75a', this.prevLocal?.color || '#ffffff', ...FESTIVE.map((c) => rgba(mix(c, sil, 0.1 + 0.3 * night))), rgba(P.bark), rgba(mix(snow, [150, 215, 245], 0.55))];
    P.accentGlow = accent;
    return P;
  }

  pushGlow(x, y, r, a, c) {
    const g = this.glows;
    if (g.n >= MAX_GLOWS || !(a > 0.01) || !Number.isFinite(x) || !Number.isFinite(y) || !(r > 0)) return;
    g.x[g.n] = x;
    g.y[g.n] = y;
    g.r[g.n] = r;
    g.a[g.n] = a;
    g.c[g.n] = c || null;
    g.n++;
  }

  /** Additive warm glows queued by decor/features (world transform applied): cached tinted sprites. */
  drawGlows(ctx) {
    const g = this.glows;
    if (!g.n) return;
    const acc = hex(this.atmosphere.accent);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < g.n; i++) {
      const spr = this.glowSprite(g.c[i] || acc);
      ctx.globalAlpha = Math.min(1, g.a[i]);
      ctx.drawImage(spr, g.x[i] - g.r[i], g.y[i] - g.r[i], g.r[i] * 2, g.r[i] * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Radial glow sprite for a colour (quantised; small LRU-ish cache). */
  glowSprite(c) {
    const key = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
    const cache = (this.glowCache = this.glowCache || new Map());
    let spr = cache.get(key);
    if (spr) return spr;
    if (cache.size > 48) cache.clear();
    spr = makeCanvas(64, 64);
    const x = spr.getContext('2d');
    const grad = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba(c, 0.55));
    grad.addColorStop(0.35, rgba(c, 0.18));
    grad.addColorStop(1, rgba(c, 0));
    x.fillStyle = grad;
    x.fillRect(0, 0, 64, 64);
    cache.set(key, spr);
    return spr;
  }

  handleEvents(events, local, P) {
    const ps = this.particles;
    const course = this.course;
    const cam = this.camera;
    for (const e of events) {
      const d = e.data || {};
      const x = d.x ?? local.x;
      const y = d.y ?? local.y;
      switch (e.type) {
        case SimEvent.LAND: {
          const k = clamp(d.impact ?? 0.4, 0, 1);
          const sketchy = !!d.sketchy || d.clean === false;
          this.landingFx(local, k, sketchy);
          this.riders.landed(local.id, k, sketchy);
          // weight: a tiny downward settle of the frame (≤ 6 px), no shake on a normal landing
          cam.dip(6 * k);
          if (sketchy) cam.addShake(1 + 1.5 * k);
          break;
        }
        case SimEvent.RESCUE_START: {
          // puff at the pit edge, then the camera frames both lips
          this.burst(local.x, local.y, 22, 180, 0);
          this.particles.spawn(PK.RING, local.x, local.y - 10, 0, 0, 0.6, 46, 4, 0, 0);
          const f = this.featureById(d.featureId, local.x) || this.chasmNear(local.x);
          cam.rescueSpan = f ? this.spanOf(f) : null;
          if (f) this.pushAccent(f.x0, Number.isFinite(f.y0) ? f.y0 : course.heightAt(f.x0 - 1), 46);
          break;
        }
        case SimEvent.CRASH:
          this.accentFeature(d.cause, Number.isFinite(d.x) ? d.x : local.x);
          if (d.cause === 'log' || d.cause === 'snowman' || d.cause === 'spikes') this.obstacleFx(d.cause, x, y, local, 0.6);
          this.burst(x, y, 40, 300, 0);
          this.burst(x, y, 14, 160, 1);
          cam.addShake(6);
          break;
        case SimEvent.ROCK_SMASH: {
          if (d.featureId != null) this.consumed.add(d.featureId);
          const f = this.featureById(d.featureId, x);
          if (f && (f.type === 'log' || f.type === 'snowman' || f.type === 'spikes')) {
            this.obstacleFx(f.type, f.x, this.course.heightAt(f.x), local, 1);
            cam.addShake(3);
            break;
          }
          if (f && f.type === 'campfire') {
            // shield through a campfire: logs scatter, embers burst, a puff of smoke
            for (let i = 0; i < 26; i++) ps.spawn(PK.EMBER, x + ps.rand(-10, 10), y - ps.rand(4, 20), local.vx * 0.3 + ps.rand(-160, 160), ps.rand(-320, -60), ps.rand(0.5, 1.2), ps.rand(1.6, 3), 3, 500, 1);
            this.burst(x, y - 6, 14, 160, 1);
            cam.addShake(2.5);
            break;
          }
          for (let i = 0; i < 16; i++) ps.spawn(PK.SHARD, x + ps.rand(-8, 8), y - ps.rand(5, 20), local.vx * 0.4 + ps.rand(-160, 220), ps.rand(-380, -80), ps.rand(0.6, 1.1), ps.rand(3, 7), 2, 1100, 0.6);
          this.burst(x, y - 8, 18, 200, 0);
          cam.addShake(3);
          break;
        }
        case SimEvent.PICKUP:
          if (d.featureId != null) this.consumed.add(d.featureId);
          if (!Number.isFinite(x) || !Number.isFinite(y)) break;
          // magnet: far coins fly to the rider and pop on arrival
          if (d.kind === 'coin' && Math.hypot(x - local.x, y - (local.y - BODY_CENTER)) > 45) {
            if (this.flyers.length < 40) this.flyers.push({ x, y, age: 0 });
            break;
          }
          ps.spawn(PK.RING, x, y, 0, 0, 0.45, 26, d.kind === 'coin' ? 5 : 4, 0, 0);
          for (let i = 0; i < (d.kind === 'coin' ? 5 : 12); i++) ps.spawn(PK.SPARKLE, x + ps.rand(-10, 10), y + ps.rand(-10, 10), ps.rand(-60, 60), ps.rand(-90, 20), ps.rand(0.35, 0.7), ps.rand(3, 6), d.kind === 'coin' ? 5 : 4, 0, 2);
          break;
        case SimEvent.BOOST: {
          const lv = clamp(d.level || 1, 1, 3);
          this.pulse = Math.max(this.pulse, this.reduced ? 0.08 : 0.25 + 0.15 * lv);
          cam.kick(0.035 + 0.035 * lv);
          if (!this.reduced) this.effects.burstAt(lv, P.t);
          this.riders.flare(local.id, lv);
          this.burst(local.x, local.y, 10 + 10 * lv, 160 + 60 * lv, 0);
          for (let i = 0; i < 12 + 12 * lv; i++) {
            const a = ps.rand(0, Math.PI * 2);
            const s = ps.rand(80, 260);
            ps.spawn(PK.SPARKLE, local.x, local.y - 20, Math.cos(a) * s, Math.sin(a) * s, ps.rand(0.4, 0.9), ps.rand(3, 7), i % 2 ? 4 : 6, 0, 3);
          }
          break;
        }
        case SimEvent.COMBO:
          // banked trick on landing: a small sparkle ring at the board
          ps.spawn(PK.RING, local.x, local.y - 4, 0, 0, 0.4, 30, 4, 0, 0);
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            ps.spawn(PK.SPARKLE, local.x + Math.cos(a) * 14, local.y - 6 + Math.sin(a) * 6, Math.cos(a) * 70, Math.sin(a) * 30 - 30, 0.45, 3.5, i % 2 ? 4 : 5, 0, 2);
          }
          break;
        case SimEvent.JUMP:
          // the take-off puff comes from the riders' take-off hook (scaled by speed)
          break;
        case SimEvent.GRIND_START:
          for (let i = 0; i < 10; i++) ps.spawn(PK.SPARK, local.x, local.y, local.vx * 0.3 + ps.rand(-120, 80), ps.rand(-200, -40), ps.rand(0.2, 0.45), 1.4, 3, 900, 1);
          break;
        case SimEvent.FINISH: {
          // confetti from the finish arch banner, mostly in the rider's colour
          const ax = course.finishX + 75;
          const ay = course.heightAt(ax) - 125;
          const nConf = this.reduced ? 30 : 90;
          for (let i = 0; i < nConf; i++) {
            const a = -Math.PI / 2 + ps.rand(-1.1, 1.1);
            const sp = ps.rand(120, 420) * (this.reduced ? 0.55 : 1);
            ps.spawn(PK.CONFETTI, ax + ps.rand(-70, 70), ay + ps.rand(-6, 6), Math.cos(a) * sp + local.vx * 0.2, Math.sin(a) * sp, ps.rand(1.6, 2.8), ps.rand(4, 7), i % 3 === 0 ? 6 : 7 + (i % 6), 260, 1.6);
          }
          for (let i = 0; i < 18; i++) ps.spawn(PK.SPARKLE, ax + ps.rand(-80, 80), ay + ps.rand(-40, 20), ps.rand(-40, 40), ps.rand(-60, 0), ps.rand(0.5, 1.1), ps.rand(3, 6), 4, 0, 2);
          this.burst(local.x, local.y, 24, 220, 0);
          this.pulse = Math.max(this.pulse, 0.35);
          break;
        }
        case SimEvent.RESPAWN:
          ps.spawn(PK.RING, x, y - 20, 0, 0, 0.6, 50, 4, 0, 0);
          this.burst(x, y, 16, 120, 0);
          break;
        default:
          break;
      }
    }
  }

  /** Smash / crash effect per obstacle kind (strength 1 = smashed through with the shield). */
  obstacleFx(type, x, y, local, k) {
    const ps = this.particles;
    const vx = local.vx * 0.35;
    if (type === 'log') {
      // splinters + a puff of snow from the cap
      for (let i = 0; i < 22 * k; i++) ps.spawn(PK.SHARD, x + ps.rand(-30, 30), y - ps.rand(4, 20), vx + ps.rand(-140, 220), ps.rand(-360, -80), ps.rand(0.6, 1.1), ps.rand(2.5, 6), i % 3 ? 13 : 2, 1100, 0.6);
      this.burst(x, y - 10, 14 * k, 180, 0);
    } else if (type === 'snowman') {
      // big soft snow explosion and the hat flying off
      for (let i = 0; i < 46 * k; i++) {
        const a = -Math.PI * ps.rand(0.05, 0.95);
        const sp = ps.rand(60, 320);
        ps.spawn(PK.PUFF, x + ps.rand(-10, 10), y - ps.rand(5, 50), vx * 0.5 + Math.cos(a) * sp, Math.sin(a) * sp, ps.rand(0.6, 1.3), ps.rand(3, 8), i % 4 ? 0 : 1, 300, 2.2);
      }
      ps.spawn(PK.HAT, x, y - 55, vx + 120, -380, 1.6, 6, 2, 900, 0.3);
      for (let i = 0; i < 6; i++) ps.spawn(PK.SHARD, x, y - 30, vx + ps.rand(-90, 160), ps.rand(-300, -100), 0.9, 2.5, 2, 1000, 0.6);
    } else {
      // ice glitter
      for (let i = 0; i < 26 * k; i++) ps.spawn(PK.SHARD, x + ps.rand(-60, 60), y - ps.rand(2, 12), vx + ps.rand(-120, 200), ps.rand(-300, -60), ps.rand(0.5, 1), ps.rand(2, 4.5), 14, 1000, 0.7);
      for (let i = 0; i < 16 * k; i++) ps.spawn(PK.SPARKLE, x + ps.rand(-60, 60), y - ps.rand(4, 30), ps.rand(-60, 60), ps.rand(-120, -10), ps.rand(0.4, 0.9), ps.rand(3, 6), 4, 200, 2);
    }
  }

  /** Name tags above ghosts; colliding x-ranges are staggered upward by row. */
  drawTags(ctx, local, others, focus, cam, P) {
    const w = this.width;
    const h = this.height;
    const lp = cam.worldToScreen(local.x, local.y);
    const rows = (this._tagRows = this._tagRows || []);
    rows.length = 0;
    const list = (this._tagList = this._tagList || []);
    list.length = 0;
    for (const v of others) {
      if (v === focus) continue;
      const sp = cam.worldToScreen(v.x, v.y);
      if (sp.x < -40 || sp.x > w + 40 || sp.y < -40 || sp.y > h + 40) continue;
      list.push([sp.x, sp.y - 54 * cam.scale, v, Math.hypot(sp.x - lp.x, sp.y - 54 * cam.scale - (lp.y - 30 * cam.scale))]);
    }
    list.sort((a, b) => a[0] - b[0]);
    const half = 34; // ≈ half a tag width
    for (const [x, y, v, near] of list) {
      let row = 0;
      for (const [rx, ry, rr] of rows) if (Math.abs(rx - x) < half * 2 + 4 && Math.abs(ry - y) < 20 && rr >= row) row = rr + 1;
      rows.push([x, y, row]);
      this.riders.drawTag(ctx, v, x, y - row * 18, smoothstep(60, 110, near), P);
    }
  }

  /**
   * Edge markers for the nearest rider off screen ahead (right) and behind (left): a chevron in
   * the rider's colour with the name and, if the frame supplies it, the time gap. Fades in/out,
   * at most two, kept inside the safe band and dimmed where a hazard is near that edge.
   */
  drawMarkers(ctx, local, others, focus, markers, cam, P, dt, feats) {
    const w = this.width;
    const h = this.height;
    let ahead = null;
    let behind = null;
    let aX = Infinity;
    let bX = -Infinity;
    for (const v of others) {
      if (v === focus) continue;
      const sx = cam.sx(v.x);
      if (sx > w + 10 && sx < aX) {
        aX = sx;
        ahead = v;
      } else if (sx < -10 && sx > bX) {
        bX = sx;
        behind = v;
      }
    }
    const st = (this._markers = this._markers || new Map());
    for (const [id, m] of st) m.want = 0;
    for (const [v, side] of [
      [ahead, 1],
      [behind, -1],
    ]) {
      if (!v) continue;
      let m = st.get(v.id);
      if (!m) st.set(v.id, (m = { a: 0, want: 0 }));
      m.want = 1;
      m.side = side;
      m.v = v;
      const top = side < 0 ? Math.max(h * 0.3, 130) : h * 0.28;
      const bot = side < 0 ? Math.min(h * 0.72, h - 140) : h * 0.72;
      m.y = clamp(cam.sy(v.y) - 20 * cam.scale, top, bot);
    }
    const haz = this.hazards;
    for (const [id, m] of st) {
      m.a += (m.want - m.a) * (1 - Math.exp(-dt * 8));
      if (m.a < 0.02 && !m.want) {
        st.delete(id);
        continue;
      }
      let gap = null;
      if (markers) for (const mk of markers) if (mk.id === id && Number.isFinite(mk.gapS)) gap = mk.gapS;
      // dim when a hazard sits near this edge
      let dim = 1;
      if (haz && m.side > 0) for (let k = 0; k < haz.n; k++) if (haz.r[k] > w - 140) dim = 0.45;
      this.riders.drawMarker(ctx, m.v, m.side, m.side > 0 ? w - 10 : 10, m.y, m.a * dim, gap, P);
    }
  }

  /** Overtakes near the local rider: a brief streak from the passer to the passed. */
  drawWhooshes(ctx, local, others, dt) {
    const sg = (this._passSign = this._passSign || new Map());
    const list = (this._whoosh = this._whoosh || []);
    for (const v of others) {
      const dx = v.x - local.x;
      if (Math.abs(dx) > 500 || !Number.isFinite(dx)) {
        sg.delete(v.id);
        continue;
      }
      const sign = dx >= 0 ? 1 : -1;
      const prev = sg.get(v.id);
      if (prev && prev !== sign && list.length < 4) list.push({ x0: sign > 0 ? local.x : v.x, y0: (sign > 0 ? local.y : v.y) - 20, x1: sign > 0 ? v.x : local.x, y1: (sign > 0 ? v.y : local.y) - 20, color: hex(sign > 0 ? v.color : local.color), age: 0 });
      sg.set(v.id, sign);
    }
    ctx.lineCap = 'round';
    for (let i = list.length - 1; i >= 0; i--) {
      const wh = list[i];
      wh.age += dt;
      if (wh.age > 0.45) {
        list.splice(i, 1);
        continue;
      }
      const u = wh.age / 0.45;
      const g = ctx.createLinearGradient(wh.x0 - 120, wh.y0, wh.x1, wh.y1);
      g.addColorStop(0, rgba(wh.color, 0));
      g.addColorStop(0.65, rgba(mix(wh.color, [255, 255, 255], 0.35), 0.85 * (1 - u)));
      g.addColorStop(1, rgba([255, 255, 255], 0));
      ctx.strokeStyle = g;
      // three strands of a curved whoosh from behind the passer to the passed rider
      for (let k = -1; k <= 1; k++) {
        ctx.lineWidth = (k === 0 ? 4 : 2) * (1 - u) + 0.8;
        ctx.beginPath();
        ctx.moveTo(wh.x0 - 120, wh.y0 + 6 + k * 7);
        ctx.quadraticCurveTo((wh.x0 + wh.x1) / 2, Math.min(wh.y0, wh.y1) - 22 + k * 6, wh.x1, wh.y1 + k * 4);
        ctx.stroke();
      }
    }
  }

  /** Highlight ring on the feature that ended a run (crash cause / pit). */
  accentFeature(cause, x) {
    const type = cause === 'chasm' ? 'chasm' : cause;
    if (!type || type === 'landing') return;
    let best = null;
    let bd = 220;
    for (const f of this.course.featuresIn(x - 220, x + 220)) {
      if (f.type !== type) continue;
      const fx = f.type === 'chasm' ? f.x0 : f.x;
      if (Math.abs(fx - x) < bd) {
        bd = Math.abs(fx - x);
        best = f;
      }
    }
    if (!best) return;
    if (best.type === 'chasm') this.pushAccent(best.x0, Number.isFinite(best.y0) ? best.y0 : this.course.heightAt(best.x0 - 1), 46);
    else {
      const r = Math.max(24, (best.w || (best.size || 20) * 2) * 0.6, (best.h || 0) * 0.7);
      this.pushAccent(best.x, this.course.heightAt(best.x) - Math.min(r * 0.5, (best.h || best.size || 20) * 0.5), r);
    }
  }

  pushAccent(x, y, r) {
    const a = (this._accents = this._accents || []);
    if (a.length > 3) a.shift();
    a.push({ x, y, r, age: 0 });
  }

  drawAccents(ctx, dt) {
    const a = this._accents;
    if (!a || !a.length) return;
    ctx.lineWidth = 2.5;
    for (let i = a.length - 1; i >= 0; i--) {
      const ac = a[i];
      ac.age += dt;
      if (ac.age > 0.9) {
        a.splice(i, 1);
        continue;
      }
      for (const off of [0, 0.25]) {
        const u = clamp((ac.age - off) / 0.6, 0, 1);
        if (u <= 0 || u >= 1) continue;
        ctx.strokeStyle = `rgba(255,255,255,${0.85 * (1 - u)})`;
        ctx.beginPath();
        ctx.arc(ac.x, ac.y, ac.r * (0.8 + 0.9 * u), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /**
   * Finish beacon: a tall lattice tower with a waving banner and a pulsing light on a far hill
   * beyond the finish, placed by distance to finishX so it drifts in from the right and grows as
   * the finish approaches. Drawn into the background buffer between ridge layers 3 and 4.
   */
  drawBeacon(ctx, atm, L, P, cam) {
    const c = this.course;
    const d = c.finishX - cam.x;
    if (d < -1500 || d > c.length * 0.65) return;
    const fade = clamp((c.length * 0.65 - d) / 2500, 0, 1) * clamp((d + 1500) / 1500, 0, 1);
    if (fade <= 0.01) return;
    const u = 1 - Math.exp(-Math.max(0, d) / 16000);
    const x = cam.anchorX + 80 + L.w * 0.5 * u;
    const hT = L.h * (0.15 + 0.2 * (1 - u));
    const base = L.h * 0.72 + L.vshift * 0.25;
    const col = mix(hex(atm.ridges[3]), P.sil, 0.35);
    const t = L.t;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = rgba(col);
    ctx.strokeStyle = rgba(col);
    const bw = hT * 0.16;
    const tw = hT * 0.05;
    const top = base - hT;
    // legs
    ctx.beginPath();
    ctx.moveTo(x - bw, base);
    ctx.lineTo(x - tw, top);
    ctx.lineTo(x - tw + 2, top);
    ctx.lineTo(x - bw + 3, base);
    ctx.moveTo(x + bw, base);
    ctx.lineTo(x + tw, top);
    ctx.lineTo(x + tw - 2, top);
    ctx.lineTo(x + bw - 3, base);
    ctx.fill();
    // cross braces
    ctx.lineWidth = Math.max(1, hT * 0.012);
    ctx.beginPath();
    const n = 5;
    for (let k = 0; k < n; k++) {
      const y0 = base - (hT * k) / n;
      const y1 = base - (hT * (k + 1)) / n;
      const w0 = bw - ((bw - tw) * k) / n;
      const w1 = bw - ((bw - tw) * (k + 1)) / n;
      ctx.moveTo(x - w0, y0);
      ctx.lineTo(x + w1, y1);
      ctx.moveTo(x + w0, y0);
      ctx.lineTo(x - w1, y1);
    }
    ctx.stroke();
    // platform + cabin + mast
    ctx.fillRect(x - tw * 2.2, top - hT * 0.02, tw * 4.4, hT * 0.025);
    ctx.fillRect(x - tw * 1.3, top - hT * 0.09, tw * 2.6, hT * 0.07);
    ctx.fillRect(x - 1, top - hT * 0.22, 2, hT * 0.13);
    // banner on the mast (festive, waving)
    ctx.fillStyle = rgba(mix(P.festive[0], hex(atm.skyBottom), 0.15));
    ctx.beginPath();
    const by = top - hT * 0.22;
    const bl = hT * 0.16;
    const bh = hT * 0.06;
    ctx.moveTo(x + 1, by);
    for (let k = 1; k <= 6; k++) ctx.lineTo(x + 1 + (bl * k) / 6, by + Math.sin(t * 4 + k * 0.9) * bh * 0.18 * (k / 6));
    for (let k = 6; k >= 0; k--) ctx.lineTo(x + 1 + (bl * k) / 6, by + bh + Math.sin(t * 4 + k * 0.9) * bh * 0.18 * (k / 6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // beacon light: pulsing warm glow (brighter at night)
    const pulse = 0.55 + 0.45 * Math.sin(t * 5.2);
    const lr = hT * (0.1 + 0.08 * P.night);
    const spr = this.glowSprite(P.accent);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = fade * (0.35 + 0.65 * P.night) * pulse;
    ctx.drawImage(spr, x - lr, top - hT * 0.06 - lr, lr * 2, lr * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(255,230,170,${fade * (0.6 + 0.4 * pulse)})`;
    ctx.beginPath();
    ctx.arc(x, top - hT * 0.06, Math.max(1.5, hT * 0.018), 0, Math.PI * 2);
    ctx.fill();
  }

  /** Lips of a chasm feature for the camera. */
  spanOf(f) {
    const c = this.course;
    return { x0: f.x0, x1: f.x1, y0: Number.isFinite(f.y0) ? f.y0 : c.heightAt(f.x0 - 1), y1: Number.isFinite(f.y1) ? f.y1 : c.heightAt(f.x1 + 1) };
  }

  chasmNear(x) {
    for (const f of this.course.featuresIn(x - 600, x + 600)) if (f.type === 'chasm') return f;
    return null;
  }

  /**
   * Touchdown: a powder sheet thrown forward plus two spray arcs from the board tips,
   * all scaled by the impact; a sketchy landing is bigger and messier.
   */
  landingFx(v, k, sketchy) {
    const ps = this.particles;
    const ca = Math.cos(v.angle);
    const sa = Math.sin(v.angle);
    const m = sketchy ? 1.6 : 1;
    const n = Math.round((10 + 34 * k) * m);
    for (let i = 0; i < n; i++) {
      // forward sheet: low, fast, fanning along the slope
      const f = ps.rand(0.35, 0.95);
      ps.spawn(PK.PUFF, v.x + ca * ps.rand(-6, 14), v.y + sa * 6 - ps.rand(0, 4), v.vx * f + ps.rand(-40, 40) * m, v.vy * f - ps.rand(40, 170) * (0.4 + k) * m, ps.rand(0.35, 0.8), ps.rand(1.6, 4) * (0.8 + 0.5 * k), sketchy && i % 3 === 0 ? 1 : 0, 520, 3.4);
    }
    for (const side of [-1, 1]) {
      // two arcs: from each tip, up and back
      const tx = v.x + ca * 15 * side * 0.8;
      const ty = v.y + sa * 15 * side * 0.8;
      for (let i = 0; i < Math.round((6 + 14 * k) * m); i++) {
        const u = i / (6 + 14 * k);
        ps.spawn(PK.PUFF, tx, ty - 2, -v.vx * (0.05 + 0.2 * u) + side * ps.rand(10, 60) * m, -(120 + 220 * k) * (0.6 + 0.6 * u) * ps.rand(0.8, 1.1), ps.rand(0.4, 0.75), ps.rand(1.4, 3.2), 0, 700, 2.4);
      }
    }
    if (k > 0.6) {
      // heavy impact: a few big slow clouds hanging over the touchdown
      for (let i = 0; i < Math.round(16 * (k - 0.5) * m); i++) ps.spawn(PK.PUFF, v.x + ps.rand(-22, 22), v.y - ps.rand(0, 8), v.vx * ps.rand(0.1, 0.4) + ps.rand(-50, 50), -ps.rand(40, 120), ps.rand(0.7, 1.2), ps.rand(5, 9), i % 3 ? 0 : 1, 140, 2);
    }
    this.trailBoost = 1;
  }

  /** Short groove carved behind the board on the ground (local rider), fading out. */
  drawTrail(ctx, local, dt, P) {
    const tr = this.trail;
    for (let i = 0; i < tr.n; i++) tr.age[i] += dt;
    if (local.mode === RiderMode.GROUND || local.mode === RiderMode.FINISHED) {
      if (tr.n === 0 || Math.hypot(local.x - tr.x[tr.n - 1], local.y - tr.y[tr.n - 1]) > 6) {
        if (tr.n === tr.x.length) {
          tr.x.copyWithin(0, 1);
          tr.y.copyWithin(0, 1);
          tr.age.copyWithin(0, 1);
          tr.n--;
        }
        tr.x[tr.n] = local.x;
        tr.y[tr.n] = local.y;
        tr.age[tr.n] = 0;
        tr.n++;
      }
    }
    while (tr.n > 0 && tr.age[0] > 0.9) {
      tr.x.copyWithin(0, 1);
      tr.y.copyWithin(0, 1);
      tr.age.copyWithin(0, 1);
      tr.n--;
    }
    if (tr.n < 2) return;
    this.trailBoost = Math.max(0, (this.trailBoost || 0) - dt * 1.2);
    const col = mix(P.shade, P.sil, 0.15);
    ctx.lineCap = 'round';
    for (let i = 1; i < tr.n; i++) {
      const a = (1 - tr.age[i] / 0.9) * (0.28 + 0.4 * this.trailBoost);
      if (a <= 0.01) continue;
      ctx.strokeStyle = rgba(col, a);
      ctx.lineWidth = 1.6 + 1.6 * this.trailBoost;
      ctx.beginPath();
      ctx.moveTo(tr.x[i - 1], tr.y[i - 1] + 0.8);
      ctx.lineTo(tr.x[i], tr.y[i] + 0.8);
      ctx.stroke();
    }
  }

  /** Screen x ranges of hazards within ~1.2 s of travel ahead of the local rider (no allocation). */
  hazardsAhead(local, feats, cam) {
    const H = this.hazards || (this.hazards = { n: 0, l: new Float32Array(32), r: new Float32Array(32) });
    H.n = 0;
    const reach = local.x + Math.max(300, Math.abs(local.vx) * 1.2) + 60;
    for (const f of feats) {
      if (H.n >= 32) break;
      let x0;
      let x1;
      if (f.type === 'chasm' || f.type === 'ramp') {
        x0 = f.type === 'ramp' ? (f.lipX ?? f.x1 ?? f.x) - 30 : f.x0 - 20;
        x1 = f.type === 'ramp' ? (f.lipX ?? f.x1 ?? f.x) + 20 : f.x0 + 40; // the near lip
      } else if (HAZARDS.has(f.type) && !this.consumed.has(f.id)) {
        const w = f.w || (f.size || 20) * 2.5;
        x0 = f.x - w / 2;
        x1 = f.x + w / 2;
      } else continue;
      if (x1 < local.x - 20 || x0 > reach) continue;
      H.l[H.n] = cam.sx(x0);
      H.r[H.n] = cam.sx(x1);
      H.n++;
    }
    return H;
  }

  featureById(id, x) {
    if (id == null || !Number.isFinite(x)) return null;
    for (const f of this.course.featuresIn(x - 80, x + 80)) if (f.id === id) return f;
    return null;
  }

  /** Coins pulled in by the magnet: ease towards the rider's body, then pop. */
  drawFlyers(ctx, local, dt) {
    const ps = this.particles;
    const tx = local.x;
    const ty = local.y - BODY_CENTER;
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const c = this.flyers[i];
      c.age += dt;
      const u = Math.min(1, c.age / 0.3);
      const e = u * u * (3 - 2 * u);
      const x = c.x + (tx - c.x) * e;
      const y = c.y + (ty - c.y) * e - Math.sin(u * Math.PI) * 18;
      if (u >= 1) {
        ps.spawn(PK.RING, tx, ty, 0, 0, 0.4, 22, 5, 0, 0);
        for (let k = 0; k < 4; k++) ps.spawn(PK.SPARKLE, tx + ps.rand(-8, 8), ty + ps.rand(-8, 8), ps.rand(-60, 60), ps.rand(-90, 10), ps.rand(0.3, 0.6), ps.rand(3, 5), 5, 0, 2);
        this.flyers.splice(i, 1);
        continue;
      }
      const r = 7 * (1 - 0.35 * u);
      ctx.fillStyle = '#c98a1b';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd75a';
      ctx.beginPath();
      ctx.arc(x - 0.6, y, r - 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Powder burst: puffs flung up and out. */
  burst(x, y, n, speed, col) {
    const ps = this.particles;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * ps.rand(0.05, 0.95);
      const s = speed * ps.rand(0.3, 1);
      ps.spawn(PK.PUFF, x + ps.rand(-12, 12), y - ps.rand(0, 6), Math.cos(a) * s, Math.sin(a) * s, ps.rand(0.5, 1.1), ps.rand(2, 5.5), col, 260, 2.6);
    }
  }

  /** Spray behind boards, boost sparkles, grind sparks, embers, hover feathers. */
  emitContinuous(frame, dt, P, feats) {
    const ps = this.particles;
    const em = this.emit;
    const riders = frame.others ? [...frame.others, frame.local] : [frame.local];
    for (const v of riders) {
      const sp = Math.hypot(v.vx, v.vy);
      const ca = Math.cos(v.angle);
      const sa = Math.sin(v.angle);
      const local = v.isLocal || v === frame.local;
      if (!local) {
        // ghosts off screen emit nothing
        const gx = this.camera.sx(v.x);
        if (gx < -100 || gx > this.width + 100) continue;
      }
      if (v.mode === RiderMode.GROUND && sp > 60) {
        const rate = clamp(sp / 900, 0, 1.6) * (local ? 110 * (1 + 0.6 * (v.boostLevel || 0)) : 22);
        em.spray += rate * dt;
        const tx = v.x - ca * 13;
        const ty = v.y - sa * 13;
        while (em.spray >= 1) {
          em.spray -= 1;
          ps.spawn(PK.PUFF, tx + ps.rand(-3, 3), ty - ps.rand(0, 3), -v.vx * ps.rand(0.05, 0.25) + ps.rand(-30, 30), -ps.rand(40, 140) * clamp(sp / 700, 0.4, 1.5), ps.rand(0.3, 0.7), ps.rand(1.1, 2.8) * (0.8 + sp / 1600), 0, 240, 3.2);
        }
      }
      if (v.mode === RiderMode.CRASHED && sp > 40) {
        // sliding tumble: a continuous plume of snow thrown up behind the body
        em.spray += clamp(sp / 600, 0.3, 1.6) * (local ? 70 : 20) * dt;
        while (em.spray >= 1) {
          em.spray -= 1;
          ps.spawn(PK.PUFF, v.x + ps.rand(-10, 6), v.y - ps.rand(0, 10), -v.vx * ps.rand(0.05, 0.3) + ps.rand(-40, 40), -ps.rand(60, 200), ps.rand(0.4, 0.9), ps.rand(2, 5), ps.rng.next() < 0.3 ? 1 : 0, 300, 2.6);
        }
      }
      if (v.mode === RiderMode.GRIND && sp > 40) {
        em.sparkle += 50 * dt;
        while (em.sparkle >= 1) {
          em.sparkle -= 1;
          ps.spawn(PK.SPARK, v.x + ps.rand(-6, 6), v.y, -v.vx * 0.25 + ps.rand(-90, 40), ps.rand(-180, -30), ps.rand(0.18, 0.4), 1.3, 3, 900, 1);
        }
      }
      if (local && v.boostLevel) {
        em.sparkle += (12 + 14 * v.boostLevel) * dt;
        while (em.sparkle >= 1) {
          em.sparkle -= 1;
          ps.spawn(PK.SPARKLE, v.x + ps.rand(-22, 10), v.y - ps.rand(0, 40), -v.vx * 0.2 + ps.rand(-30, 30), ps.rand(-50, 10), ps.rand(0.3, 0.7), ps.rand(2.5, 5), ps.rng.next() < 0.5 ? 4 : 6, 0, 2);
        }
      }
      if (v.hover) {
        em.feather += 14 * dt;
        while (em.feather >= 1) {
          em.feather -= 1;
          ps.spawn(PK.FEATHER, v.x + ps.rand(-20, 20), v.y - ps.rand(10, 45), ps.rand(-60, 20), ps.rand(10, 50), ps.rand(0.6, 1.1), ps.rand(3, 5), 4, 40, 1.2);
        }
      }
    }
    // campfire embers
    for (const f of feats) {
      if (f.type !== 'campfire' || this.consumed.has(f.id)) continue;
      em.ember += 7 * dt;
      while (em.ember >= 1) {
        em.ember -= 1;
        const y = this.course.heightAt(f.x);
        ps.spawn(PK.EMBER, f.x + ps.rand(-6, 6), y - ps.rand(10, 26), ps.rand(-15, 15), ps.rand(-80, -30), ps.rand(0.6, 1.4), ps.rand(1.4, 2.4), 3, -20, 0.6);
      }
    }
    this.prevLocal = frame.local;
  }
}
