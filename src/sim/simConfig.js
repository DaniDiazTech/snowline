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
  // "Back to pace": below RECOVER_BELOW × cruise a push of up to RECOVER_ACCEL (fading to 0 at the
  // threshold) brings the rider back near cruise within ~1.2 s after any slowdown; no stalls.
  RECOVER_BELOW: 0.85,
  RECOVER_ACCEL: 560, // px/s²
  GROUND_ANGLE_SHARPNESS: 16, // how fast the board follows the slope on the ground (1/s)
  LEAVE_LOOKAHEAD_TICKS: 4, // ballistic look-ahead used to decide when the ground falls away
  LEAVE_EPS: 1.2, // px the ballistic arc must be above the snow at the end of the look-ahead
  MAX_GROUND_SPEED: 1400, // hard safety clamp

  /* ---- jump / input ---- */
  JUMP_BUFFER: 0.15, // s a press is remembered before touching down
  COYOTE: 0.12, // s after rolling off an edge during which a press still jumps
  RAMP_ZONE_AFTER_LIP: 50, // px after a ramp lip where a jump still gets RAMP_POP
  RAMP_LAUNCH_LEAD: 6, // px: a press on a pit ramp's run-up launches this close to the lip
  FLIP_MIN_AIR: 0.62, // s: a held flip only starts if the arc stays up at least this long (no mid-flip touchdowns on short hops)

  /* ---- air ---- */
  // Ground resistance k·v² = aero (≈45%) + snow friction (≈55%). In the air only the aero part acts,
  // on the horizontal component (vertical motion is a pure parabola under g), so jumps feel carried.
  AIR_DRAG_MULT: 0.45,
  HOLD_T: 0.16, // s the button must be held continuously before any rotation (a tap = a plain jump)
  FLIP_RAMP_T: 0.1, // s over which the spin ramps in once HOLD_T is reached
  FLIP_RATE: (Math.PI * 2) / 0.6, // rad/s at full spin (≈0.6 s per 360°)
  FLIP_EASE: 30, // how tightly the spin follows the ramp (1/s)
  // Release assist (button up in the air). Rotation is measured as the back-rotation past the
  // last slope-aligned upright orientation (0..360°):
  //   ≤ ASSIST_ROLLBACK      → roll back to upright (a short tap or slight over-rotation is forgiven)
  //   ≥ 360° − ASSIST_FINISH → finish the flip forward (it counts)
  //   in between             → "committed": no rescue, the spin just damps out
  ASSIST_ROLLBACK: (110 * Math.PI) / 180,
  ASSIST_FINISH: (172 * Math.PI) / 180,
  ASSIST_RATE: (400 * Math.PI) / 180, // max assisted spin rate (rad/s)
  ASSIST_GAIN: 9, // assisted spin rate per rad of remaining error (1/s)
  RELEASE_DAMP: 35, // how fast angular velocity converges to the assisted rate after release (1/s)
  FLIP_COUNT_TOL: 0.6, // rad: a flip counts once rotation reaches 2π - this
  // Landings, graded by |board − slope| at touchdown.
  LAND_CLEAN_ANGLE: (30 * Math.PI) / 180, // clean: full tangential speed, combo banked
  LAND_SKETCHY_ANGLE: (65 * Math.PI) / 180, // sketchy: slides it out (combo lost, SKETCHY_LOSS speed, wobble); beyond = crash
  SKETCHY_LOSS: 0.12,
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
  GRIND_CATCH_TOL: 7, // px above the line at which a descending rider is snapped on
  GRIND_CATCH_ANGLE: (65 * Math.PI) / 180, // board must be within this of the line to catch it
  GRIND_DRAG_MULT: 0.8,
  GRIND_CAP: 1.35, // grind/ice acceleration applies below this × boosted cruise speed
  GRIND_ACCEL: 190, // px/s² visible speed gain while on a grind line
  ICE_ACCEL: 190, // px/s² on ice
  ICE_DRAG_MULT: 0.65,
  GRIND_POINTS_EVERY: 48, // px (2 m)
  GRIND_POINTS: 5,
  GRIND_REJUMP_COOLDOWN: 0.2, // s before the same line can be caught again

  /* ---- obstacles ---- */
  ROCK_CENTER: 0.6, // rock centre sits size*this above the snow
  ROCK_HIT: 0.85, // crash radius (fraction of size)
  ROCK_TOP_ZONE: 1.3, // forgiving bounce zone radius over the top half
  ROCK_BOUNCE_VY: 430, // px/s upward after a rock bounce
  LOG_HOP_VY: 380, // px/s upward after landing on top of a log
  LOG_HOP_TOL: 10, // px below the log top that still counts as landing on it
  CAMPFIRE_HIT: 0.9,
  CHASM_POP_TOL: 16, // px below the far lip that still pops up onto it

  /* ---- crash / respawn ---- */
  CRASH_T: 0.8, // s of tumble
  CRASH_GETUP_T: 0.25, // last part of the tumble: spin settles, board comes back onto the slope
  CRASH_KEEP: 0.85, // share of the tangential speed kept when the tumble starts
  CRASH_SLIDE_TO: 0.6, // the sliding tumble eases toward this × cruise (never a dead stop)
  CRASH_SLIDE_RATE: 2.2, // 1/s
  CRASH_THROW_VY: 320, // px/s: hitting an obstacle throws the rider up and over it
  CRASH_MIN_THROW: 0.55, // × cruise: minimum forward speed of that throw
  CRASH_SPIN: 13, // rad/s initial tumble spin
  CRASH_SPIN_DECAY: 2.2, // 1/s
  RESPAWN_MIN_FRAC: 0.55, // × cruise: speed when getting up
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
    Object.freeze({ min: 10, bonus: 0.22, duration: 2.2, kick: 72 }),
    Object.freeze({ min: 60, bonus: 0.3, duration: 3.0, kick: 96 }),
    Object.freeze({ min: 200, bonus: 0.36, duration: 4.0, kick: 120 }),
  ]),
  BOOST_FULL_FRAC: 0.3,
  BOOST_EASE: 20, // 1/s: the applied boost eases in (~0.15 s) and out instead of switching
  KICK_RATE: 1200, // px/s²: the bank kick is delivered at this rate (72-120 px/s → 0.06-0.1 s) // boost runs at full power for this fraction, then fades smoothly
  BOOST_PUSH: 300, // px/s² of extra push per +100% tier bonus, while below the boosted cruise speed
  BOOST_EXTEND: 0.35, // re-banking adds this fraction of the overlap
  BOOST_MAX_T: 6, // s cap
  SHIELD_FRAC: 0.6, // shield during the first 60% of a boost
  MAX_SPEED_MULT: 1.26, // cap on scarf × boost cruise multiplier (keeps long tier-3 chains readable)
  SCARF_SPEED_BONUS: 0.06, // full scarf raises cruise speed by 6% (scarf mostly feeds the boost cap headroom + score)
  SCARF_PER_POINT: 0.009, // scarf gained per banked combo point (total)
  SCARF_MAX_GAIN: 0.25, // per bank
  SCARF_DECAY: 0.045, // per second
  SCARF_PER_COIN: 0.006,

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
  BACKFLIP: 10,
  FLIP_BONUS: Object.freeze([0, 0, 30, 100, 200, 350]),
  FLIP_LABELS: Object.freeze(['', 'Backflip', 'Double Backflip', 'Triple Backflip', 'Quadruple Backflip', 'Quintuple Backflip']),
  GRIND: 10,
  ROCK_BOUNCE: 80,
  CHASM: 40,
  PROXIMITY: 20,
  BIG_AIR: 20,
  SMASH: 30, // any obstacle smashed while shielded
  LOG_HOP: 40,
  COIN: 2,
});
