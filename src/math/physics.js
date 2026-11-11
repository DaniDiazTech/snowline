/**
 * Physical constants of the Snowline world.
 *
 * They live in `math/` (not in `sim/`) because two modules need them:
 *  - the simulation (src/sim/RiderSim.js) integrates the rider with them;
 *  - the course generator (src/world/Course.js) uses them to place things
 *    fairly: coin arcs that trace a real jump, chasms that are clearable,
 *    grind lines that are reachable with a jump.
 * `src/sim/simConfig.js` re-exports them next to every other sim tunable.
 *
 * Units: world px, seconds. y grows DOWN.
 */

/** Gravity, px/s² (≈ 8 g at PX_PER_M = 24: heavy, snappy arcs). A tap jump is a quick ~0.6 s hop. */
export const GRAVITY = 1900;

/**
 * Vertical take-off impulse of a jump, px/s (applied as vy -= JUMP_VY).
 * On a constant slope the airtime of a vertical impulse is 2·JUMP_VY/GRAVITY
 * whatever the slope angle (≈0.63 s), and the highest point above the snow is
 * JUMP_VY²/(2·GRAVITY) ≈ 95 px (4 m) — too little air for a flip; flips come from ramps, drops, bounces, so grind lines 55-90 px high are reachable.
 */
export const JUMP_VY = 600;

/**
 * Reference slope (dy/dx) at which an unboosted rider cruises at REF_SPEED.
 * The quadratic drag coefficient is derived from it, so steeper = faster.
 */
export const REF_SLOPE = 0.165;

/** Unboosted terminal speed on REF_SLOPE, px/s (≈17 m/s at PX_PER_M = 24). */
export const REF_SPEED = 400;

/** Quadratic drag coefficient (1/px): a_drag = DRAG_K · v². */
export const DRAG_K = (GRAVITY * Math.sin(Math.atan(REF_SLOPE))) / (REF_SPEED * REF_SPEED);

/** Terminal (cruising) speed on a slope of the given dy/dx, px/s, unboosted. */
export function terminalSpeed(slope) {
  const s = Math.sin(Math.atan(slope));
  return s > 0 ? Math.sqrt((GRAVITY * s) / DRAG_K) : 0;
}

/** Reference ramp pop (a ≈ 58 px ramp), px/s. The actual pop scales with the ramp height (rampPop). */
export const RAMP_POP = 440;

/** Extra upward kick (px/s) of a jump taken on a ramp of the given height: taller ramps launch higher. */
export const RAMP_POP_PER_PX = 10;
export function rampPop(height) {
  return Math.max(160, Math.min(880, RAMP_POP_PER_PX * height));
}

/** Height of the rider's body centre above the board contact point, px (pickups). */
export const BODY_CENTER = 18;

/** Board-to-head distance, px. The renderer should draw the rider about this tall. */
export const RIDER_HEIGHT = 34;
