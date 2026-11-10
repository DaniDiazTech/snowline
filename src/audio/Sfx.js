import { mtof, clamp } from './dsp.js';
import { Voices } from './Voices.js';

const PENTA = [0, 2, 4, 7, 9]; // major pentatonic degrees
const degToSemi = (n) => PENTA[n % 5] + 12 * Math.floor(n / 5);

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
  }

  /** Cheap per-sound rate limit (seconds). */
  _limit(key, gap) {
    const t = this.ctx.currentTime;
    if (t - (this.last[key] ?? -99) < gap) return true;
    this.last[key] = t;
    return false;
  }

  event(type, d = {}) {
    const fn = this['_' + type];
    if (fn) fn.call(this, this.ctx.currentTime + 0.005, d || {});
  }

  _jump(t) {
    const v = this.v;
    v.noise(t, { f: 350, f1: 1500, q: 0.9, dur: 0.3, a: 0.06, g: 0.1 });
    v.tone(t, { f: 150, f1: 70, dur: 0.22, g: 0.22 });
    this.chain = 0;
  }

  _land(t, d) {
    const v = this.v;
    const imp = clamp(d.impact ?? 0.4, 0, 1);
    v.tone(t, { f: 120, f1: 45, dur: 0.18 + 0.18 * imp, g: 0.12 + 0.35 * imp });
    v.noise(t, { type: 'lowpass', f: 1200, f1: 250, q: 0.5, dur: 0.12 + 0.14 * imp, g: 0.06 + 0.22 * imp });
    if (d.clean) {
      [1318.5, 1760, 2093].forEach((f, i) =>
        v.tone(t + 0.04 + i * 0.055, { f, dur: 0.5, g: 0.045, wet: 0.7, a: 0.004 }));
    }
    this.chain = 0;
  }

  _trick(t) {
    const semi = degToSemi(this.chain);
    const f = mtof(74 + Math.min(semi, 24));
    this.chain++;
    const v = this.v;
    v.tone(t, { f, dur: 0.55, g: 0.11, wet: 0.7 });
    v.tone(t, { f: f * 2.01, type: 'triangle', dur: 0.22, g: 0.04, wet: 0.5 });
  }

  _combo(t, d) {
    const mult = clamp(d.mult ?? 1, 1, 8);
    const notes = [62, 66, 69, 74, 76, 81].slice(0, Math.min(6, 2 + Math.ceil(mult)));
    const g = 0.03 + 0.007 * mult;
    notes.forEach((m, i) => {
      this.v.tone(t + i * 0.035, { f: mtof(m), type: 'triangle', dur: 1.1, g, a: 0.01, wet: 0.7, lp: 3500 });
      this.v.tone(t + i * 0.035, { f: mtof(m), dur: 1.4, g: g * 0.8, wet: 0.7 });
    });
  }

  _boost(t, d) {
    const L = clamp(d.level ?? 1, 1, 3);
    const v = this.v;
    v.noise(t, { f: 300, f1: 2200 + 800 * L, q: 1.1, dur: 0.7 + 0.25 * L, a: 0.25, g: 0.1 + 0.04 * L, wet: 0.3 });
    v.tone(t, { f: 220, f1: 330 * (1 + 0.35 * L), dur: 0.8 + 0.2 * L, a: 0.3, g: 0.05 + 0.015 * L, type: 'triangle', lp: 1500, wet: 0.5 });
    if (L >= 2) v.tone(t + 0.1, { f: 440, f1: 660 * (1 + 0.3 * L), dur: 0.9, a: 0.35, g: 0.03, wet: 0.5 });
  }

  _grindStart(t) {
    const v = this.v;
    v.noise(t, { type: 'highpass', f: 3500, q: 0.7, dur: 0.1, g: 0.2 });
    v.tone(t, { f: 1240, f1: 1180, dur: 0.12, g: 0.04, type: 'triangle' });
  }

  _grindEnd(t) {
    this.v.tone(t, { f: 1400, f1: 900, dur: 0.22, g: 0.09, wet: 0.4 });
  }

  _rockSmash(t) {
    const v = this.v;
    v.noise(t, { type: 'lowpass', f: 2200, f1: 280, q: 0.6, dur: 0.4, g: 0.35 });
    v.tone(t, { f: 100, f1: 38, dur: 0.3, g: 0.35 });
    for (let i = 0; i < 4; i++) {
      v.noise(t + 0.02 + i * 0.045 + Math.random() * 0.02, {
        f: 1000 + Math.random() * 2500, q: 2, dur: 0.05, g: 0.15 * (1 - i * 0.18),
      });
    }
  }

  _pickup(t, d) {
    const v = this.v;
    if (d.kind === 'feather') {
      v.noise(t, { type: 'highpass', f: 4000, f1: 7000, dur: 0.5, a: 0.15, g: 0.05, wet: 0.5 });
      [784, 1047, 1319].forEach((f, i) =>
        v.tone(t + i * 0.07, { f, f1: f * 1.02, dur: 0.6, g: 0.05, type: 'triangle', a: 0.03, wet: 0.7 }));
    } else if (d.kind === 'magnet') {
      v.tone(t, { f: 160, f1: 340, dur: 0.55, a: 0.15, g: 0.09, lp: 900, type: 'triangle' });
      v.tone(t, { f: 164, f1: 346, dur: 0.55, a: 0.15, g: 0.07, lp: 900, type: 'triangle' });
      v.tone(t + 0.3, { f: 880, dur: 0.4, g: 0.05, wet: 0.6 });
    } else {
      const now = this.ctx.currentTime;
      this.coinChain = now - this.lastCoin < 0.8 ? Math.min(this.coinChain + 1, 9) : 0;
      this.lastCoin = now;
      const f = mtof(88 + degToSemi(this.coinChain));
      v.tone(t, { f, dur: 0.35, g: 0.12, a: 0.002, wet: 0.5 });
      v.tone(t, { f: f * 2.4, dur: 0.12, g: 0.045, a: 0.002 });
    }
  }

  _crash(t) {
    const v = this.v;
    [[0, 1], [0.17, 0.7], [0.36, 0.45], [0.58, 0.25]].forEach(([dt, k]) => {
      v.tone(t + dt, { f: 95 - dt * 40, f1: 38, dur: 0.28, g: 0.26 * k });
      v.noise(t + dt, { type: 'lowpass', f: 900, f1: 200, q: 0.5, dur: 0.22, g: 0.16 * k });
    });
    this.duck(1.3);
    this.chain = 0;
  }

  _respawn(t) {
    [392, 523.25, 659.25].forEach((f, i) => this.v.tone(t + 0.08 * i, { f, dur: 0.7, g: 0.06, a: 0.02, wet: 0.7 }));
  }

  _chasmClear(t) {
    const v = this.v;
    v.noise(t, { f: 400, f1: 3000, q: 0.8, dur: 0.6, a: 0.15, g: 0.1, wet: 0.3 });
    [mtof(81), mtof(88)].forEach((f, i) => v.tone(t + 0.12 + i * 0.1, { f, dur: 0.9, g: 0.07, wet: 0.7 }));
  }

  _finish(t) {
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
    const t = this.ctx.currentTime + 0.005;
    const v = this.v;
    switch (name) {
      case 'click':
        v.tone(t, { f: 880, f1: 760, dur: 0.07, g: 0.11, a: 0.002 });
        v.tone(t, { f: 1760, dur: 0.04, g: 0.025, a: 0.002 });
        break;
      case 'join':
        v.tone(t, { f: 659.25, dur: 0.35, g: 0.08, wet: 0.5 });
        v.tone(t + 0.1, { f: 880, dur: 0.5, g: 0.08, wet: 0.6 });
        break;
      case 'leave':
        v.tone(t, { f: 880, dur: 0.3, g: 0.07, wet: 0.5 });
        v.tone(t + 0.1, { f: 587.33, dur: 0.5, g: 0.07, wet: 0.6 });
        break;
      case 'countdown':
        v.tone(t, { f: 523.25, dur: 0.22, g: 0.14, a: 0.01, wet: 0.3 });
        v.tone(t, { f: 1046.5, dur: 0.12, g: 0.03, a: 0.01 });
        break;
      case 'go':
        [880, 1318.5].forEach((f) => v.tone(t, { f, dur: 0.6, g: 0.12, a: 0.01, wet: 0.5 }));
        v.tone(t, { f: 1760, type: 'triangle', dur: 0.4, g: 0.05 });
        break;
      case 'finish':
        this.fanfare(t, false);
        break;
      case 'win':
        this.fanfare(t, true);
        break;
      default:
    }
  }

  thunder(t) {
    const v = this.v;
    v.noise(t, { type: 'lowpass', f: 500, f1: 70, q: 0.7, dur: 3.4, a: 0.12, g: 0.55, wet: 0.5 });
    v.noise(t + 0.1, { type: 'lowpass', f: 240, f1: 50, q: 0.7, dur: 4.2, a: 0.4, g: 0.45, wet: 0.5 });
  }
}
