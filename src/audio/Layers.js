import { clamp } from './dsp.js';

/**
 * Continuous, per-frame driven layers: board carve hiss, wind, weather beds
 * and thunder. All sources are long-lived looping noise (created once).
 */
export class Layers {
  constructor(ctx, out, noises, speedRef = 1300) {
    this.ctx = ctx;
    this.out = out;
    this.noises = noises;
    this.speedRef = speedRef;
    this.cache = {};
    this.lastThunder = -99;
    this.lastFlash = 0;
    this.thunderBus = null;
    this.onThunder = null;

    const loop = (buf) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(0, Math.random() * 2);
      return s;
    };
    const filt = (type, f, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = q;
      return b;
    };
    const gain = () => { const g = ctx.createGain(); g.gain.value = 0; g.connect(out); return g; };

    // carve (white through a band), zing on grind, low rumble on ground
    this.carveF = filt('bandpass', 900, 0.7);
    this.carveG = gain();
    loop(noises.white).connect(this.carveF); this.carveF.connect(this.carveG);

    this.zingF = filt('bandpass', 3800, 9);
    this.zingG = gain();
    loop(noises.white).connect(this.zingF); this.zingF.connect(this.zingG);

    this.rumbleG = gain();
    const rl = filt('lowpass', 260, 0.5);
    loop(noises.brown).connect(rl); rl.connect(this.rumbleG);

    // wind
    this.windF = filt('bandpass', 500, 0.6);
    this.windG = gain();
    loop(noises.pink).connect(this.windF); this.windF.connect(this.windG);
    this._lfo(this.windG, 0.13, 0.012);

    // weather beds
    this.snowF = filt('bandpass', 900, 0.4);
    this.snowG = gain();
    loop(noises.pink).connect(this.snowF); this.snowF.connect(this.snowG);
    this._lfo(this.snowG, 0.07, 0.012);

    const rainHp = filt('highpass', 1800, 0.5);
    const rainLp = filt('lowpass', 8000, 0.5);
    this.rainG = gain();
    loop(noises.white).connect(rainHp); rainHp.connect(rainLp); rainLp.connect(this.rainG);

    const fogLp = filt('lowpass', 350, 0.5);
    this.fogG = gain();
    loop(noises.pink).connect(fogLp); fogLp.connect(this.fogG);
  }

  _lfo(targetGain, hz, depth) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.value = hz;
    const d = ctx.createGain();
    d.gain.value = depth;
    o.connect(d); d.connect(targetGain.gain);
    o.start();
  }

  _set(key, param, v, tc = 0.12) {
    const prev = this.cache[key];
    if (prev !== undefined && Math.abs(prev - v) < 0.002 * Math.max(1, Math.abs(prev)) && v !== 0) return;
    if (prev === v) return;
    this.cache[key] = v;
    param.setTargetAtTime(v, this.ctx.currentTime, tc);
  }

  update(view) {
    const sp = clamp((view.speed || 0) / this.speedRef, 0, 1.3);
    const mode = view.mode;
    const grind = mode === 'grind';
    const ground = mode === 'ground' || mode === 'finished' || grind;
    const air = mode === 'air';
    const amt = clamp(view.weatherAmt || 0, 0, 1);
    const w = view.weather;

    const carve = ground ? (0.05 + 0.2 * Math.pow(sp, 1.3)) * (grind ? 0.55 : 1) : 0;
    this._set('carve', this.carveG.gain, carve, ground ? 0.08 : 0.04);
    this._set('carveF', this.carveF.frequency, 500 + 3000 * sp + (grind ? 800 : 0), 0.1);
    this._set('zing', this.zingG.gain, grind ? 0.05 + 0.1 * sp : 0, 0.05);
    this._set('zingF', this.zingF.frequency, 3200 + 1800 * sp, 0.1);
    this._set('rumble', this.rumbleG.gain, ground && !grind ? 0.12 * sp : 0, 0.15);

    const wind = 0.03 + 0.2 * Math.pow(sp, 1.2) + (air ? 0.07 : 0) + (w === 'storm' ? 0.05 * amt : 0);
    this._set('wind', this.windG.gain, wind, 0.25);
    this._set('windF', this.windF.frequency, 350 + 1500 * sp + (air ? 400 : 0), 0.25);

    this._set('snow', this.snowG.gain, w === 'snow' ? 0.05 * amt : w === 'storm' ? 0.07 * amt : 0, 0.4);
    this._set('rain', this.rainG.gain, w === 'storm' ? 0.1 * amt : 0, 0.4);
    this._set('fog', this.fogG.gain, w === 'fog' ? 0.05 * amt : 0, 0.5);

    const flash = view.flash || 0;
    const now = this.ctx.currentTime;
    if (flash > 0.5 && this.lastFlash <= 0.5 && now - this.lastThunder > 7 && this.onThunder) {
      this.lastThunder = now;
      this.onThunder(now + 0.35 + Math.random() * 1.2);
    }
    this.lastFlash = flash;
  }
}
