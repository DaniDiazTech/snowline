/**
 * WinnersStore — hall of fame (see contracts.js STORAGE).
 *
 * Remote: one JSON array (newest first, max 100) at https://textdb.dev/api/data/<key>.
 *   GET returns the stored text ('' when unset); POST replaces it. We POST with
 *   Content-Type text/plain (a CORS "simple" request: no preflight). No auth exists, so
 *   the key is long and unguessable — but the value is world-writable: every record read
 *   back is shape-checked and clamped, garbage is skipped.
 * Local: always mirrored to localStorage ('snowline.winners.v1'), merged into list().
 *
 * add() is read-modify-write (one retry, 5 s timeout per request). Only the host's client
 * calls it, so concurrent writers are rare; a lost race just drops one record remotely.
 *
 *   add(record): Promise<'remote'|'local'>   // never rejects (additive: resolves to where it landed)
 *   list(limit=50): Promise<WinnerRecord[]>  // remote ∪ local, de-duplicated on room+at, newest first
 */
import { PLAYER_COLORS, COURSE_LENGTHS } from '../contracts.js';

export const WINNERS_ENDPOINT = 'https://textdb.dev/api/data/';
/** Production key. Tests must pass their own key. */
export const WINNERS_KEY = 'snowline-hof-v1-k7Rq2xWm9TfZ4cLp8VnB3dHs';
const LOCAL_KEY = 'snowline.winners.v1';
const CAP = 100;
const MAX_BYTES = 256 * 1024;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return [...s.slice(0, 256).normalize('NFC').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
}

/** @returns {import('../contracts.js').WinnerRecord|null} */
export function sanitizeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const name = cleanText(r.name, 14);
  if (!name || !fin(r.timeMs) || r.timeMs <= 0 || r.timeMs > 3600000) return null;
  if (!Object.hasOwn(COURSE_LENGTHS, r.length)) return null;
  if (!fin(r.at) || r.at < Date.UTC(2024, 0, 1) || r.at > Date.now() + 86400000) return null;
  const room = cleanText(r.room, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return {
    name,
    colorIndex: Number.isInteger(r.colorIndex) && r.colorIndex >= 0 && r.colorIndex < PLAYER_COLORS.length ? r.colorIndex : 0,
    timeMs: Math.round(r.timeMs * 10) / 10,
    length: r.length,
    players: Number.isInteger(r.players) ? clamp(r.players, 1, 32) : 1,
    score: fin(r.score) ? Math.round(clamp(r.score, 0, 1e9)) : 0,
    best: sanitizeBest(r.best),
    room,
    at: Math.round(r.at),
  };
}

/** The race's top scorer (optional; older records don't have it). */
function sanitizeBest(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined;
  const name = cleanText(b.name, 14);
  if (!name || !fin(b.score)) return undefined;
  return {
    name,
    colorIndex: Number.isInteger(b.colorIndex) && b.colorIndex >= 0 && b.colorIndex < PLAYER_COLORS.length ? b.colorIndex : 0,
    score: Math.round(clamp(b.score, 0, 1e9)),
  };
}

function parseList(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_BYTES) return [];
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const r of arr.slice(0, 500)) {
    const c = sanitizeRecord(r);
    if (c) out.push(c);
  }
  return out;
}

function mergeLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const r of lists.flat().sort((a, b) => b.at - a.at)) {
    const k = r.room + '|' + r.at;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export class WinnersStore {
  /**
   * @param {{key?:string, endpoint?:string, timeoutMs?:number, fetch?:Function, storage?:Storage|null}} [opts]
   */
  constructor(opts = {}) {
    this.key = opts.key || WINNERS_KEY;
    this.url = (opts.endpoint || WINNERS_ENDPOINT) + encodeURIComponent(this.key);
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this._fetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._storage = opts.storage !== undefined ? opts.storage : safeLocalStorage();
    this._localKey = LOCAL_KEY + (opts.key ? ':' + opts.key : '');
  }

  async _request(method, body) {
    if (!this._fetch) throw new Error('no fetch');
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), this.timeoutMs);
    try {
      const res = await this._fetch(this.url, {
        method,
        cache: 'no-store',
        headers: body !== undefined ? { 'Content-Type': 'text/plain' } : undefined,
        body,
        signal: ctl ? ctl.signal : undefined,
      });
      if (!res.ok) throw new Error('http ' + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async _retry(fn) {
    try {
      return await fn();
    } catch {
      return await fn();
    }
  }

  _readLocal() {
    try {
      return parseList(this._storage?.getItem(this._localKey) || '');
    } catch {
      return [];
    }
  }

  _writeLocal(list) {
    try {
      this._storage?.setItem(this._localKey, JSON.stringify(list.slice(0, CAP)));
      return !!this._storage;
    } catch {
      return false;
    }
  }

  /** @returns {Promise<'remote'|'local'>} */
  async add(record) {
    const rec = sanitizeRecord(record);
    if (!rec) return 'local';
    this._writeLocal(mergeLists([rec], this._readLocal()));
    try {
      await this._retry(async () => {
        const current = parseList(await this._request('GET'));
        const next = mergeLists([rec], current).slice(0, CAP);
        await this._request('POST', JSON.stringify(next));
      });
      return 'remote';
    } catch {
      return 'local';
    }
  }

  /** @returns {Promise<import('../contracts.js').WinnerRecord[]>} */
  async list(limit = 50) {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, CAP) : 50;
    let remote = [];
    try {
      remote = parseList(await this._retry(() => this._request('GET')));
    } catch {
      remote = [];
    }
    return mergeLists(remote, this._readLocal()).slice(0, n);
  }
}

function safeLocalStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Default instance on the production key. */
export const winnersStore = new WinnersStore();
export const add = (record) => winnersStore.add(record);
export const list = (limit) => winnersStore.list(limit);
