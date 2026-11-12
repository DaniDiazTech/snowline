/**
 * Every simulation tunable, in one place. Units: px, seconds, radians.
 * (PX_PER_M = 24, so 480 px/s = 20 m/s.)
 *
 * The physical constants shared with the course generator live in
 * src/math/physics.js and are re-exported here.
 */
export { GRAVITY, JUMP_VY, REF_SLOPE, REF_SPEED, DRAG_K, RAMP_POP, rampPop, BODY_CENTER, RIDER_HEIGHT, terminalSpeed } from '../math/physics.js';

export const SIM = Object.freeze({
  /* ---- ground ---- */
  START_SPEED: 140, // px/s given at GO
  // "Back to pace": below RECOVER_BELOW × cruise a push of up to RECOVER_ACCEL (fading to 0 at the
  // threshold) brings the rider back near cruise within ~1.2 s after any slowdown; no stalls.
  RECOVER_BELOW: 0.85,
  RECOVER_ACCEL: 700, // px/s²
  GROUND_ANGLE_SHARPNESS: 16, // how fast the board follows the slope on the ground (1/s)
  LEAVE_LOOKAHEAD_TICKS: 4, // ballistic look-ahead used to decide when the ground falls away
  LEAVE_EPS: 1.2, // px the ballistic arc must be above the snow at the end of the look-ahead
  MAX_GROUND_SPEED: 1400, // hard safety clamp
  // Soft aerodynamic terminal: above SOFT_V (horizontal) an extra drag SOFT_K·(vx − SOFT_V)² acts
  // on the ground, on lines and in the air, so nothing sustains much more than ≈ 44 m/s.
  SOFT_V: 864, // px/s (36 m/s)
  SOFT_K: 0.12, // 1/px
  SOFT_MAX_DECEL: 4000, // px/s²: cap on that extra braking (a hard landing's burst bleeds off smoothly)

  /* ---- jump / input ---- */
  JUMP_BUFFER: 0.15, // s a press is remembered before touching down
  COYOTE: 0.12, // s after rolling off an edge during which a press still jumps
  RAMP_ZONE_AFTER_LIP: 50, // px after a ramp lip where a jump still gets the ramp pop (rampPop(height))
  RAMP_LAUNCH_LEAD: 6, // px: a press on a ramp's run-up launches this close to the lip
  RAMP_PRESS_LEAD_IN: 120, // px before a ramp's run-up where a press also waits for the lip (≈0.25 s at cruise; no hazards sit there)

  /* ---- air ---- */
  // Ground resistance k·v² = aero (≈45%) + snow friction (≈55%). In the air only the aero part acts,
  // on the horizontal component (vertical motion is a pure parabola under g), so jumps feel carried.
  AIR_DRAG_MULT: 0.28, // (same absolute air drag as before the heavier gravity; DRAG_K scales with g)
  // Rotation has weight (rigid-body-ish). Holding applies a torque that winds the spin up; releasing
  // lets angular momentum carry on and decay; a gentle righting torque acts only near upright.
  HOLD_T: 0.16, // s the button must be held continuously before any torque (a tap = a plain jump, zero rotation)
  FLIP_RAMP_T: 0.06, // s over which the torque ramps in once HOLD_T is reached
  FLIP_TORQUE: 70, // rad/s² of backward angular acceleration while held (the wind-up)
  FLIP_MAX_RATE: 13, // rad/s cap on the spin (≈ 545°/s) → a held 360° takes ≈ 1.0 s
  // Released, angular momentum is conserved; the rider changes the spin rate by tucking / extending,
  // depending on where the board is in its rotation (φ = back-rotation past the last upright):
  //   φ < EXTEND_ZONE            extended: the spin slows strongly (and the righting spring acts)
  //   EXTEND_ZONE ≤ φ < COMMIT   risky band: moderate decay — momentum decides if it goes over
  //   COMMIT ≤ φ < 360° − OPEN    tucked: momentum carries on almost undamped
  //   φ ≥ 360° − OPEN            opening up for the landing: the spin bleeds off, the spring settles it
  EXTEND_ZONE: (120 * Math.PI) / 180,
  COMMIT_ANGLE: (160 * Math.PI) / 180,
  OPEN_ZONE: (85 * Math.PI) / 180,
  EXTEND_DAMP: 30, // 1/s
  RISKY_DAMP: 5, // 1/s
  TUCK_DAMP: 0.3, // 1/s
  OPEN_DAMP: 7, // 1/s
  AIR_ANG_DAMP: 7, // 1/s: reference decay used by planners for "carry after release" (≈ open/extend)
  RIGHT_ZONE: (50 * Math.PI) / 180, // the righting torque acts only within this of upright (relative to the slope)
  RIGHT_GAIN: 34, // rad/s² per rad of tilt inside that zone (a firm but gentle spring toward the slope)
  HOVER_RIGHT_GAIN: 60, // feather hover: strong righting anywhere
  FLIP_COUNT_TOL: 0.6, // rad: a flip counts once rotation reaches 2π - this
  // Landings, graded by |board − slope| at touchdown.
  LAND_CLEAN_ANGLE: (35 * Math.PI) / 180, // clean: full tangential speed, combo banked
  LAND_SKETCHY_ANGLE: (60 * Math.PI) / 180, // sketchy: slides it out (combo lost, SKETCHY_LOSS speed, wobble); beyond = crash
  SKETCHY_LOSS: 0.12,
  LAND_SPIN_LOOK: 0.1, // s: a landing is judged on the worse of the board angle now and where the spin takes it in this time
                       //    (touching down mid-rotation with real angular momentum crashes)
  WOBBLE_T: 0.35, // s of board wobble after a sketchy landing
  WOBBLE_AMP: 0.05, // rad per tick-scale of that wobble
  LAND_EASE_T: 0.15, // s during which the board eases onto the slope fast after a touchdown / line catch
  LAND_ANGLE_SHARPNESS: 30, // 1/s (≈ 90% in ~80 ms)
  BOARD_HALF: 16, // px: half board length (contact point is lifted so no tip digs into the snow)
  TIP_GRACE: 0.08, // s after take-off before a board tip can count as a touchdown
  SQUASH_REF: 700, // normal impact speed (px/s) that gives a full crouch dip
  SQUASH_RECOVER: 2.5, // 1/s
  MIN_LAND_SPEED: 60, // px/s floor after a landing onto a steep up-slope
  IMPACT_REF: 1400, // normal speed (px/s) that maps to impact = 1 (LAND event): a tap jump ≈ 0.4, a pit drop ≈ 0.7
  MICRO_AIR: 0.12, // s: natural (no jump) air phases shorter than this emit no LAND
  PROXIMITY_DIST: 30, // head-to-snow distance for a Proximity Flip (px)
  BIG_AIR_T: 1.6, // s of air for Big Air

  /* ---- grind ---- */
  GRIND_CATCH_TOL: 18, // px above the line at which a descending rider is snapped on (line magnetism)
  GRIND_CATCH_ANGLE: (65 * Math.PI) / 180, // board must be within this of the line to catch it
  GRIND_DRAG_MULT: 0.8,
  GRIND_CAP: 2.2, // grind acceleration applies below this × boosted cruise speed (the soft terminal bounds it)
  GRIND_ACCEL: 450, // px/s² (bunting; per kind in GRINDS — kept for planners/tests)
  CHAIN_ACCEL_STEP: 0.35, // +35% line acceleration per line already in the chain
  CHAIN_KICK_STEP: 40, // px/s extra exit kick per line already in the chain
  ICE_DRAG_MULT: 0.65,
  GRIND_POINTS_EVERY: 48, // px (2 m)
  GRIND_POINTS: 10, // (bunting; per kind in GRINDS)
  GRIND_REJUMP_COOLDOWN: 0.2, // s before the same line can be caught again

  /* ---- obstacles ---- */
  ROCK_CENTER: 0.6, // rock centre sits size*this above the snow
  ROCK_HIT: 0.85, // crash radius (fraction of size)
  ROCK_TOP_ZONE: 1.3, // forgiving bounce zone radius over the top half
  ROCK_BOUNCE_VY: 620, // px/s upward after a rock bounce
  LOG_HOP_VY: 560, // px/s upward after landing on top of a log
  LOG_HOP_TOL: 10, // px below the log top that still counts as landing on it
  CAMPFIRE_HIT: 0.9,
  CHASM_POP_TOL: 16, // px below the far lip that still pops up onto it

  /* ---- crash / respawn ---- */
  CRASH_T: 1.1, // s of tumble
  CRASH_GETUP_T: 0.25, // last part of the tumble: spin settles, board comes back onto the slope
  CRASH_KEEP: 0.6, // share of the tangential speed kept when the tumble starts
  CRASH_SLIDE_TO: 0.4, // the sliding tumble eases toward this × cruise (never a dead stop)
  CRASH_SLIDE_RATE: 2.2, // 1/s
  CRASH_THROW_VY: 420, // px/s: hitting an obstacle throws the rider up and over it
  CRASH_MIN_THROW: 0.55, // × cruise: minimum forward speed of that throw
  CRASH_SPIN: 13, // rad/s initial tumble spin
  CRASH_SPIN_DECAY: 2.2, // 1/s
  RESPAWN_MIN_FRAC: 0.4, // × cruise: speed when getting up
  RESPAWN_INVULN: 1.0, // s immune to obstacles after getting up / being set down
  RESPAWN_CLEAR: 30, // px placed past an obstacle if the tumble ended inside it

  /* ---- pit rescue ---- */
  RESCUE_T: 3.0, // s: the true cost of falling into a pit
  RESCUE_DEPTH: 40, // px below the lip line that triggers the rescue
  RESCUE_LAND_OFFSET: 60, // px past the far edge where the rider is set down
  RESCUE_ARC_H: 150, // px above the higher lip at the top of the lift
  RESCUE_LEAD: 170, // px: length of the final approach along the far slope
  RESCUE_SETDOWN_H: 50, // px: that approach starts this far above the slope
  RESCUE_SWAY: 0.12, // rad of gentle sway while carried
  RESCUE_RELEASE: 0.6, // × cruise: speed when set down (the path ends at this speed)

  /* ---- speed rewards ---- */
  // Banking a combo: an instant forward kick (px/s, felt at once) plus a timed cruise boost.
  BOOST_TIERS: Object.freeze([
    Object.freeze({ min: 25, bonus: 0.3, duration: 3.5, kick: 120 }),
    Object.freeze({ min: 70, bonus: 0.4, duration: 7.0, kick: 170 }),
    Object.freeze({ min: 300, bonus: 0.5, duration: 10.0, kick: 300 }),
  ]),
  BOOST_FULL_FRAC: 0.3,
  BOOST_EASE: 20, // 1/s: the applied boost eases in (~0.15 s) and out instead of switching
  KICK_RATE: 1200, // px/s²: the bank kick is delivered at this rate (72-120 px/s → 0.06-0.1 s) // boost runs at full power for this fraction, then fades smoothly
  BOOST_PUSH: 300, // px/s² of extra push per +100% tier bonus, while below the boosted cruise speed
  BOOST_EXTEND: 0.2, // re-banking adds this fraction of the overlap
  BOOST_MAX_T: 16, // s cap
  SHIELD_FRAC: 0.6, // shield during the first 60% of a boost
  MAX_SPEED_MULT: 1.6, // cap on scarf × boost cruise multiplier (keeps long tier-3 chains readable)
  // Catch-up assist (RiderInput.assist, 0..1, set by the race from position): a small cruise-speed
  // bonus that eases in/out slowly; applies to the cruise/terminal multiplier, never to kicks.
  ASSIST_MAX: 0.08,
  ASSIST_EASE: 1.2, // 1/s
  SCARF_SPEED_BONUS: 0.03, // full scarf raises cruise speed by 3% (mostly a visible momentum / score gauge)
  SCARF_PER_POINT: 0.009, // scarf gained per banked combo point (total)
  SCARF_MAX_GAIN: 0.25, // per bank
  SCARF_DECAY: 0.045, // per second
  SCARF_PER_COIN: 0.02,

  /* ---- pickups ---- */
  PICKUP_RADIUS: 30, // px from the body centre
  MAGNET_RADIUS: 220,
  HOVER_T: 6,
  MAGNET_T: 8,
  HOVER_HEIGHT: 12, // px above the snow while hovering
  HOVER_GRAVITY: 0.6, // gravity multiplier in the air while hovering

  /* ---- finish ---- */
  FINISH_BRAKE: 280, // px/s² once across the line
});

/** Trick catalogue: points and labels. Flip n (n ≥ 2) earns 10 + FLIP_BONUS[n]. */
export const TRICKS = Object.freeze({
  // Points feed the combo (points × number of tricks); the total picks the boost tier (BOOST_TIERS).
  // Priced so that easy/automatic things give small steady gains and the two big routes to tier 3
  // are flips off ramps (doubles over gorges) and bunting chains.
  BACKFLIP: 25,
  FLIP_BONUS: Object.freeze([0, 0, 50, 200, 350, 500]),
  FLIP_LABELS: Object.freeze(['', 'Backflip', 'Double Backflip', 'Triple Backflip', 'Quadruple Backflip', 'Quintuple Backflip']),
  ROCK_BOUNCE: 40,
  CHASM: 15,
  PROXIMITY: 20,
  BIG_AIR: 25,
  SMASH: 25, // any obstacle smashed while shielded
  LOG_HOP: 30,
  COIN: 2,
  // Small steady direct gains for the easy things (delivered like the bank kick, px/s).
  CHASM_KICK: 50,
  COIN_KICK: 5,
});

/**
 * Grind lines by kind: points to catch, points per GRIND_POINTS_EVERY px, acceleration while on
 * the line, and the exit kick (px/s, delivered like a bank kick) on hop-off / line end. Chaining
 * lines (line → hop → line without touching snow) adds CHAIN_ACCEL_STEP to the acceleration and
 * CHAIN_KICK_STEP to the exit kick per line in the chain.
 */
export const GRINDS = Object.freeze({
  bunting: Object.freeze({ label: 'Bunting Grind', catch: 20, perStep: 10, accel: 450, exitKick: 60 }),
  roof: Object.freeze({ label: 'Roof Grind', catch: 14, perStep: 3, accel: 220, exitKick: 30 }),
  ice: Object.freeze({ label: 'Ice Slide', catch: 4, perStep: 1, accel: 150, exitKick: 0 }),
});
