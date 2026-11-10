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

/** Gravity, px/s². With JUMP_VY this gives a ~0.85 s tap jump on any constant slope. */
export const GRAVITY = 1200;

/**
 * Vertical take-off impulse of a jump, px/s (applied as vy -= JUMP_VY).
 * On a constant slope the airtime of a vertical impulse is 2·JUMP_VY/GRAVITY
 * whatever the slope angle (0.85 s), and the highest point above the snow is
 * JUMP_VY²/(2·GRAVITY) ≈ 108 px (4.5 m), so grind lines 55-90 px high are reachable.
 */
export const JUMP_VY = 510;

/**
 * Reference slope (dy/dx) at which an unboosted rider cruises at REF_SPEED.
 * The quadratic drag coefficient is derived from it, so steeper = faster.
 */
export const REF_SLOPE = 0.21;

/** Unboosted terminal speed on REF_SLOPE, px/s (≈21 m/s at PX_PER_M = 24). */
export const REF_SPEED = 500;

/** Quadratic drag coefficient (1/px): a_drag = DRAG_K · v². */
export const DRAG_K = (GRAVITY * Math.sin(Math.atan(REF_SLOPE))) / (REF_SPEED * REF_SPEED);

/** Terminal (cruising) speed on a slope of the given dy/dx, px/s, unboosted. */
export function terminalSpeed(slope) {
  const s = Math.sin(Math.atan(slope));
  return s > 0 ? Math.sqrt((GRAVITY * s) / DRAG_K) : 0;
}

/** Extra upward kick when a jump is taken on a ramp (kicker), px/s. */
export const RAMP_POP = 170;

/** Height of the rider's body centre above the board contact point, px (pickups). */
export const BODY_CENTER = 18;

/** Board-to-head distance, px. The renderer should draw the rider about this tall. */
export const RIDER_HEIGHT = 34;
