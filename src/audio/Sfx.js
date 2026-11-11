import { mtof, clamp, rand } from './dsp.js';
import { Voices } from './Voices.js';

const PENTA = [0, 2, 4, 7, 9]; // major pentatonic degrees
const degToSemi = (n) => PENTA[n % 5] + 12 * Math.floor(n / 5);

const EVENTS = new Set(['jump', 'land', 'trick', 'combo', 'boost', 'grindStart', 'grindEnd', 'rockSmash', 'pickup', 'crash', 'respawn', 'chasmClear', 'rescueStart', 'finish']);

/** Minimum spacing (s) between two instances of the same sound; extra triggers are dropped. */
const GAP = { jump: 0.12, land: 0.12, trick: 0.07, combo: 0.22, boost1: 0.5, boost2: 0.6, boost3: 0.7, coin: 0.045, grindStart: 0.25, grindEnd: 0.25, respawn: 0.5, rescueStart: 1, rockSmash: 0.08, click: 0.05, countdown: 0.2, pass: 0.8 };
/** Per-sound loudness trims, measured with snowline-tests/audio/mix-qa.mjs (peak over the music+carve bed). */
const TRIM = { jump: 0.409, land: 0.72, trick: 1.122, combo: 0.793, boost1: 1.364, boost2: 1.537, boost3: 1.682, grindStart: 0.785, grindEnd: 1.484, rockSmash: 0.496, coin: 1.056, feather: 1.125, magnet: 1.938, respawn: 1.574, chasmClear: 1.586, crash: 1.988, finish: 1.878, click: 1.147, join: 1.506, leave: 1.682, countdown: 1.054, go: 0.751, uifinish: 1.912, win: 2.804 };

/** One-shot sound effects. Everything scheduled on the audio clock. */
export class Sfx {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{dry:AudioNode, wet:AudioNode, duck:(secs:number)=>void}} io
   */
  constructor(ctx, io, noiseBuf) {
    this.ctx = ctx;
    this.v = new Voices(ctx, io.dry, io.wet, noiseBuf);
    this.duck = io.duck;
    this.chain = 0;
    this.coinChain = 0;
    this.lastCoin = -99;
    this.last = {};
    this.recent = [];
  }

  /**
   * Start time of a one-shot. The master compressor/limiter needs ~100 ms to settle after the context is
   * created (measured: a click fired at t=5 ms comes out ~14 dB quieter), so anything triggered in the
   * first moments of the context's life is pushed back to that point.
   */
  _t0() {
    const now = this.ctx.currentTime;
    return now + 0.005 + Math.max(0, 0.12 - now);
  }

  /** Cheap per-sound rate limit (seconds). Returns true when the sound must be dropped. */
  _limit(key, gap) {
    const t = this.ctx.currentTime;
    if (t - (this.last[key] ?? -99) < gap) return true;
    this.last[key] = t;
    return false;
  }

  /**
   * Common gate for every one-shot: rate limit, per-sound loudness trim and "crowd" attenuation
   * (several cues in one landing - land + combo + boost + trick - must not stack up).
   * Returns false when the sound is dropped.
   */
  _begin(key, kind = 'cue') {
    const gap = GAP[key];
    if (gap && this._limit(key, gap)) return false;
    const now = this.ctx.currentTime;
    let crowd = 1;
    if (kind === 'cue') {
      this.recent = this.recent.filter((x) => now - x < 0.35);
      crowd = 1 / (1 + 0.22 * this.recent.length);
      this.recent.push(now);
    }
    this.v.scale = (TRIM[key] ?? 1) * crowd;
    return true;
  }

  event(type, d) {
    if (!EVENTS.has(type)) return; // unknown SimEvent types are ignored
    const fn = this['_' + type];
    const data = d && typeof d === 'object' ? d : {};
    try {
      fn.call(this, this._t0(), data);
    } finally {
      this.v.endEvent();
    }
  }

  _jump(t) {
    if (!this._begin('jump')) return;
    const v = this.v;
    v.noise(t, { f: 350, f1: 1500, q: 0.9, dur: 0.3, a: 0.06, g: 0.1 });
    v.tone(t, { f: 150, f1: 70, dur: 0.22, g: 0.22 });
    this.chain = 0;
  }

  _land(t, d) {
    if (!this._begin('land')) { this.chain = 0; return; }
    const v = this.v;
    // LAND.impact is normalised to 1400 px/s (tap jump ~0.4, pit drop ~0.7): lift it so a normal landing stays audible
    const imp = 0.4 + 0.6 * clamp(Number(d.impact ?? 0.4) || 0, 0, 1);
    v.tone(t, { f: 120, f1: 45, dur: 0.18 + 0.18 * imp, g: 0.17 + 0.11 * imp });
    v.noise(t, { type: 'lowpass', f: 1200, f1: 250, q: 0.5, dur: 0.12 + 0.14 * imp, g: 0.09 + 0.06 * imp });
    if (d.sketchy) {
      // scrappier: a scuffing hiss and a dull second thud instead of the clean chime
      v.noise(t + 0.02, { type: 'bandpass', f: 2400, f1: 900, q: 1.1, dur: 0.22, g: 0.1 });
      v.tone(t + 0.07, { f: 90, f1: 50, dur: 0.14, g: 0.1 });
    }
    if (d.clean) {
      // E - F# - A (in key)
      [1318.5, 1480, 1760].forEach((f, i) =>
        v.tone(t + 0.04 + i * 0.055, { f, dur: 0.45, g: 0.05, wet: 0.7, a: 0.004 }));
    }
    this.chain = 0;
  }

  _trick(t) {
    // tricks arrive in bursts: keep at most two alive, the chain still climbs even when a note is dropped
    const semi = degToSemi(this.chain);
    this.chain++;
    if (!this._begin('trick')) return;
    this.v.beginEvent('trick', 2);
    const f = mtof(74 + Math.min(semi, 24));
    const v = this.v;
    v.tone(t, { f, dur: 0.4, g: 0.11, wet: 0.7 });
    v.tone(t, { f: f * 2.01, type: 'triangle', dur: 0.18, g: 0.04, wet: 0.5 });
  }

  _combo(t, d) {
    if (!this._begin('combo')) return;
    this.v.beginEvent('combo', 1);
    const mult = clamp(Number(d.mult ?? 1) || 1, 1, 8);
    const notes = [62, 66, 69, 74, 76, 81].slice(0, Math.min(6, 2 + Math.ceil(mult)));
    const g = 0.04 + 0.003 * mult;
    notes.forEach((m, i) => {
      this.v.tone(t + i * 0.035, { f: mtof(m), type: 'triangle', dur: 0.9, g, a: 0.01, wet: 0.7, lp: 3500 });
      this.v.tone(t + i * 0.035, { f: mtof(m), dur: 1.1, g: g * 0.8, wet: 0.7 });
    });
  }

  /**
   * Boost whoosh. Fires on every landed trick (often every 1-3 s), so it is short and soft: tier 1 is a
   * tiny puff, tier 3 the big one. One whoosh at a time (a new one steals the old one), rate limited.
   */
  _boost(t, d) {
    const L = clamp(Math.round(Number(d.level ?? 1) || 1), 1, 3);
    if (!this._begin('boost' + L)) return;
    this.v.beginEvent('boost', 1);
    const v = this.v;
    v.noise(t, { f: 300, f1: 1400 + 700 * L, q: 1.0, dur: 0.38 + 0.2 * L, a: 0.12 + 0.04 * L, g: 0.1 + 0.03 * L, wet: 0.25 });
    v.tone(t, { f: 220, f1: 330 * (1 + 0.3 * L), dur: 0.45 + 0.17 * L, a: 0.15, g: 0.05 + 0.012 * L, type: 'triangle', lp: 1500, wet: 0.4 });
    if (L >= 2) v.tone(t + 0.06, { f: 440, f1: 660 * (1 + 0.25 * L), dur: 0.5 + 0.1 * L, a: 0.2, g: 0.03, wet: 0.4 });
    if (L >= 3) v.tone(t + 0.12, { f: mtof(86), dur: 0.7, a: 0.03, g: 0.035, wet: 0.7 });
  }

  _grindStart(t) {
    if (!this._begin('grindStart')) return;
    const v = this.v;
    v.noise(t, { type: 'highpass', f: 3000, q: 0.7, dur: 0.12, g: 0.2 });
    v.tone(t, { f: 1175, f1: 1110, dur: 0.14, g: 0.05, type: 'triangle' });
    v.noise(t + 0.01, { type: 'bandpass', f: 1800, q: 1.2, dur: 0.16, g: 0.12 });
  }

  _grindEnd(t) {
    if (!this._begin('grindEnd')) return;
    this.v.tone(t, { f: 1400, f1: 900, dur: 0.22, g: 0.09, wet: 0.4 });
  }

  _rockSmash(t) {
    // fires for any obstacle kind (rock, log, snowman, ...), so no payload is required
    if (!this._begin('rockSmash')) return;
    const v = this.v;
    v.noise(t, { type: 'lowpass', f: 2200, f1: 280, q: 0.6, dur: 0.4, g: 0.35 });
    v.tone(t, { f: 100, f1: 38, dur: 0.3, g: 0.35 });
    for (let i = 0; i < 4; i++) {
      v.noise(t + 0.02 + i * 0.045 + rand() * 0.02, {
        f: 1000 + rand() * 2500, q: 2, dur: 0.05, g: 0.15 * (1 - i * 0.18),
      });
    }
  }

  _pickup(t, d) {
    const v = this.v;
    if (d.kind === 'feather') {
      if (!this._begin('feather')) return;
      v.noise(t, { type: 'highpass', f: 4000, f1: 7000, dur: 0.5, a: 0.15, g: 0.05, wet: 0.5 });
      // G - B - D
      [784, 987.77, 1174.66].forEach((f, i) =>
        v.tone(t + i * 0.07, { f, f1: f * 1.02, dur: 0.6, g: 0.05, type: 'triangle', a: 0.03, wet: 0.7 }));
    } else if (d.kind === 'magnet') {
      if (!this._begin('magnet')) return;
      v.tone(t, { f: 160, f1: 340, dur: 0.55, a: 0.15, g: 0.09, lp: 900, type: 'triangle' });
      v.tone(t, { f: 164, f1: 346, dur: 0.55, a: 0.15, g: 0.07, lp: 900, type: 'triangle' });
      v.tone(t + 0.3, { f: 880, dur: 0.4, g: 0.05, wet: 0.6 });
    } else {
      // coin (also the fallback for unknown kinds): rising pentatonic chain on D major
      const now = this.ctx.currentTime;
      const chain = now - this.lastCoin < 0.8 ? Math.min(this.coinChain + 1, 9) : 0;
      if (!this._begin('coin')) return;
      this.coinChain = chain;
      this.lastCoin = now;
      this.v.beginEvent('coin', 4);
      const f = mtof(86 + degToSemi(this.coinChain)); // D6 E6 F#6 A6 B6 ...
      v.tone(t, { f, dur: 0.28, g: 0.12, a: 0.002, wet: 0.5 });
      v.tone(t, { f: f * 2.4, dur: 0.1, g: 0.045, a: 0.002 });
    }
  }

  _crash(t) {
    this._begin('crash', 'big');
    const v = this.v;
    [[0, 1], [0.17, 0.7], [0.36, 0.45], [0.58, 0.25]].forEach(([dt, k]) => {
      v.tone(t + dt, { f: 95 - dt * 40, f1: 38, dur: 0.28, g: 0.26 * k });
      v.noise(t + dt, { type: 'lowpass', f: 900, f1: 200, q: 0.5, dur: 0.22, g: 0.16 * k });
    });
    this.duck(1.3);
    this.chain = 0;
  }

  _respawn(t) {
    if (!this._begin('respawn')) return;
    // G - B - D
    [392, 493.88, 587.33].forEach((f, i) => this.v.tone(t + 0.08 * i, { f, dur: 0.7, g: 0.06, a: 0.02, wet: 0.7 }));
  }

  /** Fell into a pit: a soft rising whoosh and a few airy notes while the balloon lifts the rider across. */
  _rescueStart(t) {
    if (!this._begin('rescueStart')) return;
    const v = this.v;
    v.noise(t, { f: 300, f1: 1800, q: 0.8, dur: 1.2, a: 0.4, g: 0.06, wet: 0.4 });
    v.tone(t, { f: 220, f1: 440, dur: 1.4, a: 0.5, g: 0.04, type: 'triangle', lp: 1400, wet: 0.5 });
    // D - F# - A - D, slowly climbing
    [mtof(74), mtof(78), mtof(81), mtof(86)].forEach((f, i) => v.tone(t + 0.25 + i * 0.3, { f, dur: 0.8, g: 0.035, a: 0.05, wet: 0.7 }));
  }

  _chasmClear(t) {
    if (!this._begin('chasmClear')) return;
    const v = this.v;
    v.noise(t, { f: 400, f1: 3000, q: 0.8, dur: 0.6, a: 0.15, g: 0.1, wet: 0.3 });
    [mtof(81), mtof(88)].forEach((f, i) => v.tone(t + 0.12 + i * 0.1, { f, dur: 0.9, g: 0.07, wet: 0.7 }));
  }

  _finish(t) {
    this._begin('finish', 'big');
    this.fanfare(t, false);
  }

  fanfare(t, big) {
    const v = this.v;
    const seq = [74, 78, 81, 86, 90];
    seq.forEach((m, i) => {
      v.tone(t + i * 0.1, { f: mtof(m), type: 'triangle', dur: 1.0, g: 0.06, wet: 0.7, lp: 5000 });
      v.tone(t + i * 0.1, { f: mtof(m), dur: 1.2, g: 0.04, wet: 0.7 });
    });
    const tail = t + seq.length * 0.1;
    const chord = big ? [62, 66, 69, 74, 78, 81] : [74, 78, 81, 86];
    chord.forEach((m) => v.tone(tail, { f: mtof(m), type: 'triangle', dur: big ? 2.8 : 1.8, g: big ? 0.04 : 0.035, a: 0.03, wet: 0.8, lp: 4000 }));
  }

  ui(name) {
    const t = this._t0();
    const v = this.v;
    try {
      switch (name) {
        case 'click':
          if (!this._begin('click')) break;
          v.tone(t, { f: 880, f1: 760, dur: 0.09, g: 0.12, a: 0.002 });
          v.tone(t, { f: 1760, dur: 0.05, g: 0.04, a: 0.002 });
          break;
        case 'join':
          this._begin('join');
          v.tone(t, { f: 659.25, dur: 0.35, g: 0.08, wet: 0.5 });
          v.tone(t + 0.1, { f: 880, dur: 0.5, g: 0.08, wet: 0.6 });
          break;
        case 'leave':
          this._begin('leave');
          v.tone(t, { f: 880, dur: 0.3, g: 0.07, wet: 0.5 });
          v.tone(t + 0.1, { f: 587.33, dur: 0.5, g: 0.07, wet: 0.6 });
          break;
        case 'countdown':
          if (!this._begin('countdown')) break;
          v.tone(t, { f: 587.33, dur: 0.22, g: 0.14, a: 0.01, wet: 0.3 });
          v.tone(t, { f: 1174.66, dur: 0.12, g: 0.03, a: 0.01 });
          break;
        case 'go':
          this._begin('go');
          [880, 1318.5].forEach((f) => v.tone(t, { f, dur: 0.6, g: 0.12, a: 0.01, wet: 0.5 }));
          v.tone(t, { f: 1760, type: 'triangle', dur: 0.4, g: 0.05 });
          break;
        case 'pass':
          // a short airy whoosh for overtakes (position callouts)
          if (!this._begin('pass')) break;
          v.noise(t, { type: 'bandpass', f: 700, f1: 2600, q: 1.2, dur: 0.32, a: 0.08, g: 0.07, wet: 0.3 });
          v.tone(t + 0.05, { f: 1318.5, dur: 0.18, g: 0.025, a: 0.01 });
          break;
        case 'finish':
          this._begin('uifinish', 'big');
          this.fanfare(t, false);
          break;
        case 'win':
          this._begin('win', 'big');
          this.fanfare(t, true);
          break;
        default:
      }
    } finally {
      v.endEvent();
    }
  }

  thunder(t) {
    this.v.scale = TRIM.thunder ?? 1;
    const v = this.v;
    v.noise(t, { type: 'lowpass', f: 500, f1: 70, q: 0.7, dur: 3.4, a: 0.12, g: 0.55, wet: 0.5 });
    v.noise(t + 0.1, { type: 'lowpass', f: 240, f1: 50, q: 0.7, dur: 4.2, a: 0.4, g: 0.45, wet: 0.5 });
    v.endEvent();
  }
}
