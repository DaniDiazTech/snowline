/**
 * Follow camera.
 *
 * World → screen:  sx = (x - this.x) * this.scale + anchorX
 *                  sy = (y - this.y) * this.scale + anchorY
 * `scale` = baseScale (from the screen size) * zoom. The camera centre is
 * eased towards the rider plus a look-ahead along the velocity; zoom eases
 * out with speed and with height above the ground so big airs show the
 * landing. A crash or respawn never snaps: everything goes through damp().
 */
import { clamp, damp, smoothstep } from '../math/utils.js';
import { surfaceY } from './TerrainRenderer.js';

export class Camera {
  constructor() {
    this.width = 1;
    this.height = 1;
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.scale = 1;
    this.baseScale = 1;
    this.anchorX = 0;
    this.anchorY = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.shakeAmp = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.initialized = false;
    this.portrait = false;
    /** debug multiplier for close-up screenshots (harness ?camzoom=) */
    this.debugZoom = 1;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.portrait = height > width * 1.05;
    // Landscape: ~900 world px of height at zoom 1. Portrait: fit ~760 px of width.
    this.baseScale = Math.min(height / 800, width / 700);
    if (this.portrait) this.baseScale = Math.min(height / 860, width / 440);
  }

  addShake(amount) {
    this.shakeAmp = Math.min(14, Math.max(this.shakeAmp, amount));
  }

  /**
   * @param {import('../contracts.js').RiderView} rider
   * @param {import('../contracts.js').Course} course
   * @param {number} dt seconds
   * @param {number} timeMs
   * @param {boolean} cinematic
   */
  update(rider, course, dt, timeMs, cinematic) {
    // cinematic (home / lobby): rider right of centre, clear of the UI panel and wordmark
    const ax = cinematic ? (this.portrait ? 0.5 : 0.6) : this.portrait ? 0.27 : 0.32;
    const ay = this.portrait ? 0.5 : 0.58;
    this.anchorX = this.initialized ? damp(this.anchorX, this.width * ax, 2, dt) : this.width * ax;
    this.anchorY = this.height * ay;

    const speed = Math.hypot(rider.vx, rider.vy);
    const ground = course ? surfaceY(course, rider.x) : rider.y;
    const air = clamp(ground - rider.y, 0, 2000);

    let zoomT;
    let tx;
    let ty;
    let followY = 7;
    let followZ = 1.6;
    if (cinematic) {
      const t = timeMs / 1000;
      zoomT = 0.74 + 0.04 * Math.sin(t * 0.07);
      tx = rider.x + Math.sin(t * 0.05) * 40;
      ty = (course ? surfaceY(course, tx) : rider.y) - 50 + Math.sin(t * 0.083) * 20;
      followY = 1.2;
      followZ = 0.6;
    } else {
      // Look ahead: a fraction of a second along the velocity, clamped.
      const lx = clamp(rider.vx * 0.22, -60, 260);
      const ly = clamp(rider.vy * 0.12, -80, 120);
      this.lookX = damp(this.lookX, lx, 2.5, dt);
      this.lookY = damp(this.lookY, ly, 2.0, dt);
      zoomT = 1 - 0.2 * smoothstep(350, 1300, speed) - 0.24 * smoothstep(60, 650, air);
      if (this.portrait) zoomT *= 0.9;
      zoomT = clamp(zoomT, 0.62, 1);
      tx = rider.x + this.lookX;
      // In the air keep the ground in view: aim between rider and ground.
      ty = rider.y + this.lookY + air * 0.45;
    }

    if (!this.initialized) {
      this.x = tx;
      this.y = ty;
      this.zoom = zoomT;
      this.initialized = true;
    } else {
      // x tracks tightly (the rider is fast); big gaps (respawn) still ease.
      const gapX = Math.abs(tx - this.x);
      this.x = damp(this.x, tx, cinematic ? 1.0 : gapX > 600 ? 4 : 12, dt);
      this.y = damp(this.y, ty, followY, dt);
      this.zoom = damp(this.zoom, zoomT, followZ, dt);
    }
    this.scale = this.baseScale * this.zoom * this.debugZoom;

    // Shake: small deterministic wobble decaying quickly.
    this.shakeAmp = damp(this.shakeAmp, 0, 7, dt);
    const s = timeMs / 1000;
    this.shakeX = this.shakeAmp * (Math.sin(s * 71.3) * 0.6 + Math.sin(s * 113.7) * 0.4);
    this.shakeY = this.shakeAmp * (Math.sin(s * 89.1 + 1.3) * 0.6 + Math.sin(s * 57.9) * 0.4);
    if (this.shakeAmp < 0.05) this.shakeX = this.shakeY = 0;
  }

  sx(x) {
    return (x - this.x) * this.scale + this.anchorX + this.shakeX;
  }

  sy(y) {
    return (y - this.y) * this.scale + this.anchorY + this.shakeY;
  }

  worldToScreen(x, y) {
    return { x: this.sx(x), y: this.sy(y) };
  }

  /** World x at a screen x. */
  worldX(sx) {
    return (sx - this.anchorX - this.shakeX) / this.scale + this.x;
  }

  worldY(sy) {
    return (sy - this.anchorY - this.shakeY) / this.scale + this.y;
  }

  /** Applies the world transform to a 2D context (on top of the pixel-density base transform). */
  apply(ctx, dpr) {
    const s = this.scale * dpr;
    ctx.setTransform(s, 0, 0, s, (this.anchorX + this.shakeX - this.x * this.scale) * dpr, (this.anchorY + this.shakeY - this.y * this.scale) * dpr);
  }
}

