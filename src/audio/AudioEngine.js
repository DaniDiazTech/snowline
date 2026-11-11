import { clamp, lerp, makeNoiseBuffer, makeImpulse, mulberry32, seedRandom } from './dsp.js';
import { Music } from './Music.js';
import { Layers } from './Layers.js';
import { Sfx } from './Sfx.js';

/**
 * Snowline AudioEngine - fully procedural WebAudio, no asset files.
 *
 *   unlock()                 call from a user gesture (safe to repeat)
 *   setMuted(bool) / muted
 *   setVolume(0..1) / volume master volume (additive)
 *   startMusic(mood) / stopMusic()      'menu' | 'race' | 'results'
 *   onSimEvent({type,data})  SFX for SimEvents
 *   update(view)             per frame: carve hiss, wind, weather, thunder, music mood
 *   ui(name)                 'click'|'join'|'leave'|'countdown'|'go'|'finish'|'win'
 *
 * Extras (not part of the contract): `AudioEngine.forContext(ctx)` builds the
 * graph on any BaseAudioContext (e.g. OfflineAudioContext) with no timers; then
 * call `prepareOffline(seconds)` before `startRendering()`. `speedRef` is the
 * speed (px/s) treated as "full speed" by the speed-driven layers.
 *
 * Every public method is a silent no-op before unlock and never throws.
 *
 * CPU: the realtime context is suspended while muted (after the fade) and while the tab is
 * hidden, so nothing is rendered or scheduled then; the reverb is a ~2 s generated impulse.
 */
const MASTER_LEVEL = 0.8;
const LOOKAHEAD = 0.3;
/** Reverb impulse length (s) and decay exponent. 2 s keeps the snowy space at < half the convolution cost of 4.5 s. */
const REVERB_S = 2.1;
const REVERB_DECAY = 2.4;
/** After a mute fade, the context is suspended (s). */
const SUSPEND_AFTER = 0.35;

export class AudioEngine {
  constructor(opts = {}) {
    this.muted = !!opts.muted;
    this.volume = clamp(opts.volume ?? 1, 0, 1);
    this.seed = opts.seed ?? 20241;
    this.speedRef = opts.speedRef ?? 1000;
    this.ctx = null;
    this.ready = false;
    this._pendingMood = null;
    this._timer = null;
    this._realtime = true;
    this._suspendTimer = null;
    this._hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    this._onVisibility = () => {
      this._hidden = document.visibilityState === 'hidden';
      this._applyRunState();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
  }

  /** Master gain target for the current mute/volume. */
  _level() {
    return this.muted ? 0 : MASTER_LEVEL * this.volume * this.volume; // squared: perceptually even slider
  }

  /** Realtime only: run the context while audible and visible, suspend it otherwise. */
  _applyRunState() {
    if (!this._realtime || !this.ctx) return;
    clearTimeout(this._suspendTimer);
    const want = !this.muted && !this._hidden && this.volume > 0;
    try {
      if (want) {
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      } else if (this.ctx.state === 'running') {
        // hidden: stop now; muted: let the fade finish first
        const delay = this._hidden ? 0 : SUSPEND_AFTER * 1000;
        this._suspendTimer = setTimeout(() => {
          if ((this.muted || this._hidden || this.volume <= 0) && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
        }, delay);
      }
    } catch (e) { /* ignore */ }
  }

  /** Build the engine on an existing (e.g. offline) context. */
  static forContext(ctx, opts = {}) {
    const e = new AudioEngine(opts);
    e._realtime = false;
    e._init(ctx);
    return e;
  }

  unlock() {
    try {
      if (this.ctx) {
        if (this.ctx.state === 'suspended' && !this.muted && !this._hidden && this.volume > 0) this.ctx.resume().catch(() => {});
        return;
      }
      if (typeof window === 'undefined') return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this._init(new AC({ latencyHint: 'interactive' }));
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this._applyRunState();
    } catch (e) {
      this.ctx = null;
      this.ready = false;
    }
  }

  _init(ctx) {
    this.ctx = ctx;
    seedRandom(this.seed);
    const rng = mulberry32(this.seed);
    this.noise = {
      white: makeNoiseBuffer(ctx, 3, 'white'),
      pink: makeNoiseBuffer(ctx, 4, 'pink'),
      brown: makeNoiseBuffer(ctx, 4, 'brown'),
    };

    // master: gain -> compressor -> limiter -> soft clip -> destination
    this.master = ctx.createGain();
    this.master.gain.value = this._level();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 14; comp.ratio.value = 5;
    comp.attack.value = 0.006; comp.release.value = 0.25;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.08;
    const clip = ctx.createWaveShaper();
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * 1.1) * 0.9;
    clip.curve = curve;
    this.comp = comp; this.lim = lim; this.clip = clip;
    this.master.connect(comp); comp.connect(lim); lim.connect(clip); clip.connect(ctx.destination);

    // reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, REVERB_S, REVERB_DECAY, rng);
    this.revIn = ctx.createGain();
    this.revIn.gain.value = 1;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.9;
    this.revIn.connect(this.reverb); this.reverb.connect(revOut); revOut.connect(this.master);

    // music chain
    this.musicIn = ctx.createGain();
    this.musicIn.gain.value = 0.7;
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.Q.value = 0.5;
    this.musicFilter.frequency.value = 9000;
    this.musicDuck = ctx.createGain();
    const musicSend = ctx.createGain();
    musicSend.gain.value = 0.5;
    this.musicIn.connect(this.musicFilter);
    this.musicFilter.connect(this.musicDuck);
    this.musicDuck.connect(this.master);
    this.musicFilter.connect(musicSend); musicSend.connect(this.revIn);
    this.music = new Music(ctx, { out: this.musicIn, rng, noiseBuf: this.noise.white });

    // sfx + layers
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.master);
    const sfxWet = ctx.createGain();
    sfxWet.gain.value = 0.35;
    sfxWet.connect(this.revIn);
    this.sfx = new Sfx(ctx, { dry: this.sfxBus, wet: sfxWet, duck: (s) => this._duck(s) }, this.noise.white);

    this.layerBus = ctx.createGain();
    this.layerBus.gain.value = 0.55;
    this.layerBus.connect(this.master);
    this.layers = new Layers(ctx, this.layerBus, this.noise, this.speedRef);
    this.layers.onThunder = (t) => { try { this.sfx.thunder(t); } catch (e) { /* ignore */ } };

    this.ready = true;
    if (this._realtime) {
      this._timer = setInterval(() => this._pump(), 80);
    }
    if (this._pendingMood) {
      const m = this._pendingMood;
      this._pendingMood = null;
      this.startMusic(m);
    }
  }

  _pump() {
    try {
      if (!this.ready || this.ctx.state !== 'running') return;
      this.music.scheduleUntil(this.ctx.currentTime + LOOKAHEAD);
    } catch (e) { /* never throw from a timer */ }
  }

  /** Offline rendering: schedule all music for `seconds` of audio. */
  prepareOffline(seconds) {
    try { if (this.ready) this.music.scheduleUntil(seconds); } catch (e) { /* ignore */ }
  }

  _duck(secs) {
    const p = this.musicDuck.gain;
    const t = this.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.setTargetAtTime(0.35, t, 0.05);
    p.setTargetAtTime(1, t + secs, 0.4);
  }

  setMuted(muted) {
    this.muted = !!muted;
    this._applyLevel();
  }

  /** Additive: master volume 0..1 (persisted by the game). */
  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    this._applyLevel();
  }

  _applyLevel() {
    try {
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.setTargetAtTime(this._level(), t, 0.06);
      this._applyRunState();
    } catch (e) { /* ignore */ }
  }

  startMusic(mood) {
    try {
      if (!this.ready) { this._pendingMood = mood; return; }
      this.music.start(mood, this.ctx.currentTime);
      if (this._realtime) this._pump();
    } catch (e) { /* ignore */ }
  }

  stopMusic() {
    try {
      this._pendingMood = null;
      if (this.ready) this.music.stop(this.ctx.currentTime);
    } catch (e) { /* ignore */ }
  }

  onSimEvent(ev) {
    try {
      if (!this.ready || this.muted || !ev || !ev.type) return;
      this.sfx.event(ev.type, ev.data);
    } catch (e) { /* ignore */ }
  }

  ui(name) {
    try {
      if (!this.ready || this.muted) return;
      this.sfx.ui(name);
    } catch (e) { /* ignore */ }
  }

  update(view) {
    try {
      if (!this.ready || !view || (this._realtime && this.ctx.state !== 'running')) return;
      this.layers.update(view);
      this.music.setIntensity((view.boostLevel || 0) / 3);
      const night = clamp(view.night || 0, 0, 1);
      const cutoff = lerp(9500, 3200, night) * (1 + 0.35 * this.music.intensity);
      const t = this.ctx.currentTime;
      if (this._lastCut === undefined || Math.abs(cutoff - this._lastCut) > 25) {
        this._lastCut = cutoff;
        this.musicFilter.frequency.setTargetAtTime(cutoff, t, 0.6);
      }
    } catch (e) { /* ignore */ }
  }
}

export default AudioEngine;
