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


  /* --- Lanes (title screen + file) ----------------------------------------- */

  // How many lanes the road has. The road width, the dashed dividers, the
  // starting grid and the lanes the AI race on are all derived from this, so
  // nothing is hard-coded to a particular count.
  //
  // Range 3-6. Capped at 6 (384px) because the track doubles back on itself:
  // the closest approach between distant parts of the centreline is 490px, so
  // a road much wider than that would overlap itself — tools/simulate.js
  // checks this at the maximum. The floor is 3 rather than 2 because a 2-lane
  // road is only 128px wide, narrower than anything this track has been shown
  // to be drivable on, and the reference driver in the harness clips the edge
  // on the 90 degree corners.
  lanes: 5,

  /* --- AI cars (title screen + file) --------------------------------------- */

  // How many AI cars line up on the grid. They run the same physics as the
  // player and each gets its own top speed and lane.
  aiCars: 12,

  // Their top speeds, as fractions of Full Speed, spread across the field.
  // Deliberately just below 1, so a clean lap reels the field in over most of
  // the distance rather than in the first few seconds, while time lost on the
  // grass hands places straight back.
  //
  // The spread sets how long the chase lasts. At 0.72-0.96 the player closed
  // on the average car at ~70px/s and led a 12-car field outright by 10s of a
  // 40s lap. The quickest AI must stay reachable though: a car this much
  // slower closes at (1 - aiSpeedMax) x Full Speed, so at 0.96 the player
  // gains ~17px/s and is still second at 20s of a 40s lap, taking the lead
  // around 30s. Raise it towards 1.0 to stretch the chase further; past about
  // 0.98 the leaders stop being catchable at all within a lap.
  aiSpeedMin: 0.82,
  aiSpeedMax: 0.96,

  // Seconds the AI take to reach their own top speed. Well under the player's
  // Acceleration on purpose: the field launches off the line and is gone while
  // the player is still winding up, which is what makes it a chase rather than
  // a procession. Lower for a more dramatic getaway.
  aiAccelerationTime: 0.7,

  // Fixed seed, so a given car count always produces the same field and lap
  // times stay reproducible.
  aiSeed: 20260919,

  // Starting grid. Rows run up the road ahead of the player, who starts on the
  // line at s = 0. Cars grid one per lane, so the grid width follows the lane
  // count; BR.deriveConfig works out gridPerRow.
  gridRowSpacing: 95,
  gridStartGap: 80,

  /* --- Turning slide (title screen + file) --------------------------------- */

  // Slide Distance: how far, in world pixels, the car keeps drifting sideways
  // after you stop turning at top speed. 0 disables the slide entirely.
  //
  // Only the player slides, and only at (or effectively at) top speed — see
  // slideMinSpeedFraction. Below that the car changes direction as crisply as
  // it always did, so the slide is purely a high-speed penalty.
  //
  // The mechanism is lateral momentum: while you hold a turn at top speed the
  // car banks up sideways speed, and when you release, that speed bleeds off
  // under constant deceleration rather than stopping dead. The deceleration is
  // sized from the sideways speed at the moment of release so the carry is
  // this many pixels whatever speed you were sliding at, which is what makes
  // the number mean something you can tune by feel.
  slideDistance: 50,

  // Fraction of Full Speed at which the slide starts to apply. 0.98 is
  // "effectively at top speed" — it stops the slide flickering on and off
  // while the car is a hair under the limit.
  slideMinSpeedFraction: 0.98,

  // The slide will not push the car further than this beyond the road edge, so
  // it can never fling a car that is already off into the middle of a field.
  slideOverrunLimitInCars: 1,

  /* --- Off-road penalty (title screen + file) ------------------------------ */

  // Grass Slowdown: how much speed the grass costs you, as a percentage. At 50
  // the car is held to half of Full Speed while off the road — 58 km/h against
  // 116 on tarmac. The physics use the surviving fraction
  // (offRoadSpeedFactor), which BR.deriveConfig works out from this.
  //
  // At 0 the grass costs nothing and the road edges stop mattering, which
  // removes the only penalty for missing a corner.
  grassSlowdownPct: 50,

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

  // Width of a single lane, in car widths. The road is lanes x this x carWidth
  // wide, so adding lanes widens the road rather than squeezing the existing
  // ones. At 2 a lane is 64px against a 32px car.
  laneWidthInCars: 2,

  // How far ahead of the car the camera looks at Full Speed, as a fraction of
  // the visible world extent ON EACH AXIS. 0 keeps the car dead centre. The
  // car ends up at most 2 x this from the middle of the screen (so 0.19 puts
  // it ~38% of the way to the edge), identically on every display, while a
  // taller screen turns that same framing into more visible road ahead.
  lookAhead: 0.19,

  // How much the camera pulls back at Full Speed, as a fraction. 0.18 means
  // 18% more world is visible flat out than standing still, so accelerating
  // reads as the view opening out. Set to 0 for a fixed camera.
  //
  // The zoom only ever widens the view, never tightens it, so the guarantee
  // that every screen sees at least viewMinWorld still holds — the tightest
  // the camera ever gets is a standing start.
  speedZoom: 0.18,

  // World pixels per metre, used only for the km/h readout. The car is 56px
  // long and a real hatchback is about 4.3m, so ~13 px/m. At Full Speed 420
  // px/s that reads as 116 km/h.
  pixelsPerMetre: 13,

  // Spacing between the roadside marker posts, in world pixels. At Full Speed
  // 120px means about 3.5 posts a second flicking past on each side, which is
  // the clearest single cue that the car is moving. Raise to thin them out.
  markerSpacing: 120,

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
  // Track 1 is built from a base layout, then the whole thing again with every
  // turn reversed — a left becomes a right and vice versa:
  //
  //   Base   straight 1s | L45 + 3s | R45 + 3s | L45 + 3s
  //          straight 1s | L90 + 3s | R90 + 3s | L90 + 3s
  //   Mirror straight 1s | R45 + 3s | L45 + 3s | R45 + 3s
  //          straight 1s | R90 + 3s | L90 + 3s | R90 + 3s
  //
  // = 40s of track. The mirrored half unwinds exactly the rotation the base
  // half puts in, so the car finishes pointing the way it started.
  //
  // Every corner shares the same 214px radius: the 90 degree turns take twice
  // the arc time (0.8s vs 0.4s) for twice the angle. Taken in 0.4s a 90 degree
  // turn would have a 107px radius against a 96px half-width, leaving an 11px
  // inner edge — a kink, not a corner.
  track: {
    name: 'Track 1',

    // A clean lap is ~39.7s (the racing line cuts inside the centreline on
    // twelve corners, so it beats the 40s the centreline would take).
    //
    // Tightened from 44.0 when the default went to 5 lanes. A 320px road is
    // far easier to stay on than the old 192px one: the same three-second
    // excursion that used to cost 2.53s now costs 1.62s, so at 44.0 two
    // mistakes no longer lost you qualifying. At 42.5 the difficulty profile
    // matches every earlier version — one mistake eats most of the margin,
    // two lose the run. Raise it if you widen the road further.
    //
    // Trimmed again to 42.0 when the slide went in: carrying a little extra
    // lateral through the corners makes a clean lap ~0.6s quicker (39.13s),
    // which had quietly widened the margin again.
    qualifyingTime: 42.0,  // seconds, PER LAP

    segments: (function () {
      var base = [
        /* --- 45 degree turns --- */
        { type: 'straight', seconds: 1.0 },
        { type: 'turn', dir: -1, degrees: 45, seconds: 0.4 },
        { type: 'straight', seconds: 2.6 },
        { type: 'turn', dir: +1, degrees: 45, seconds: 0.4 },
        { type: 'straight', seconds: 2.6 },
        { type: 'turn', dir: -1, degrees: 45, seconds: 0.4 },
        { type: 'straight', seconds: 2.6 },

        /* --- the same layout with 90 degree turns --- */
        { type: 'straight', seconds: 1.0 },
        { type: 'turn', dir: -1, degrees: 90, seconds: 0.8 },
        { type: 'straight', seconds: 2.2 },
        { type: 'turn', dir: +1, degrees: 90, seconds: 0.8 },
        { type: 'straight', seconds: 2.2 },
        { type: 'turn', dir: -1, degrees: 90, seconds: 0.8 },
        { type: 'straight', seconds: 2.2 }
      ];

      // The same sections again, every turn flipped left-for-right.
      var mirrored = base.map(function (seg) {
        if (seg.type !== 'turn') return { type: 'straight', seconds: seg.seconds };
        return { type: 'turn', dir: -seg.dir, degrees: seg.degrees, seconds: seg.seconds };
      });

      return base.concat(mirrored);
    })()
  }
};

/* Bounds used to sanity-check both file values and title-screen input. */
BR.CONFIG_LIMITS = {
  turningAngleDeg:  { min: 5,   max: 90,   step: 1 },
  accelerationTime: { min: 0.2, max: 10,   step: 0.1 },
  laps:             { min: 1,   max: 20,   step: 1 },
  fullSpeed:        { min: 120, max: 1200, step: 10 },
  steerRateDeg:     { min: 60,  max: 6000, step: 10 },
  returnRateDeg:    { min: 30,  max: 400,  step: 10 },
  grassSlowdownPct: { min: 0,   max: 90,   step: 5 },
  aiCars:           { min: 5,   max: 100,  step: 1 },
  lanes:            { min: 3,   max: 6,    step: 1 },
  slideDistance:    { min: 0,   max: 250,  step: 5 }
};

/* Values worked out from the settings above rather than set directly.
 * Everything that builds a config — the title screen, the saved settings and
 * the headless harness — goes through here, so they cannot drift apart. */
BR.deriveConfig = function (cfg) {
  // Lane count drives the road, not the other way round.
  cfg.laneWidth = cfg.carWidth * cfg.laneWidthInCars;
  cfg.roadWidth = cfg.laneWidth * cfg.lanes;

  // One grid car per lane. Never fewer than two columns, so a two-lane road
  // still forms a grid rather than a single file.
  cfg.gridPerRow = Math.max(2, cfg.lanes);

  // Grass Slowdown is the speed you LOSE; the physics want what survives.
  cfg.offRoadSpeedFactor = 1 - (cfg.grassSlowdownPct / 100);
  return cfg;
};

/* Centre of lane `index` (0-based), as an offset from the centreline.
 * Everything that positions a car across the road goes through this, so lane
 * geometry is defined in exactly one place. */
BR.laneCentre = function (cfg, index) {
  return -cfg.roadWidth / 2 + cfg.laneWidth * (index + 0.5);
};
