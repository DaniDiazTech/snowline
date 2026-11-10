/**
 * Transport — the only file that knows about the wire technology.
 *
 *   interface Transport {
 *     connect(): Promise<void>                       // rejects Error('offline') if not connected within timeoutMs
 *     publish(topic, message, opts?:{retain?, reliable?}): boolean
 *                                                    // message: any JSON value; `null` + retain clears the retained message.
 *                                                    // Returns false (and DROPS the message, never queues) while offline.
 *     subscribe(topicFilter, handler:(topic, message)=>void): Promise<void>
 *                                                    // MQTT filters ('+' one level, '#' rest). A retained clear arrives as message === null.
 *     setLastWill?(topic, message): void             // before connect(); published by the server if we vanish without close()
 *     close(): void                                  // graceful: the last will is NOT published
 *     on('status', cb:('connecting'|'online'|'offline')=>void): ()=>void
 *     status: 'connecting'|'online'|'offline'        // additive
 *     name: string                                   // additive, e.g. broker id or 'local'
 *   }
 *
 * Implementations
 *  - MqttTransport: mqtt.js 5.16.1 (vendored lib/mqtt.esm.js) over WSS, keepalive 10 s,
 *    auto-reconnect every 1.5 s, QoS 0 for unreliable / QoS 1 for reliable, no offline queue.
 *  - LoopbackTransport: in-memory hub (unit tests, `?net=local`). The shared hub bridges
 *    same-origin tabs with BroadcastChannel so several tabs can play without internet.
 *    Test hooks: drop() simulates losing the connection (fires the will), restore() reconnects.
 */
import { Emitter } from './emitter.js';
import { systemClock } from './clock.js';

/** Messages larger than this are dropped unread (public brokers are world-writable). */
export const MAX_MESSAGE_BYTES = 16384;

/** MQTT topic filter matching. */
export function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function safeParse(text) {
  if (text.length === 0) return null;
  if (text.length > MAX_MESSAGE_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

let mqttLibPromise = null;
function loadMqtt() {
  if (!mqttLibPromise) mqttLibPromise = import('../../lib/mqtt.esm.js').then((m) => m.default || m);
  return mqttLibPromise;
}

function randomClientId() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return 'sl_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */

export class MqttTransport {
  /**
   * @param {{broker:import('./brokers.js').Broker, keepalive?:number, timeoutMs?:number, mqtt?:Object}} opts
   *   `mqtt` lets tests inject the library; by default lib/mqtt.esm.js is imported lazily.
   */
  constructor(opts) {
    this.broker = opts.broker;
    this.name = opts.broker.id;
    this.keepalive = opts.keepalive ?? 10;
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this._mqtt = opts.mqtt || null;
    this._emitter = new Emitter();
    /** @type {{filter:string, handler:Function}[]} */
    this._subs = [];
    this._will = null;
    this._client = null;
    this._closed = false;
    this.status = 'offline';
  }

  on(event, cb) {
    return this._emitter.on(event, cb);
  }

  _setStatus(s) {
    if (s === this.status) return;
    this.status = s;
    this._emitter.emit('status', s);
  }

  setLastWill(topic, message) {
    this._will = { topic, payload: JSON.stringify(message), qos: 1, retain: false };
  }

  async connect() {
    const mqtt = this._mqtt || (await loadMqtt());
    if (this._closed) throw new Error('offline');
    this._setStatus('connecting');
    return new Promise((resolve, reject) => {
      let settled = false;
      const client = mqtt.connect(this.broker.url, {
        clientId: randomClientId(),
        username: this.broker.username,
        password: this.broker.password,
        keepalive: this.keepalive,
        reconnectPeriod: 1500,
        connectTimeout: Math.min(this.timeoutMs, 5000),
        clean: true,
        queueQoSZero: false,
        resubscribe: true,
        forceNativeWebSocket: true,
        will: this._will || undefined,
      });
      this._client = client;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.close();
        reject(new Error('offline'));
      }, this.timeoutMs);
      client.on('connect', () => {
        this._setStatus('online');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      client.on('reconnect', () => !this._closed && this._setStatus('connecting'));
      client.on('offline', () => !this._closed && this._setStatus('offline'));
      client.on('close', () => !this._closed && this.status === 'online' && this._setStatus('offline'));
      client.on('error', () => {}); // surfaced as status changes; mqtt.js keeps retrying
      client.on('message', (topic, payload) => {
        if (payload.length > MAX_MESSAGE_BYTES) return;
        const msg = safeParse(payload.toString());
        if (msg === undefined) return;
        for (const s of this._subs) {
          if (topicMatches(s.filter, topic)) {
            try {
              s.handler(topic, msg);
            } catch (err) {
              console.error('[snowline] transport handler failed', err);
            }
          }
        }
      });
    });
  }

  publish(topic, message, opts = {}) {
    const c = this._client;
    if (!c || !c.connected || this._closed) return false;
    const payload = message === null ? '' : JSON.stringify(message);
    c.publish(topic, payload, { qos: opts.reliable ? 1 : 0, retain: !!opts.retain });
    return true;
  }

  subscribe(filter, handler) {
    this._subs.push({ filter, handler });
    const c = this._client;
    if (!c) return Promise.resolve();
    return new Promise((resolve, reject) => {
      c.subscribe(filter, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this._client?.end(false); // graceful DISCONNECT → no last will
    } catch {
      /* ignore */
    }
    this.status = 'offline';
    this._emitter.emit('status', 'offline');
  }
}

/* ------------------------------------------------------------------ */

/**
 * In-memory broker. One hub = one "server". With `channelName`, hubs in other
 * same-origin tabs are bridged through BroadcastChannel (retained messages are
 * exchanged when a tab opens).
 */
export class LoopbackHub {
  constructor({ channelName = null, clock = systemClock, latencyMs = 0 } = {}) {
    this.clock = clock;
    this.latencyMs = latencyMs;
    /** @type {Set<LoopbackTransport>} */
    this.clients = new Set();
    /** @type {Map<string, string>} topic → JSON text */
    this.retained = new Map();
    this._chan = null;
    if (channelName && typeof BroadcastChannel !== 'undefined') {
      this._chan = new BroadcastChannel(channelName);
      if (typeof this._chan.unref === 'function') this._chan.unref();
      this._chan.onmessage = (e) => this._onRemote(e.data);
      this._chan.postMessage({ k: 'sync?' });
    }
  }

  static get shared() {
    if (!LoopbackHub._shared) LoopbackHub._shared = new LoopbackHub({ channelName: 'snowline-loopback-v1' });
    return LoopbackHub._shared;
  }

  _onRemote(d) {
    if (!d || typeof d !== 'object') return;
    if (d.k === 'pub') this._route(d.topic, d.text, d.retain, false);
    else if (d.k === 'sync?') {
      for (const [topic, text] of this.retained) this._chan.postMessage({ k: 'ret', topic, text });
    } else if (d.k === 'ret' && !this.retained.has(d.topic)) {
      this.retained.set(d.topic, d.text);
      this._route(d.topic, d.text, false, false);
    }
  }

  /** @param {string} text JSON ('' = retained clear) */
  _route(topic, text, retain, fromLocal = true) {
    if (retain) {
      if (text === '') this.retained.delete(topic);
      else this.retained.set(topic, text);
    }
    if (fromLocal && this._chan) this._chan.postMessage({ k: 'pub', topic, text, retain });
    for (const c of this.clients) c._deliver(topic, text);
  }
}

export class LoopbackTransport {
  /** @param {{hub?:LoopbackHub, name?:string, lossRate?:number}} [opts] */
  constructor(opts = {}) {
    this.hub = opts.hub || LoopbackHub.shared;
    this.name = opts.name || 'local';
    this.lossRate = opts.lossRate || 0;
    this._emitter = new Emitter();
    this._subs = [];
    this._will = null;
    this._closed = false;
    this.status = 'offline';
  }

  on(event, cb) {
    return this._emitter.on(event, cb);
  }

  _setStatus(s) {
    if (s === this.status) return;
    this.status = s;
    this._emitter.emit('status', s);
  }

  setLastWill(topic, message) {
    this._will = { topic, text: JSON.stringify(message) };
  }

  async connect() {
    if (this._closed) throw new Error('offline');
    this._setStatus('connecting');
    await Promise.resolve();
    this.hub.clients.add(this);
    this._setStatus('online');
  }

  publish(topic, message, opts = {}) {
    if (this.status !== 'online' || this._closed) return false;
    const text = message === null ? '' : JSON.stringify(message);
    if (text.length > MAX_MESSAGE_BYTES) return false;
    if (!opts.reliable && this.lossRate && Math.random() < this.lossRate) return true;
    this.hub._route(topic, text, !!opts.retain);
    return true;
  }

  async subscribe(filter, handler) {
    const sub = { filter, handler };
    this._subs.push(sub);
    for (const [topic, text] of this.hub.retained) {
      if (topicMatches(filter, topic)) this._schedule(() => this._call(sub, topic, text));
    }
  }

  _schedule(fn) {
    if (this.hub.latencyMs > 0) this.hub.clock.setTimeout(fn, this.hub.latencyMs);
    else queueMicrotask(fn);
  }

  _call(sub, topic, text) {
    if (this.status !== 'online') return;
    const msg = safeParse(text);
    if (msg === undefined) return;
    try {
      sub.handler(topic, msg);
    } catch (err) {
      console.error('[snowline] transport handler failed', err);
    }
  }

  _deliver(topic, text) {
    for (const s of this._subs) if (topicMatches(s.filter, topic)) this._schedule(() => this._call(s, topic, text));
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this.hub.clients.delete(this);
    this._setStatus('offline');
  }

  /** Test hook: the connection dies (server publishes our will). */
  drop() {
    if (this._closed || this.status !== 'online') return;
    this.hub.clients.delete(this);
    this._setStatus('offline');
    if (this._will) this.hub._route(this._will.topic, this._will.text, false);
  }

  /** Test hook: reconnect after drop(); subscriptions are kept (like mqtt.js resubscribe). */
  restore() {
    if (this._closed || this.status === 'online') return;
    this._setStatus('connecting');
    this.hub.clients.add(this);
    this._setStatus('online');
  }
}
