/**
 * Compact wire form of a rider (see NetState in contracts.js):
 *   [tick, x, y, angle*1000, vx, vy, modeIndex, flags, scarf*100]   (all integers)
 *   flags bit0 = boosting, bit1 = shield, bit2 = hover, bits 4-5 = boostLevel
 */
import { RIDER_MODES, RiderMode } from '../contracts.js';

/**
 * @param {import('../contracts.js').RiderState} state
 * @returns {import('../contracts.js').NetState}
 */
export function encodeNetState(state) {
  const modeIndex = Math.max(0, RIDER_MODES.indexOf(state.mode));
  const level = state.boostT > 0 ? state.boostLevel & 3 : 0;
  const flags = (state.boostT > 0 ? 1 : 0) | (state.shield ? 2 : 0) | (state.hoverT > 0 ? 4 : 0) | (level << 4);
  return [
    state.tick | 0,
    Math.round(state.x),
    Math.round(state.y),
    Math.round(state.angle * 1000),
    Math.round(state.vx),
    Math.round(state.vy),
    modeIndex,
    flags,
    Math.round(state.scarf * 100),
  ];
}

/**
 * @param {import('../contracts.js').NetState} net
 * @returns {{tick:number,x:number,y:number,angle:number,vx:number,vy:number,mode:string,crouch:number,scarf:number,boostLevel:number,shield:boolean,hover:boolean}}
 *   RiderView-compatible partial (id/name/color/isLocal are added by the caller).
 *   `crouch` is not on the wire; it is guessed from the mode.
 */
export function decodeNetState(net) {
  const mode = RIDER_MODES[net[6]] || RiderMode.GROUND;
  const flags = net[7] | 0;
  const boosting = (flags & 1) !== 0;
  return {
    tick: net[0],
    x: net[1],
    y: net[2],
    angle: net[3] / 1000,
    vx: net[4],
    vy: net[5],
    mode,
    crouch: mode === RiderMode.AIR ? 0.6 : mode === RiderMode.GRIND ? 0.55 : mode === RiderMode.CRASHED ? 0 : 0.2,
    scarf: (net[8] | 0) / 100,
    boostLevel: boosting ? (flags >> 4) & 3 : 0,
    shield: (flags & 2) !== 0,
    hover: (flags & 4) !== 0,
  };
}
