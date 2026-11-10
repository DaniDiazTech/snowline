/**
 * Clocks and host-clock synchronisation.
 *
 * A Clock is { now(), setTimeout, clearTimeout, setInterval, clearInterval }.
 * `systemClock` uses performance.now() (the timebase of StartInfo.goAtLocalMs);
 * `ManualClock` is a deterministic clock for tests (advance it explicitly).
 *
 * ClockSync estimates `offset = hostNow - localNow` from ping/pong samples
 * (NTP-style: offset = hostStamp - (sentLocal + recvLocal) / 2). The sample with
 * the smallest round trip among the most recent ones wins, because a short round
 * trip bounds the asymmetry error to ±rtt/2.
 */

/** @typedef {{now:()=>number, setTimeout:Function, clearTimeout:Function, setInterval:Function, clearInterval:Function}} Clock */

/** @type {Clock} */
export const systemClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

export class ClockSync {
  /** @param {number} [window] how many recent samples are considered */
  constructor(window = 8) {
    this.window = window;
    /** @type {{rtt:number, offset:number}[]} */
    this.samples = [];
    this.offset = 0;
    this.rtt = NaN;
  }

  get synced() {
    return this.samples.length > 0;
  }

  reset() {
    this.samples = [];
    this.offset = 0;
    this.rtt = NaN;
  }

  /** Record one exchange: local send time, host stamp, local receive time. */
  addSample(sentLocal, hostStamp, recvLocal) {
    const rtt = recvLocal - sentLocal;
    if (!(rtt >= 0) || rtt > 10000 || !Number.isFinite(hostStamp)) return false;
    this.samples.push({ rtt, offset: hostStamp - (sentLocal + recvLocal) / 2 });
    if (this.samples.length > this.window) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.rtt = best.rtt;
    return true;
  }

  /** Rough offset (e.g. from a snapshot timestamp) used only until a real sample exists. */
  setRough(offset) {
    if (!this.synced && Number.isFinite(offset)) this.offset = offset;
  }

  toLocal(hostMs) {
    return hostMs - this.offset;
  }

  toHost(localMs) {
    return localMs + this.offset;
  }
}

/**
 * Deterministic clock for tests. Timers fire in time order during `advance()`;
 * pending promises/microtasks are flushed between timers.
 */
export class ManualClock {
  constructor(start = 1000) {
    this._now = start;
    this._seq = 0;
    /** @type {Map<number, {at:number, fn:Function, every:number, seq:number}>} */
    this._timers = new Map();
    this.now = this.now.bind(this);
    this.setTimeout = this.setTimeout.bind(this);
    this.clearTimeout = this.clearTimeout.bind(this);
    this.setInterval = this.setInterval.bind(this);
    this.clearInterval = this.clearInterval.bind(this);
  }

  now() {
    return this._now;
  }

  setTimeout(fn, ms = 0) {
    const id = ++this._seq;
    this._timers.set(id, { at: this._now + Math.max(0, ms), fn, every: 0, seq: id });
    return id;
  }

  clearTimeout(id) {
    this._timers.delete(id);
  }

  setInterval(fn, ms) {
    const id = ++this._seq;
    const every = Math.max(1, ms);
    this._timers.set(id, { at: this._now + every, fn, every, seq: id });
    return id;
  }

  clearInterval(id) {
    this._timers.delete(id);
  }

  /** Advance virtual time by `ms`, running due timers in order. */
  async advance(ms) {
    const target = this._now + ms;
    await flush();
    for (;;) {
      let next = null;
      let nextId = 0;
      for (const [id, t] of this._timers) {
        if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) {
          next = t;
          nextId = id;
        }
      }
      if (!next) break;
      this._now = Math.max(this._now, next.at);
      if (next.every) {
        next.at += next.every;
        next.seq = ++this._seq;
      } else this._timers.delete(nextId);
      try {
        next.fn();
      } catch (err) {
        console.error(err);
      }
      await flush();
    }
    this._now = target;
    await flush();
  }
}

async function flush() {
  for (let i = 0; i < 4; i++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
}
