/**
 * Public MQTT-over-WebSocket brokers and room codes.
 *
 * A room code is 5 characters from CODE_ALPHABET (no 0/O, 1/I/L, 2/Z, 5/S, B (vs 8), U/V).
 * Its FIRST character selects the broker: brokerIndex = alphabetIndex % BROKERS.length,
 * so a joiner needs nothing but the code. Every client must run the same BROKERS list
 * (same deploy) for codes to resolve identically.
 *
 * Ranking (best first) comes from snowline-tests/net/stress.mjs: 12 clients, ~120-byte
 * state at 12 Hz for 60 s each (pub→broker→sub latency), two runs on 2026-11-10:
 *   shiftr    443   100.00% / 100.00%   p50 171/172  p95 229/253  p99 616/366 ms  (only one passing port-restricted Wi-Fi)
 *   mosquitto 8081  100.00% / 100.00%   p50 165/165  p95 213/250  p99 324/349 ms
 *   hivemq    8884  100.00% /  96.54%   p50 168/171  p95 225/361  p99 353/6240 ms (run 2: 2 disconnects; connect 1–4.5 s)
 * Rejected: broker.emqx.io (30–38 % loss, throttled), mqtt.eclipseprojects.io (dead).
 * shiftr is ranked first because it held up at full room load AND is the only broker
 * reachable on 443; Room.create falls back down the list if it does not connect in ~3 s.
 */

/** @typedef {{id:string, url:string, username?:string, password?:string, port:number}} Broker */

/** @type {ReadonlyArray<Broker>} */
export const BROKERS = Object.freeze([
  Object.freeze({ id: 'shiftr', url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public', port: 443 }),
  Object.freeze({ id: 'mosquitto', url: 'wss://test.mosquitto.org:8081', port: 8081 }),
  Object.freeze({ id: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt', port: 8884 }),
]);

/** 24 unambiguous characters (divisible by 2, 3, 4 broker classes). */
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTWXY346789';
export const CODE_LENGTH = 5;

/** Topic prefix; the random-looking suffix keeps us out of other apps' namespaces. */
export const TOPIC_PREFIX = 'snowline-q7x4/v1/';

export function randomInt(n) {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] % n;
}

export function randomUint32() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] >>> 0;
}

/** Random code whose first character maps to `brokerIndex`. */
export function makeRoomCode(brokerIndex = 0, brokers = BROKERS) {
  const n = brokers.length;
  const firsts = [...CODE_ALPHABET].filter((_, i) => i % n === brokerIndex % n);
  let code = firsts[randomInt(firsts.length)];
  while (code.length < CODE_LENGTH) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/**
 * Normalise user input to a code: upper-case, strip spaces/dashes/dots. No guessing of
 * look-alikes: anything outside CODE_ALPHABET makes the input invalid.
 * @returns {string|null} the code, or null if it cannot be a valid code
 */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** @returns {number} index into `brokers` for a valid code, -1 otherwise */
export function brokerIndexForCode(code, brokers = BROKERS) {
  const c = normalizeCode(code);
  if (!c) return -1;
  return CODE_ALPHABET.indexOf(c[0]) % brokers.length;
}
