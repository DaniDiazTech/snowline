import { mtof, clamp } from './dsp.js';

/**
 * Generative ambient music: felt-piano plucks + warm pads over a slow
 * I - vi - IV - V (D major / lydian colour) movement. Note choice is seeded
 * random, so it never loops obviously but is reproducible.
 *
 * The scheduler is clock-agnostic: call `scheduleUntil(t)` with an audio-clock
 * time. Live, AudioEngine drives it from a timer; offline, it is called once.
 */
const BPM = 62;
const STEP = 60 / BPM / 2; // half a beat
const STEPS_PER_CHORD = 16; // 8 beats

// bass, pad voicing and arpeggio pool (MIDI). Key of D.
const CHORDS = [
  { bass: 38, pad: [50, 57, 61, 66], pool: [57, 62, 64, 66, 69, 73, 76, 78] }, // Dmaj9
  { bass: 35, pad: [54, 59, 62, 66], pool: [57, 59, 62, 66, 69, 71, 73, 74] }, // Bm9
  { bass: 31, pad: [55, 59, 62, 66], pool: [59, 62, 64, 66, 67, 71, 73, 74] }, // Gmaj7#11
  { bass: 33, pad: [52, 57, 61, 66], pool: [57, 59, 61, 64, 66, 69, 71, 73] }, // Aadd9
];
const PROGRESSIONS = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 1, 2, 0], [0, 3, 2, 3]];

const MOODS = {
  menu: { padG: 0.8, arp: 0.22, off: 0, pulse: false },
  race: { padG: 0.65, arp: 0.8, off: 0.25, pulse: true },
  results: { padG: 0.9, arp: 0, off: 0, pulse: false },
};

export class Music {
  constructor(ctx, { out, rng, noiseBuf }) {
    this.ctx = ctx;
    this.out = out; // musicIn
    this.rng = rng;
    this.noiseBuf = noiseBuf;
    this.mood = null;
    this.bus = null;
    this.retiring = [];
    this.stepIdx = 0;
    this.nextT = 0;
    this.prog = PROGRESSIONS[0];
    this.chord = CHORDS[0];
    this.arpPos = 3;
    this.resultsPos = 0;
    this.intensity = 0;
    this.intensityTarget = 0;
  }

  setIntensity(v) { this.intensityTarget = clamp(v, 0, 1); }

  start(mood, now) {
    if (!MOODS[mood] || this.mood === mood) return;
    const prev = this.mood;
    const ctx = this.ctx;
    const hadBus = !!this.bus;
    if (this.bus) this._retire(this.bus, now, 1.5);
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, now);
    bus.gain.linearRampToValueAtTime(1, now + (hadBus ? 1.5 : 0.8));
    bus.connect(this.out);
    this.bus = bus;
    this.mood = mood;

    if (prev && prev !== 'results' && mood !== 'results') {
      // keep the harmony going, bring the current chord in under the new bus
      const s = this.stepIdx % STEPS_PER_CHORD;
      const remain = (STEPS_PER_CHORD - s) % STEPS_PER_CHORD;
      if (remain > 0) this._pad(this.chord, now + 0.02, remain * STEP + 1, 1.5);
    } else {
      this.stepIdx = 0;
      this.nextT = now + 0.05;
      this.resultsPos = 0;
    }
    if (this.nextT < now) this.nextT = now + 0.05;
  }

  stop(now) {
    if (this.bus) this._retire(this.bus, now, 1.2);
    this.bus = null;
    this.mood = null;
  }

  _retire(bus, now, fade) {
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now);
    bus.gain.linearRampToValueAtTime(0.0001, now + fade);
    this.retiring.push({ bus, end: now + fade + 0.2 });
  }

  scheduleUntil(until) {
    const now = this.ctx.currentTime;
    for (let i = this.retiring.length - 1; i >= 0; i--) {
      if (now > this.retiring[i].end) {
        try { this.retiring[i].bus.disconnect(); } catch (e) { /* ignore */ }
        this.retiring.splice(i, 1);
      }
    }
    if (!this.mood) return;
    if (this.nextT < now - 0.05) this.nextT = now + 0.05; // after a stall: no burst
    let guard = 0;
    while (this.nextT < until && guard++ < 400) {
      this._step(this.nextT);
      this.nextT += STEP;
      this.stepIdx++;
    }
  }

  _step(t) {
    const rng = this.rng;
    const cfg = MOODS[this.mood];
    this.intensity += (this.intensityTarget - this.intensity) * 0.12;
    const I = this.intensity;
    const s = this.stepIdx % STEPS_PER_CHORD;
    const slot = Math.floor(this.stepIdx / STEPS_PER_CHORD);

    if (s === 0) {
      if (this.mood === 'results') {
        this.chord = CHORDS[0];
      } else {
        if (slot % 4 === 0) this.prog = PROGRESSIONS[Math.floor(rng() * PROGRESSIONS.length)];
        this.chord = CHORDS[this.prog[slot % 4]];
      }
      this._pad(this.chord, t, STEPS_PER_CHORD * STEP, 2.4);
      this._bass(this.chord.bass, t, 0.5 + 0.1 * rng());
    }
    if (this.mood === 'race' && s === 8) this._bass(this.chord.bass + 12, t, 0.18);

    const pool = this.chord.pool;
    if (this.mood === 'results') {
      if (s % 2 === 0) {
        const p = CHORDS[0].pool;
        const span = p.length * 2 - 2;
        const idx = this.resultsPos++ % span;
        const k = idx < p.length ? idx : span - idx; // up then down
        this._pluck(mtof(p[k]), t, 0.75, 3.8);
      }
      return;
    }

    // arpeggio / melody: stepwise-ish walk through the chord pool
    const onBeat = s % 2 === 0;
    let prob = onBeat ? cfg.arp : cfg.off + I * 0.35;
    if (this.mood === 'menu') prob = cfg.arp * (s % 4 === 0 ? 1.5 : 0.8);
    if (rng() < prob) {
      const dir = [-2, -1, -1, 1, 1, 2][Math.floor(rng() * 6)];
      this.arpPos = clamp(this.arpPos + dir, 0, pool.length - 1);
      if (this.arpPos === 0 && rng() < 0.4) this.arpPos = 2;
      const vel = 0.45 + 0.4 * rng() + (this.mood === 'race' ? 0.1 * I : 0);
      this._pluck(mtof(pool[this.arpPos]), t, vel, 3.2);
      if (rng() < 0.12 + 0.1 * I) this._pluck(mtof(pool[this.arpPos] + 12), t + STEP * 1.5, vel * 0.4, 2.2);
    }

    if (cfg.pulse) {
      const accent = s % 8 === 0 ? 1 : 0.7;
      if (onBeat) this._thump(t, (0.075 + 0.05 * I) * accent);
      else this._tick(t, 0.012 + 0.016 * I);
    }
  }

  _pluck(freq, t, vel, dur) {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!bus) return;
    const g = ctx.createGain();
    const peak = 0.17 * vel;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800 + 2200 * vel, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.8);
    lp.Q.value = 0.3;
    const mk = (type, f, level, d) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.setValueAtTime(level, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(og);
      og.connect(lp);
      o.start(t);
      o.stop(t + d + 0.05);
      return o;
    };
    const a = mk('sine', freq, 1, dur);
    mk('sine', freq * 1.004, 0.5, dur * 0.8);
    mk('triangle', freq * 2, 0.22, 0.9);
    lp.connect(g);
    g.connect(bus);
    a.onended = () => { try { g.disconnect(); lp.disconnect(); } catch (e) { /* ignore */ } };
  }

  _pad(chord, t, dur, attack) {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!bus) return;
    const level = MOODS[this.mood].padG * 0.2;
    const g = ctx.createGain();
    const rel = 3.2;
    const end = t + dur;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.setValueAtTime(level, Math.max(t + attack, end - 0.01));
    g.gain.linearRampToValueAtTime(0.0001, end + rel);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(450, t);
    lp.frequency.linearRampToValueAtTime(1100, t + dur * 0.6);
    lp.frequency.linearRampToValueAtTime(600, end + rel);
    lp.connect(g);
    g.connect(bus);
    let first = null;
    for (const m of chord.pad) {
      const f = mtof(m);
      for (const [type, det, lv] of [['sawtooth', -8, 0.2], ['sawtooth', 8, 0.2], ['triangle', 0, 0.35]]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        o.detune.value = det;
        const og = ctx.createGain();
        og.gain.value = lv;
        o.connect(og);
        og.connect(lp);
        o.start(t);
        o.stop(end + rel + 0.1);
        first = first || o;
      }
    }
    first.onended = () => { try { g.disconnect(); lp.disconnect(); } catch (e) { /* ignore */ } };
  }

  _bass(m, t, vel) {
    const ctx = this.ctx;
    if (!this.bus) return;
    const f = mtof(m);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * vel, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 6);
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.frequency.value = f * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.3;
    o.connect(g);
    o2.connect(g2);
    g2.connect(g);
    g.connect(this.bus);
    o.start(t); o.stop(t + 6.1);
    o2.start(t); o2.stop(t + 6.1);
    o.onended = () => { try { g.disconnect(); g2.disconnect(); } catch (e) { /* ignore */ } };
  }

  _thump(t, level) {
    const ctx = this.ctx;
    if (!this.bus) return;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.15);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g);
    g.connect(this.bus);
    o.start(t); o.stop(t + 0.32);
    o.onended = () => { try { g.disconnect(); } catch (e) { /* ignore */ } };
  }

  _tick(t, level) {
    const ctx = this.ctx;
    if (!this.bus || !this.noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 6500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(f); f.connect(g); g.connect(this.bus);
    src.start(t, Math.random() * 2); src.stop(t + 0.1);
    src.onended = () => { try { g.disconnect(); f.disconnect(); } catch (e) { /* ignore */ } };
  }
}
