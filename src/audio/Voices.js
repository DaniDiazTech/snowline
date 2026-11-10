import { clamp } from './dsp.js';

/**
 * One-shot voice factory with a polyphony cap. Every node created here is
 * stopped and disconnected when it finishes, so nothing accumulates.
 */
export class Voices {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} dry  destination
   * @param {AudioNode} wet  reverb-send destination
   * @param {AudioBuffer} noiseBuf
   */
  constructor(ctx, dry, wet, noiseBuf, max = 36) {
    this.ctx = ctx;
    this.dry = dry;
    this.wet = wet;
    this.noiseBuf = noiseBuf;
    this.max = max;
    this.active = 0;
  }

  _env(gain, t, peak, a, dur) {
    const p = gain.gain;
    p.setValueAtTime(0.0001, t);
    p.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + Math.max(0.002, a));
    p.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  _finish(src, nodes) {
    this.active++;
    src.onended = () => {
      this.active--;
      for (const n of nodes) {
        try { n.disconnect(); } catch (e) { /* already gone */ }
      }
    };
  }

  /** o: {f, f1?, glide?, type?, dur, a?, g?, wet?, lp?, detune?} */
  tone(t, o) {
    if (this.active >= this.max) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + (o.glide || o.dur));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    this._env(g, t, o.g ?? 0.2, o.a ?? 0.005, o.dur);
    const nodes = [osc, g];
    let head = osc;
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      osc.connect(f);
      head = f;
      nodes.push(f);
    }
    head.connect(g);
    g.connect(this.dry);
    if (o.wet !== false && this.wet && (o.wet ?? 0) > 0) {
      const w = ctx.createGain();
      w.gain.value = o.wet;
      g.connect(w);
      w.connect(this.wet);
      nodes.push(w);
    }
    this._finish(osc, nodes);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  /** o: {type?, f, f1?, q?, dur, a?, g?, wet?} filtered noise burst */
  noise(t, o) {
    if (this.active >= this.max) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.Q.value = o.q ?? 0.8;
    f.frequency.setValueAtTime(o.f, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
    const g = ctx.createGain();
    this._env(g, t, o.g ?? 0.2, o.a ?? 0.005, o.dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.dry);
    const nodes = [src, f, g];
    if ((o.wet ?? 0) > 0 && this.wet) {
      const w = ctx.createGain();
      w.gain.value = o.wet;
      g.connect(w);
      w.connect(this.wet);
      nodes.push(w);
    }
    this._finish(src, nodes);
    src.start(t, Math.random() * Math.max(0.1, this.noiseBuf.duration - o.dur - 0.2));
    src.stop(t + o.dur + 0.05);
  }
}

export { clamp };
