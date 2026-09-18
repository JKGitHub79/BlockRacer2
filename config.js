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


  /* --- Handling tuning (file only) ---------------------------------------- */

  // How fast holding left/right builds up steering offset, in degrees/second.
  steerRateDeg: 200,

  // How fast the steering offset falls back to 0 (i.e. back to the direction
  // of the road) once you release the keys, in degrees/second.
  //
  // This is the single most important number in the game. The corners turn at
  // 45deg / 0.4s = 112 deg/s, so at 40 deg/s the car CANNOT follow a corner on
  // its own — leave the wheel alone through a bend and you run about 130px wide
  // onto the grass, on a road whose edge is only 64px from the centre. Raise it
  // towards 112 to make the game more forgiving; above that the corners drive
  // themselves and there is no game left. (tools/simulate.js checks this.)
  returnRateDeg: 40,


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
  roadWidthInCars: 4,    // road width measured in car widths -> 4 * 32 = 128px

  // How far ahead of the car the camera looks, as a fraction of a screen
  // height, at Full Speed. 0 keeps the car dead centre.
  lookAhead: 0.30,


  /* --- Track 1 ------------------------------------------------------------- */
  // Sections are described in SECONDS AT FULL SPEED, not in pixels, so the
  // layout is independent of the Full Speed setting.
  //   { type: 'straight', seconds }
  //   { type: 'turn', dir: -1 (left) | +1 (right), degrees, seconds }
  //
  // Track 1 layout, per the design:
  //   straight 1s | left + straight 3s | right + straight 3s | left 45 + straight 3s
  // = 10s of track. Add roughly 1s lost to the standing start and a clean run
  // lands just under the 12s qualifying time.
  track: {
    name: 'Track 1',
    qualifyingTime: 12.0,  // seconds, PER LAP
    segments: [
      { type: 'straight', seconds: 1.0 },

      { type: 'turn', dir: -1, degrees: 45, seconds: 0.4 },
      { type: 'straight', seconds: 2.6 },

      { type: 'turn', dir: +1, degrees: 45, seconds: 0.4 },
      { type: 'straight', seconds: 2.6 },

      { type: 'turn', dir: -1, degrees: 45, seconds: 0.4 },
      { type: 'straight', seconds: 2.6 }
    ]
  }
};

/* Bounds used to sanity-check both file values and title-screen input. */
BR.CONFIG_LIMITS = {
  turningAngleDeg:  { min: 5,   max: 90,   step: 1 },
  accelerationTime: { min: 0.2, max: 10,   step: 0.1 },
  laps:             { min: 1,   max: 20,   step: 1 },
  fullSpeed:        { min: 120, max: 1200, step: 10 }
};
