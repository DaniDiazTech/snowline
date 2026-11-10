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
 */
import { clamp, smoothstep } from '../math/utils.js';
import { RiderMode, SimEvent } from '../contracts.js';
import { sampleAtmosphere } from './DayCycle.js';
import { Camera } from './Camera.js';
import { Sky } from './Sky.js';
import { Parallax } from './Parallax.js';
import { TerrainRenderer } from './TerrainRenderer.js';
import { DecorRenderer, FESTIVE } from './DecorRenderer.js';
import { FeatureRenderer, isGroundIce } from './FeatureRenderer.js';
import { RiderRenderer } from './RiderRenderer.js';
import { Particles, PK } from './Particles.js';
import { Weather } from './Weather.js';
import { Effects } from './Effects.js';
import { hex, mix, rgba, scale } from './color.js';

const DECOR_MARGIN = 420; // world px: widest decor, so nothing pops in at the edges
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
    this.consumed = new Set();
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
    this.setCourse(course);
    this.resize(p.width, p.height);
  }

  setCourse(course) {
    this.course = course;
    this.sky.setSeed(course?.seed ?? 1);
    this.parallax.setSeed(course?.seed ?? 1);
    this.consumed.clear();
    this.riders.reset();
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
    this.parallax.build(this.height, this.dpr);
    this.effects.resize(this.width, this.height);
    this.forceTint = true;
  }

  worldToScreen(x, y) {
    return this.camera.worldToScreen(x, y);
  }

  /** @param {import('../contracts.js').RenderFrame} frame */
  draw(frame) {
    const t0 = performance.now();
    const { p, course, camera: cam } = this;
    if (!course) return;
    if (p.width !== this.width || p.height !== this.height || (p.pixelDensity && p.pixelDensity() !== this.dpr)) this.resize(p.width, p.height);
    const ctx = p.drawingContext;
    const dpr = this.dpr;
    const dt = clamp((frame.dtMs ?? 16.7) / 1000, 0, 0.1);
    const t = frame.timeMs / 1000;
    const local = frame.local;
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return;
    const atm = sampleAtmosphere(frame.timeMs, course);
    this.atmosphere = atm;

    cam.update(local, course, dt, frame.timeMs, !!frame.cinematic);
    const P = this.palette(atm, t);
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
    };

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;

    // ---- sky ----
    this.sky.stormDim = atm.weather === 'storm' ? Math.max(0, 1 - 1.1 * atm.weatherAmt) : atm.weather === 'fog' ? 1 - 0.5 * atm.weatherAmt : 1;
    this.sky.drawGradient(ctx, atm, L);
    this.sky.drawStars(ctx, atm, L);
    this.sky.drawBodies(ctx, atm, L);
    this.sky.drawClouds(ctx, atm, L, 0);
    this.sky.drawBirds(ctx, atm, L);
    if (atm.flash > 0.01) {
      ctx.fillStyle = `rgba(240,244,255,${0.75 * atm.flash})`;
      ctx.fillRect(0, 0, w, L.horizonY + h * 0.1);
    }

    // ---- distant ridges ----
    this.parallax.update(atm, this.forceTint);
    this.forceTint = false;
    const haze = P.haze;
    const mist = 0.18 + (atm._fog ?? 0) * 0.45 + (atm.weather === 'snow' ? 0.08 * atm.weatherAmt : 0);
    for (let i = 0; i < 5; i++) {
      const { base } = this.parallax.drawLayer(ctx, i, L);
      // valley mist band at the foot of the layer
      const by = base - h * 0.1;
      const bh = h * 0.12;
      const g = ctx.createLinearGradient(0, by - bh, 0, by + bh);
      g.addColorStop(0, rgba(haze, 0));
      g.addColorStop(0.55, rgba(haze, mist * (1 - i * 0.12)));
      g.addColorStop(1, rgba(haze, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, by - bh, w, bh * 2);
      if (i < 4) this.sky.drawClouds(ctx, atm, L, i + 1);
    }
    // valley haze rising from below the forest line (depth when the slope is out of view)
    {
      const y0 = h * 0.74 + L.vshift * 0.3;
      const g = ctx.createLinearGradient(0, y0, 0, h);
      g.addColorStop(0, rgba(haze, 0));
      g.addColorStop(1, rgba(haze, 0.42 + (atm._fog ?? 0) * 0.3));
      ctx.fillStyle = g;
      ctx.fillRect(0, y0, w, h - y0);
    }

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
    for (const d of decor) if ((d.depth || 0) > 0) this.decor.draw(ctx, d, P, course);
    for (const d of decor) if ((d.depth || 0) === 0) this.decor.draw(ctx, d, P, course);
    for (const f of feats) if (f.type === 'grind' && !isGroundIce(f, course)) this.features.draw(ctx, f, P, course, this.consumed);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.terrain.drawBody(ctx, atm, cam, L);
    this.terrain.drawChasms(ctx, atm, cam, L, course);
    this.terrain.drawLip(ctx, atm, cam);

    cam.apply(ctx, dpr);
    for (const f of feats) if (f.type !== 'pickup' && (f.type !== 'grind' || isGroundIce(f, course))) this.features.draw(ctx, f, P, course, this.consumed);
    this.drawGlows(ctx);
    this.glows.n = 0;

    // ---- riders & effects ----
    this.emitContinuous(frame, dt, P, feats);
    this.particles.update(dt);
    for (const f of feats) if (f.type === 'pickup') this.features.drawPickup(ctx, f, P, this.consumed);
    const others = frame.others || [];
    for (const v of others) this.riders.draw(ctx, v, P, dt);
    this.riders.draw(ctx, local, P, dt);
    this.particles.draw(ctx, P.particleColors);
    this.drawGlows(ctx);
    this.glows.n = 0;
    for (const d of decor) if ((d.depth || 0) < 0) this.decor.draw(ctx, d, P, course);
    this.drawGlows(ctx);
    this.glows.n = 0;
    this.riders.sweep();

    // ---- screen-space overlays ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.weather.drawFog(ctx, atm, L);
    this.effects.drawForeground(ctx, cam, P, L, course.startX);
    this.weather.drawPrecip(ctx, atm, L);
    const boostT = local.boostLevel >= 2 ? 0.35 + local.boostLevel * 0.2 : local.boostLevel ? 0.25 : 0;
    this.boostFx += (boostT - this.boostFx) * (1 - Math.exp(-dt * 5));
    this.pulse *= Math.exp(-dt * 4);
    this.effects.drawPost(ctx, atm, P, L, { boost: frame.cinematic ? 0 : this.boostFx, pulse: this.pulse, dir: Math.PI + Math.atan2(local.vy, local.vx), ry: cam.sy(local.y) - 20 * cam.scale });

    // name tags of ghosts (not on cinematic screens)
    if (!frame.cinematic) {
      const lp = cam.worldToScreen(local.x, local.y);
      for (const v of others) {
        const sp = cam.worldToScreen(v.x, v.y);
        if (sp.x < -40 || sp.x > w + 40 || sp.y < -40 || sp.y > h + 40) continue;
        const ty = sp.y - 64 * cam.scale;
        const near = Math.hypot(sp.x - lp.x, ty - (lp.y - 30 * cam.scale));
        const a = 0.25 + 0.75 * smoothstep(30, 90, near);
        this.riders.drawTag(ctx, v, sp.x, ty, a, P);
      }
    }
    ctx.restore();
    this.lastDrawMs = performance.now() - t0;
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
      festive,
      wind: atm.weather === 'storm' ? atm.weatherAmt : atm.weather === 'snow' ? atm.weatherAmt * 0.4 : 0,
      glow: this.glowFn || (this.glowFn = (x, y, r, a, c) => this.pushGlow(x, y, r, a, c)),
    };
    // particle colours: 0 snow, 1 shade, 2 rock, 3 warm, 4 white, 5 gold, 6 local player
    P.particleColors = [rgba(mix(snow, [255, 255, 255], 0.3)), rgba(mix(snow, shade, 0.5)), rgba(P.rockDark), rgba([255, 170, 70]), '#ffffff', '#ffd75a', this.prevLocal?.color || '#ffffff'];
    P.accentGlow = accent;
    return P;
  }

  pushGlow(x, y, r, a, c) {
    const g = this.glows;
    if (g.n >= MAX_GLOWS || a <= 0.01) return;
    g.x[g.n] = x;
    g.y[g.n] = y;
    g.r[g.n] = r;
    g.a[g.n] = a;
    g.c[g.n] = c || null;
    g.n++;
  }

  /** Additive warm glows queued by decor/features (world transform applied). */
  drawGlows(ctx) {
    const g = this.glows;
    if (!g.n) return;
    const acc = hex(this.atmosphere.accent);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < g.n; i++) {
      const c = g.c[i] || acc;
      const grad = ctx.createRadialGradient(g.x[i], g.y[i], 0, g.x[i], g.y[i], g.r[i]);
      grad.addColorStop(0, rgba(c, 0.55 * g.a[i]));
      grad.addColorStop(0.35, rgba(c, 0.18 * g.a[i]));
      grad.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(g.x[i] - g.r[i], g.y[i] - g.r[i], g.r[i] * 2, g.r[i] * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  handleEvents(events, local, P) {
    const ps = this.particles;
    const cam = this.camera;
    for (const e of events) {
      const d = e.data || {};
      const x = d.x ?? local.x;
      const y = d.y ?? local.y;
      switch (e.type) {
        case SimEvent.LAND: {
          const k = clamp(d.impact ?? 0.4, 0, 1);
          this.burst(local.x, local.y, 8 + Math.round(26 * k), 80 + 220 * k, 0);
          if (!d.clean) this.burst(local.x, local.y, 12, 200, 1);
          if (k > 0.55) cam.addShake(1.5 + 4 * (k - 0.55));
          break;
        }
        case SimEvent.CRASH:
          this.burst(x, y, 40, 300, 0);
          this.burst(x, y, 14, 160, 1);
          cam.addShake(6);
          break;
        case SimEvent.ROCK_SMASH:
          if (d.featureId != null) this.consumed.add(d.featureId);
          for (let i = 0; i < 16; i++) ps.spawn(PK.SHARD, x + ps.rand(-8, 8), y - ps.rand(5, 20), local.vx * 0.4 + ps.rand(-160, 220), ps.rand(-380, -80), ps.rand(0.6, 1.1), ps.rand(3, 7), 2, 1100, 0.6);
          this.burst(x, y - 8, 18, 200, 0);
          cam.addShake(3);
          break;
        case SimEvent.PICKUP:
          if (d.featureId != null) this.consumed.add(d.featureId);
          ps.spawn(PK.RING, x, y, 0, 0, 0.45, 26, d.kind === 'coin' ? 5 : 4, 0, 0);
          for (let i = 0; i < (d.kind === 'coin' ? 5 : 12); i++) ps.spawn(PK.SPARKLE, x + ps.rand(-10, 10), y + ps.rand(-10, 10), ps.rand(-60, 60), ps.rand(-90, 20), ps.rand(0.35, 0.7), ps.rand(3, 6), d.kind === 'coin' ? 5 : 4, 0, 2);
          break;
        case SimEvent.BOOST:
          this.pulse = Math.max(this.pulse, 0.5 + 0.15 * (d.level || 1));
          for (let i = 0; i < 24; i++) {
            const a = ps.rand(0, Math.PI * 2);
            const s = ps.rand(80, 260);
            ps.spawn(PK.SPARKLE, local.x, local.y - 20, Math.cos(a) * s, Math.sin(a) * s, ps.rand(0.4, 0.9), ps.rand(3, 7), i % 2 ? 4 : 6, 0, 3);
          }
          break;
        case SimEvent.JUMP:
          this.burst(local.x, local.y, 8, 90, 0);
          break;
        case SimEvent.GRIND_START:
          for (let i = 0; i < 10; i++) ps.spawn(PK.SPARK, local.x, local.y, local.vx * 0.3 + ps.rand(-120, 80), ps.rand(-200, -40), ps.rand(0.2, 0.45), 1.4, 3, 900, 1);
          break;
        case SimEvent.RESPAWN:
          ps.spawn(PK.RING, x, y - 20, 0, 0, 0.6, 50, 4, 0, 0);
          this.burst(x, y, 16, 120, 0);
          break;
        default:
          break;
      }
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
      if (v.mode === RiderMode.GROUND && sp > 60) {
        const rate = clamp(sp / 900, 0, 1.6) * (local ? 110 : 30);
        em.spray += rate * dt;
        const tx = v.x - ca * 13;
        const ty = v.y - sa * 13;
        while (em.spray >= 1) {
          em.spray -= 1;
          ps.spawn(PK.PUFF, tx + ps.rand(-3, 3), ty - ps.rand(0, 3), -v.vx * ps.rand(0.05, 0.25) + ps.rand(-30, 30), -ps.rand(40, 140) * clamp(sp / 700, 0.4, 1.5), ps.rand(0.3, 0.7), ps.rand(1.1, 2.8) * (0.8 + sp / 1600), 0, 240, 3.2);
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
