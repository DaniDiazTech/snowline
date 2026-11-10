/**
 * Every simulation tunable, in one place. Units: px, seconds, radians.
 * (PX_PER_M = 24, so 480 px/s = 20 m/s.)
 *
 * The physical constants shared with the course generator live in
 * src/math/physics.js and are re-exported here.
 */
export { GRAVITY, JUMP_VY, REF_SLOPE, REF_SPEED, DRAG_K, RAMP_POP, BODY_CENTER, RIDER_HEIGHT, terminalSpeed } from '../math/physics.js';

export const SIM = Object.freeze({
  /* ---- ground ---- */
  START_SPEED: 140, // px/s given at GO
  MIN_SPEED: 110, // below this a "skate push" kicks in (nobody can stall on a rise)
  PUSH_ACCEL: 260, // px/s² of that push
  GROUND_ANGLE_SHARPNESS: 16, // how fast the board follows the slope on the ground (1/s)
  LEAVE_LOOKAHEAD_TICKS: 4, // ballistic look-ahead used to decide when the ground falls away
  LEAVE_EPS: 1.2, // px the ballistic arc must be above the snow at the end of the look-ahead
  MAX_GROUND_SPEED: 1400, // hard safety clamp

  /* ---- jump / input ---- */
  JUMP_BUFFER: 0.12, // s a press is remembered before touching down
  COYOTE: 0.08, // s after rolling off an edge during which a press still jumps
  RAMP_ZONE_AFTER_LIP: 50, // px after a ramp lip where a jump still gets RAMP_POP

  /* ---- air ---- */
  AIR_DRAG_MULT: 1.0, // air drag relative to ground drag (1 = jumping neither gains nor loses cruise speed)
  FLIP_RATE: (Math.PI * 2) / 0.55, // rad/s while held (≈0.55 s per 360°)
  FLIP_EASE: 16, // ease-in sharpness toward FLIP_RATE (1/s)
  RELEASE_DAMP: 20, // angular velocity damping after release (1/s); overshoot ≈ rate/damp
  AUTO_LEVEL: 3.5, // gentle torque toward the slope below when not holding (1/s²)
  FLIP_COUNT_TOL: 0.35, // rad: a flip counts once rotation reaches 2π - this
  LAND_CLEAN_ANGLE: (50 * Math.PI) / 180, // max |board - slope| for a clean landing
  LAND_LOSS: 0.06, // fraction of speed lost at impact 1 on a clean landing
  SLOPPY_LOSS: 0.12, // extra loss for landings at the edge of the clean window
  IMPACT_REF: 900, // normal speed (px/s) that maps to impact = 1
  MICRO_AIR: 0.12, // s: natural (no jump) air phases shorter than this emit no LAND
  PROXIMITY_DIST: 30, // head-to-snow distance for a Proximity Flip (px)
  BIG_AIR_T: 1.6, // s of air for Big Air

  /* ---- grind ---- */
  GRIND_CATCH_TOL: 7, // px above the line at which a descending rider is snapped on
  GRIND_CATCH_ANGLE: (65 * Math.PI) / 180, // board must be within this of the line to catch it
  GRIND_DRAG_MULT: 0.8,
  GRIND_ACCEL: 70, // px/s² mild speed gain on grinds
  ICE_ACCEL: 110, // px/s² on ice
  ICE_DRAG_MULT: 0.65,
  GRIND_POINTS_EVERY: 48, // px (2 m)
  GRIND_POINTS: 5,
  GRIND_REJUMP_COOLDOWN: 0.2, // s before the same line can be caught again

  /* ---- obstacles ---- */
  ROCK_CENTER: 0.6, // rock centre sits size*this above the snow
  ROCK_HIT: 0.85, // crash radius (fraction of size)
  ROCK_TOP_ZONE: 1.3, // forgiving bounce zone radius over the top half
  ROCK_BOUNCE_VY: 430, // px/s upward after a rock bounce
  CAMPFIRE_HIT: 0.9,
  CHASM_FALL_DEPTH: 70, // px below the lip line at which a rider is "in" the chasm
  CHASM_POP_TOL: 16, // px below the far lip that still pops up onto it

  /* ---- crash / respawn ---- */
  CRASH_T: 1.1,
  CHASM_RESPAWN_T: 1.6,
  CRASH_FRICTION: 2.6, // 1/s exponential slide decay
  CRASH_SPIN: 13, // rad/s initial tumble spin
  CRASH_SPIN_DECAY: 2.2, // 1/s
  RESPAWN_SPEED: 130,
  RESPAWN_INVULN: 1.0, // s immune to rocks/campfires after a respawn
  RESPAWN_CLEAR: 30, // px placed past an obstacle on respawn
  CHASM_RESPAWN_OFFSET: 70, // px past the far lip

  /* ---- speed rewards ---- */
  BOOST_TIERS: Object.freeze([
    Object.freeze({ min: 10, bonus: 0.18, duration: 2.0 }),
    Object.freeze({ min: 60, bonus: 0.32, duration: 2.8 }),
    Object.freeze({ min: 200, bonus: 0.5, duration: 3.8 }),
  ]),
  BOOST_FULL_FRAC: 0.3, // boost runs at full power for this fraction, then fades smoothly
  BOOST_PUSH: 130, // px/s² extra push while below the boosted cruise speed of the local slope
  BOOST_EXTEND: 0.35, // re-banking adds this fraction of the overlap
  BOOST_MAX_T: 6, // s cap
  SHIELD_FRAC: 0.6, // shield during the first 60% of a boost
  SCARF_SPEED_BONUS: 0.12, // full scarf raises terminal speed by 20%
  SCARF_PER_POINT: 0.002, // scarf gained per banked combo point (total)
  SCARF_MAX_GAIN: 0.25, // per bank
  SCARF_DECAY: 0.03, // per second
  SCARF_PER_COIN: 0.006,

  /* ---- pickups ---- */
  PICKUP_RADIUS: 30, // px from the body centre
  MAGNET_RADIUS: 220,
  HOVER_T: 6,
  MAGNET_T: 8,
  HOVER_HEIGHT: 12, // px above the snow while hovering
  HOVER_GRAVITY: 0.6, // gravity multiplier in the air while hovering
  HOVER_LEVEL: 14, // strong auto-level while hovering (1/s²)

  /* ---- finish ---- */
  FINISH_BRAKE: 280, // px/s² once across the line
});

/** Trick catalogue: points and labels. Flip n (n ≥ 2) earns 10 + FLIP_BONUS[n]. */
export const TRICKS = Object.freeze({
  BACKFLIP: 10,
  FLIP_BONUS: Object.freeze([0, 0, 30, 100, 200, 350]),
  FLIP_LABELS: Object.freeze(['', 'Backflip', 'Double Backflip', 'Triple Backflip', 'Quadruple Backflip', 'Quintuple Backflip']),
  GRIND: 10,
  ROCK_BOUNCE: 80,
  CHASM: 40,
  PROXIMITY: 20,
  BIG_AIR: 20,
  ROCK_SMASH: 30,
  CAMPFIRE_SMASH: 30,
  COIN: 2,
});
