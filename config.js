/* =============================================================================
 * BlockRacer2 — CONFIGURATION FILE
 * -----------------------------------------------------------------------------
 * Edit the values below to change how the game plays. Everything here is a
 * plain value; there is no build step. Reload the page to pick up changes.
 *
 * The four headline settings (Turning Angle, Acceleration, No. Laps, Full Speed)
 * are ALSO editable on the title screen. Title-screen edits are remembered in
 * the browser (localStorage); "Reset to file defaults" throws them away and
 * falls back to exactly what is written in this file.
 * ========================================================================== */

window.BR = window.BR || {};

BR.DEFAULT_CONFIG = {

  /* --- The four title-screen settings ------------------------------------ */

  // Turning Angle: how far the car may rotate away from the direction of the
  // road, in degrees. The car can never exceed this offset, so it can never
  // spin around. Default 45.
  turningAngleDeg: 45,

  // Acceleration: seconds taken to go from a standstill to Full Speed.
  // Acceleration is automatic; there is no throttle key. Default 2.
  accelerationTime: 2.0,

  // No. Laps: how many times the circuit must be completed. The qualifying
  // time is multiplied by this number. Default 1.
  laps: 1,

  // Full Speed: the car's top speed in world pixels per second. The track is
  // defined in SECONDS (see `track` below), so raising this makes the track
  // physically longer and a clean lap still takes the same time — it just
  // feels faster and leaves you less time to react. Default 420.
  fullSpeed: 420,


  /* --- Steering feel (title screen + file) --------------------------------- */

  // Steering Speed: how fast the car turns while you hold left or right, in
  // degrees/second. At 280 the car reaches full 45 degree lock in 0.17s.
  // Raising this only makes the car more responsive to YOUR input, so it costs
  // nothing in difficulty — a hands-off lap is unaffected.
  //
  // NOTE: this setting SATURATES, and well below its maximum. The car stops
  // turning once it reaches the Turning Angle, so past roughly 600 deg/s all
  // you are shortening is the time to reach a limit that is already reached in
  // under a frame. Measured, at 45 degrees of lock:
  //
  //     280 deg/s   full lock in 0.167s   centre to road edge in 0.292s
  //     600 deg/s   full lock in 0.075s   centre to road edge in 0.250s
  //    6000 deg/s   full lock in 0.008s   centre to road edge in 0.217s
  //
  // Sideways speed is pinned at fullSpeed * sin(turningAngle) = 297 px/s in all
  // three cases. If the car does not change direction hard enough, the dial is
  // turningAngleDeg (or fullSpeed), not this one. Default 280.
  steerRateDeg: 280,

  // Straighten Speed: how fast the car swings back to the direction of the
  // road once you release the keys, in degrees/second MEASURED AT 45 DEGREES OF
  // OFFSET. The rate is proportional to how far the car is turned (see
  // RETURN_REFERENCE_DEG in src/car.js), so at 170 a car at full lock starts
  // back at 170 deg/s, recovers half the angle in 0.18s and settles in 0.71s,
  // while a nearly-straight car is barely nudged.
  //
  // This is the most sensitive number in the game, because it is also what
  // decides whether the corners are a challenge. The bends turn at
  // 45deg / 0.4s = 112 deg/s. At 170 the car still cannot follow one unaided —
  // let go through a bend and you spend ~11s on the grass. Past roughly 190 the
  // car tracks the corners on its own and a hands-off lap qualifies, which is
  // no longer a game; tools/simulate.js asserts this, so if you raise it that
  // test will tell you. Default 170.
  returnRateDeg: 170,


  /* --- Off-road penalty (file only) --------------------------------------- */

  // Top speed on grass, as a fraction of Full Speed.
  offRoadSpeedFactor: 0.45,

  // How hard the grass scrubs off speed, as a multiple of normal acceleration.
  offRoadBrakeFactor: 2.5,

  // Seconds spent off the road before the car is lifted back onto the track at
  // the point it went off, at half speed.
  //
  // This goes beyond the Stage 1 brief, which has no crash or recovery rule.
  // It is a playability feature, not a safety net: because the Turning Angle
  // clamp keeps the car within 45 degrees of the road direction it always has a
  // forward component, so it reaches the finish either way. What recovery fixes
  // is the state you are left in. Realigning the car's HEADING with the road
  // does nothing to pull its POSITION back, so without this a botched corner
  // leaves you driving parallel to the track and hundreds of pixels wide of it
  // for the rest of the run — over 1200px out after a long excursion, with the
  // road not even on screen. Recovery puts you back on the racing line and gets
  // a lost run over with (roughly 17s instead of 22s).
  // Set to 0 to disable and rely on R to restart.
  offRoadResetSeconds: 3.0,


  /* --- Dimensions (file only) --------------------------------------------- */

  carWidth: 32,          // world pixels
  carLength: 56,         // world pixels

  // Road width in car widths. 3 lanes at 2 car widths each -> 6 * 32 = 192px.
  // Lane dividers are drawn at +/- roadWidth/6, splitting it into three.
  roadWidthInCars: 6,
  lanes: 3,

  // How far ahead of the car the camera looks at Full Speed, as a fraction of
  // the visible world extent ON EACH AXIS. 0 keeps the car dead centre. The
  // car ends up at most 2 x this from the middle of the screen (so 0.19 puts
  // it ~38% of the way to the edge), identically on every display, while a
  // taller screen turns that same framing into more visible road ahead.
  lookAhead: 0.19,

  // The world extent, in world pixels, guaranteed visible along the SHORTER
  // screen axis. This is what makes the game fair across displays: every
  // screen sees at least this much track in every direction, so the qualifying
  // time means the same thing on a phone and on a desktop. Lower it to zoom
  // in (bigger car, less warning of what is coming), raise it to zoom out.
  viewMinWorld: 600,


  /* --- Track 1 ------------------------------------------------------------- */
  // Sections are described in SECONDS AT FULL SPEED, not in pixels, so the
  // layout is independent of the Full Speed setting.
  //   { type: 'straight', seconds }
  //   { type: 'turn', dir: -1 (left) | +1 (right), degrees, seconds }
  //
  // Track 1 is the original layout followed by the same layout again with 90
  // degree turns instead of 45:
  //
  //   Part 1  straight 1s | L45 + straight 3s | R45 + straight 3s | L45 + straight 3s
  //   Part 2  straight 1s | L90 + straight 3s | R90 + straight 3s | L90 + straight 3s
  //
  // = 20s of track. Every corner has the same 214px radius: the 90 degree
  // turns take twice the arc time (0.8s vs 0.4s) for twice the angle, which
  // keeps the road from kinking. At 0.4s a 90 degree turn would have a 107px
  // radius against a 96px half-width, leaving an 11px inner edge — undrivable.
  track: {
    name: 'Track 1',
    // A clean lap is ~20.3s, so this leaves ~11% slack — the same proportional
    // margin the 10s version had at 12.0s against a 10.8s lap.
    qualifyingTime: 22.5,  // seconds, PER LAP
    segments: [
      /* --- Part 1: 45 degree turns --- */
      { type: 'straight', seconds: 1.0 },

      { type: 'turn', dir: -1, degrees: 45, seconds: 0.4 },
      { type: 'straight', seconds: 2.6 },

      { type: 'turn', dir: +1, degrees: 45, seconds: 0.4 },
      { type: 'straight', seconds: 2.6 },

      { type: 'turn', dir: -1, degrees: 45, seconds: 0.4 },
      { type: 'straight', seconds: 2.6 },

      /* --- Part 2: the same layout with 90 degree turns --- */
      { type: 'straight', seconds: 1.0 },

      { type: 'turn', dir: -1, degrees: 90, seconds: 0.8 },
      { type: 'straight', seconds: 2.2 },

      { type: 'turn', dir: +1, degrees: 90, seconds: 0.8 },
      { type: 'straight', seconds: 2.2 },

      { type: 'turn', dir: -1, degrees: 90, seconds: 0.8 },
      { type: 'straight', seconds: 2.2 }
    ]
  }
};

/* Bounds used to sanity-check both file values and title-screen input. */
BR.CONFIG_LIMITS = {
  turningAngleDeg:  { min: 5,   max: 90,   step: 1 },
  accelerationTime: { min: 0.2, max: 10,   step: 0.1 },
  laps:             { min: 1,   max: 20,   step: 1 },
  fullSpeed:        { min: 120, max: 1200, step: 10 },
  steerRateDeg:     { min: 60,  max: 6000, step: 10 },
  returnRateDeg:    { min: 30,  max: 400,  step: 10 }
};
