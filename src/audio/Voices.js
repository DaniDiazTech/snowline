import { clamp, rand } from './dsp.js';

/**
 * One-shot voice factory with a polyphony cap. Every node created here is
 * stopped and disconnected when it finishes, so nothing accumulates.
 *
 * Extras used by Sfx:
 *   scale                  multiplies the gain of every voice created while set (per-sound trim)
 *   beginEvent(group, n)   voices created until endEvent() belong to one "event" of `group`; when more
 *                          than n events of the group are alive the oldest ones are stolen (30 ms fade)
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
    this.scale = 1;
    this.group = null;
    this.ev = 0;
    this.evSeq = 0;
    this.groups = new Map();
  }

  beginEvent(group, maxEvents = 1) {
    const now = this.ctx.currentTime;
    let list = (this.groups.get(group) || []).filter((e) => e.end > now);
    this.groups.set(group, list);
    const ids = [...new Set(list.map((e) => e.ev))];
    for (let i = 0; i < ids.length - (maxEvents - 1); i++) {
      for (const e of list) if (e.ev === ids[i]) this._steal(e, now);
      list = list.filter((e) => e.ev !== ids[i]);
      this.groups.set(group, list);
    }
    this.group = group;
    this.ev = ++this.evSeq;
  }

  endEvent() {
    this.group = null;
    this.scale = 1;
  }

  _steal(e, now) {
    try {
      const p = e.steal.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(1, now);
      p.linearRampToValueAtTime(0, now + 0.03);
      e.src.stop(now + 0.05);
    } catch (err) { /* already stopped */ }
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

  /** Output node of a voice; grouped voices get a dedicated gain so they can be stolen without clicks. */
  _out(g, t, dur, src, nodes) {
    if (!this.group) return g;
    const steal = this.ctx.createGain();
    g.connect(steal);
    nodes.push(steal);
    const list = this.groups.get(this.group) || [];
    list.push({ ev: this.ev, steal, src, end: t + dur });
    this.groups.set(this.group, list);
    return steal;
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
    this._env(g, t, (o.g ?? 0.2) * this.scale, o.a ?? 0.005, o.dur);
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
    const out = this._out(g, t, o.dur + 0.05, osc, nodes);
    out.connect(this.dry);
    if (o.wet !== false && this.wet && (o.wet ?? 0) > 0) {
      const w = ctx.createGain();
      w.gain.value = o.wet;
      out.connect(w);
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
    this._env(g, t, (o.g ?? 0.2) * this.scale, o.a ?? 0.005, o.dur);
    src.connect(f);
    f.connect(g);
    const nodes = [src, f, g];
    const out = this._out(g, t, o.dur + 0.05, src, nodes);
    out.connect(this.dry);
    if ((o.wet ?? 0) > 0 && this.wet) {
      const w = ctx.createGain();
      w.gain.value = o.wet;
      out.connect(w);
      w.connect(this.wet);
      nodes.push(w);
    }
    this._finish(src, nodes);
    src.start(t, rand() * Math.max(0.1, this.noiseBuf.duration - o.dur - 0.2));
    src.stop(t + o.dur + 0.05);
  }
}

export { clamp };
