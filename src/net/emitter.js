/**
 * Tiny event emitter used by Room and the transports.
 * `on` returns an unsubscribe function; handler exceptions are caught and logged
 * so one faulty listener can never break the network protocol.
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  /** @returns {()=>void} unsubscribe */
  on(event, cb) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(cb);
    return () => this.off(event, cb);
  }

  off(event, cb) {
    const set = this._handlers.get(event);
    if (set) set.delete(cb);
  }

  emit(event, ...args) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[snowline] '${event}' handler failed`, err);
      }
    }
  }

  removeAll() {
    this._handlers.clear();
  }
}
