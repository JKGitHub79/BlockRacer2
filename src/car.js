/* Car physics.
 *
 * The handling model, in one paragraph:
 *
 * The car's heading is real state that is integrated over time — it is NOT
 * snapped onto the road. What the Turning Angle limits is the OFFSET between
 * the car's heading and the direction of the road underneath it, so the car
 * can never rotate past +/- that angle away from the road and can never spin
 * around. Holding left/right pushes that offset outwards; releasing lets it
 * fall back towards 0, which means "pointing the same way as this part of the
 * track". Crucially the fall-back rate (returnRateDeg) is slower than a corner
 * turns, so letting go mid-corner runs you wide onto the grass: corners have to
 * be driven. Once a corner is done and you release, the car settles onto the
 * new road direction and simply holds it — e.g. after a 45 degree left-hander
 * the car sits at 45 degrees in world terms, which is 0 degrees to the road.
 */
(function (BR) {
  'use strict';

  var TAU = Math.PI * 2;

  // The return-to-road rate is PROPORTIONAL to how far the car is turned, not
  // constant. cfg.returnRateDeg is defined as the rate at this reference
  // offset, and the rate scales linearly from there, so a car at full lock
  // snaps back hard while a nearly-straight car is barely nudged.
  //
  // This is what lets the steering feel responsive without handing the player
  // the corners. A constant rate couples the two: fast enough to feel good
  // (>=80 deg/s) and a hands-off car simply follows the bends; slow enough to
  // keep the corners honest (40 deg/s) and it takes over a second to
  // straighten up. Proportional return separates them — see the measurements
  // in tools/simulate.js section 8.
  var RETURN_REFERENCE_DEG = 45;

  // A small constant floor so the last fraction of a degree actually closes
  // rather than decaying asymptotically forever. Kept low enough not to affect
  // handling (8 deg/s moves the hands-off test by ~1px).
  var RETURN_FLOOR_DEG = 8;

  function wrapAngle(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }

  function Car(cfg, track) {
    this.cfg = cfg;
    this.track = track;
    this.reset();
  }

  Car.prototype.reset = function () {
    var start = this.track.start;
    this.x = start.x;
    this.y = start.y;
    this.heading = start.h;
    this.speed = 0;
    this.hint = 0;
    this.loc = BR.track.locate(this.track, this.x, this.y, 0);
    this.offRoad = false;
    this.offRoadTimer = 0;
    this.recoverFlash = 0;
    this.slideVel = 0;
    this.slideDecel = 0;
    this.slidePeak = 0;
    // Defined up front so anything reading it before the first update() (the
    // HUD during the countdown, for instance) sees 0 rather than undefined.
    this.steerOffset = 0;
  };

  /* Put the car back on the grid for a new lap, carrying its speed over. */
  Car.prototype.startNewLap = function () {
    var start = this.track.start;
    this.x = start.x;
    this.y = start.y;
    this.heading = start.h;
    this.hint = 0;
    this.loc = BR.track.locate(this.track, this.x, this.y, 0);
    this.offRoad = false;
    this.offRoadTimer = 0;
    this.recoverFlash = 0;
    this.slideVel = 0;
    this.slideDecel = 0;
    this.slidePeak = 0;
    this.steerOffset = 0;
  };

  /* `input` is -1 (left), 0 (released) or +1 (right). */
  Car.prototype.update = function (dt, input) {
    var cfg = this.cfg;
    var roadHeading = this.loc.heading;
    var maxOffset = cfg.turningAngleDeg * Math.PI / 180;

    // --- Steering ---------------------------------------------------------
    if (input !== 0) {
      this.heading += input * (cfg.steerRateDeg * Math.PI / 180) * dt;
    } else {
      // Rotate back towards the direction of the road, faster the further the
      // car is turned away from it. See RETURN_REFERENCE_DEG above.
      var diff = wrapAngle(roadHeading - this.heading);
      var offsetDeg = Math.abs(diff) * 180 / Math.PI;
      var rateDeg = Math.max(RETURN_FLOOR_DEG,
                             cfg.returnRateDeg * (offsetDeg / RETURN_REFERENCE_DEG));
      var step = (rateDeg * Math.PI / 180) * dt;
      this.heading += Math.max(-step, Math.min(step, diff));
    }

    // Hard clamp: the car may never sit further than the Turning Angle away
    // from the road direction, in either direction.
    var offset = wrapAngle(this.heading - roadHeading);
    if (offset > maxOffset) this.heading = roadHeading + maxOffset;
    else if (offset < -maxOffset) this.heading = roadHeading - maxOffset;
    this.heading = wrapAngle(this.heading);
    this.steerOffset = wrapAngle(this.heading - roadHeading);

    // --- Speed (automatic; there is no throttle or brake) -----------------
    var accel = cfg.fullSpeed / cfg.accelerationTime;
    var targetSpeed = this.offRoad ? cfg.fullSpeed * cfg.offRoadSpeedFactor : cfg.fullSpeed;
    // AI cars set this each step to avoid driving through the car in front.
    // The player never sets it, so nothing caps them.
    if (this.speedLimit !== undefined) targetSpeed = Math.min(targetSpeed, this.speedLimit);

    if (this.speed < targetSpeed) {
      this.speed = Math.min(targetSpeed, this.speed + accel * dt);
    } else {
      this.speed = Math.max(targetSpeed, this.speed - accel * cfg.offRoadBrakeFactor * dt);
    }

    // --- Move -------------------------------------------------------------
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    // --- Turning slide ----------------------------------------------------
    // Lateral momentum that outlives the steering. While a turn is being held
    // at top speed the car is "charging": the slide adds nothing, it just
    // remembers how fast sideways the car is going. The moment the steering
    // eases, that sideways speed is handed to the slide, which bleeds it off
    // under a fixed deceleration sized to cover exactly slideDistance.
    //
    // The slide runs ALONGSIDE the heading rather than being netted off it.
    // Subtracting the heading's own lateral rate instead made the configured
    // number meaningless — the carry depended on how fast the heading happened
    // to unwind, so 30px carried 29px but 50px carried 27px.
    var slideExtra = 0;
    if (cfg.slideDistance > 0) {
      var lateral = this.speed * Math.sin(this.steerOffset);
      var atTopSpeed = this.speed >= cfg.fullSpeed * cfg.slideMinSpeedFraction;
      // Charging is driven by the STEERING INPUT, not by the lateral rate.
      // Inferring it from the rate looked equivalent on a straight but broke
      // in corners: the road heading turns under the car, so steerOffset (and
      // with it the lateral rate) rises on its own without any input, which
      // read as "turning harder" and wiped a slide already under way. The
      // slide flickered on and off every other frame through every bend —
      // precisely where it matters most.
      if (!atTopSpeed) {
        this.slidePeak = 0;            // a slide can only start at top speed
      } else if (input !== 0) {
        // Gripping: remember the hardest sideways rate reached, no slide yet.
        if (Math.abs(lateral) >= Math.abs(this.slidePeak) ||
            lateral * this.slidePeak < 0) {
          this.slidePeak = lateral;
        }
        this.slideVel = 0;
      } else if (this.slidePeak !== 0) {
        // Steering released after a charged turn: hand the momentum over.
        this.slideVel = this.slidePeak;
        this.slideDecel = (this.slidePeak * this.slidePeak) / (2 * cfg.slideDistance);
        this.slidePeak = 0;
      }

      if (this.slideVel !== 0) {
        var bleed = this.slideDecel * dt;
        this.slideVel = this.slideVel > 0 ? Math.max(0, this.slideVel - bleed)
                                          : Math.min(0, this.slideVel + bleed);
        slideExtra = this.slideVel;
      }

      // Keep it inside the playable area: no sliding further out once the car
      // is already well off the road.
      var overrun = this.track.halfWidth + cfg.carWidth * cfg.slideOverrunLimitInCars;
      var goingOut = (this.loc.lateral >= 0) === (slideExtra >= 0);
      if (goingOut && Math.abs(this.loc.lateral) > overrun) slideExtra = 0;

      if (slideExtra !== 0) {
        this.x += -Math.sin(roadHeading) * slideExtra * dt;
        this.y += Math.cos(roadHeading) * slideExtra * dt;
      }
    } else {
      this.slideVel = 0;
      this.slidePeak = 0;
    }
    this.slideExtra = slideExtra;

    // --- Re-locate against the track --------------------------------------
    this.loc = BR.track.locate(this.track, this.x, this.y, this.hint,
                               this.searchBehind, this.searchAhead);
    this.hint = this.loc.index;
    this.offRoad = Math.abs(this.loc.lateral) > this.track.halfWidth;

    // --- Recovery ---------------------------------------------------------
    // Realigning the heading with the road does nothing to bring the car's
    // POSITION back, so a botched corner otherwise leaves you running parallel
    // to the track and far wide of it for the rest of the lap. Lift the car
    // back on after offRoadResetSeconds. See config.js for the full rationale.
    if (this.offRoad) {
      this.offRoadTimer += dt;
      if (cfg.offRoadResetSeconds > 0 && this.offRoadTimer >= cfg.offRoadResetSeconds) {
        var back = BR.track.at(this.track, this.loc.s);
        this.x = back.x;
        this.y = back.y;
        this.heading = back.h;
        this.speed *= 0.5;
        this.offRoadTimer = 0;
        this.recoverFlash = 1.2;   // seconds the HUD announces the recovery for
        this.loc = BR.track.locate(this.track, this.x, this.y, this.hint);
        this.hint = this.loc.index;
        this.offRoad = false;
      }
    } else {
      this.offRoadTimer = 0;
    }
    if (this.recoverFlash > 0) this.recoverFlash -= dt;
  };

  Car.prototype.hasFinishedLap = function () {
    return this.loc.s >= this.track.length - 1;
  };

  BR.Car = Car;
  BR.wrapAngle = wrapAngle;
})(window.BR);
