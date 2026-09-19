/* AI cars.
 *
 * They run the same physics as the player — same Car, same steering model,
 * same Turning Angle clamp and grass penalty — so they behave like cars rather
 * than like markers sliding along a rail. What differs is the driver: a
 * proportional controller that aims at the road a short distance ahead and
 * corrects towards its own preferred line across the road.
 *
 * Each car gets its own top speed, so the field strings out instead of moving
 * as one block, and its own lane so a large grid does not collapse into a
 * single stack of overlapping cars.
 *
 * They do NOT collide — with each other or with the player. See the README.
 */
(function (BR) {
  'use strict';

  var PALETTE = [
    '#3f7fd8', '#e8a33d', '#8e5cd9', '#39b3a6', '#d85c9c',
    '#6fa832', '#d9603a', '#4c6ef5', '#b8912f', '#5aa2c9'
  ];

  /* Small deterministic PRNG, so a given car count always produces the same
   * field and lap times stay reproducible across runs and devices. */
  function seeded(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function copyConfig(cfg, fullSpeed) {
    var out = {};
    Object.keys(cfg).forEach(function (k) { out[k] = cfg[k]; });
    out.fullSpeed = fullSpeed;
    // AI cars get off the line harder than the player. Car.update derives its
    // acceleration from fullSpeed / accelerationTime, so overriding the time
    // here is all it takes.
    out.accelerationTime = cfg.aiAccelerationTime;
    // The slide is a player mechanic; AI cars hold their line as before.
    out.slideDistance = 0;
    return out;
  }

  /* Cars grid on actual lane centres, so the field lines up with the painted
   * lanes whatever the lane count. BR.laneCentre is the single definition of
   * where a lane sits. */
  function laneOffset(cfg, col) {
    return BR.laneCentre(cfg, col);
  }

  /* The grid has to use the full width of the road to fit five cars abreast,
   * but that puts the outer two close enough to the edge that cornering lag
   * tips them onto the grass. So they race a narrower spread than they start
   * on and drift towards the middle once under way, which is what cars do off
   * the line anyway. Still spread enough not to stack up. */
  var RACE_LANE_FRACTION = 0.8;

  /* Car following. Without it a faster car simply drives through a slower one
   * and a large field collapses into a single overlapping heap — which is
   * exactly what a hundred cars did before this. A car closing on one ahead in
   * roughly its own lane gives up speed in proportion to the gap, so the field
   * forms queues instead of stacks. */
  var FOLLOW_GAP = 150;        // world px beyond which the car ahead is ignored
  var MIN_GAP = 72;            // world px to hold behind the car ahead
  var SAME_LANE = 34;          // lateral px within which two cars share a lane
  var SCAN_AHEAD = 10;         // how many cars up the order to look at

  /* Overtaking. Car following alone turns a big field into a traffic jam:
   * a quick car stuck behind a slow one simply queues, the queue backs up,
   * and by fifteen seconds the tail of a 40-car field is crawling at 5% of
   * full speed with cars nose-to-tail inside the following distance. Letting a
   * held-up car move to a clear lane is what makes the field race rather than
   * queue. */
  var BLOCKED_FRACTION = 0.92; // held below this much of its own pace = blocked
  var LANE_CHANGE_WAIT = 0.8;  // seconds to commit before reconsidering
  var LANE_CLEAR_AHEAD = 190;  // gap needed in the target lane to move over
  var LANE_CLEAR_BEHIND = 90;

  /* Builds the starting grid. The player sits on the line at s = 0 and the
   * field is arrayed up the road ahead, so the player can actually see the
   * cars they are racing — a grid behind the player would be invisible, the
   * camera looks forward. */
  function buildField(cfg, track) {
    var rand = seeded(cfg.aiSeed);
    var cars = [];
    var perRow = cfg.gridPerRow;

    // The lanes cars actually race on, shared so a car can pick another.
    var raceLanes = [];
    for (var c = 0; c < perRow; c++) {
      raceLanes.push(laneOffset(cfg, c) * RACE_LANE_FRACTION);
    }

    for (var i = 0; i < cfg.aiCars; i++) {
      var row = Math.floor(i / perRow);
      var col = i % perRow;
      var s = cfg.gridStartGap + row * cfg.gridRowSpacing;
      if (s > track.length - 200) break;          // never grid past the finish

      var lane = laneOffset(cfg, col);
      var factor = cfg.aiSpeedMin + rand() * (cfg.aiSpeedMax - cfg.aiSpeedMin);

      var car = new BR.Car(copyConfig(cfg, cfg.fullSpeed * factor), track);
      var p = BR.track.at(track, s);
      car.x = p.x - Math.sin(p.h) * lane;
      car.y = p.y + Math.cos(p.h) * lane;
      car.heading = p.h;
      car.speed = 0;
      car.hint = Math.round(s / BR.track.SAMPLE_SPACING);
      car.loc = BR.track.locate(track, car.x, car.y, car.hint);
      car.offRoad = false;

      // An AI car tracks its own line closely, so it never needs the wide
      // search a flung-off player car does. With a hundred cars this is the
      // difference between a comfortable frame and a dropped one.
      car.searchBehind = 8;
      car.searchAhead = 40;

      car.lane = lane * RACE_LANE_FRACTION;
      car.lanes = raceLanes;
      car.laneTimer = 0;
      car.colour = PALETTE[i % PALETTE.length];
      car.finished = false;
      cars.push(car);
    }
    return cars;
  }

  /* Aim at the road a little way ahead, corrected for how far this car is from
   * the line it wants to be on. Same shape as the driver tools/simulate.js
   * uses to prove the track is drivable, so the field is held to the standard
   * the track is validated against. */
  function drive(car, track) {
    // Gains tuned by measurement: a short lookahead with a firm lateral
    // correction holds the line far better than a long lazy one. Once the AI
    // started launching hard they reached the corners at speed and the outer
    // lanes ran wide — at 0.35/0.010 a five-car field spends no time at all on
    // the grass, against 4.5% at the 0.35/0.006 this replaced, and a longer
    // 0.55 lookahead is worse again at 9%.
    var lookahead = Math.max(60, car.speed * 0.35);
    var ahead = BR.track.at(track, Math.min(track.length, car.loc.s + lookahead));
    var error = car.loc.lateral - car.lane;
    var desired = ahead.h - Math.max(-0.7, Math.min(0.7, error * 0.010));
    var err = BR.wrapAngle(desired - car.heading);
    if (err > 0.02) return 1;
    if (err < -0.02) return -1;
    return 0;
  }

  /* Sets each car's speedLimit from the nearest car ahead in its lane. Cars
   * are sorted by track position so each only has to look at the handful
   * immediately in front of it, which keeps this linear in practice rather
   * than comparing every pair. */
  function applyFollowing(cars) {
    var order = [];
    for (var i = 0; i < cars.length; i++) {
      cars[i].speedLimit = undefined;
      if (!cars[i].finished) order.push(cars[i]);
    }
    order.sort(function (a, b) { return a.loc.s - b.loc.s; });

    for (var k = 0; k < order.length; k++) {
      var car = order[k];
      var limit = Infinity;
      for (var j = k + 1; j < order.length && j <= k + SCAN_AHEAD; j++) {
        var other = order[j];
        var gap = other.loc.s - car.loc.s;
        if (gap > FOLLOW_GAP) break;              // sorted, so nothing closer
        if (Math.abs(other.loc.lateral - car.loc.lateral) > SAME_LANE) continue;
        // Linear car following: match the car ahead at MIN_GAP, unrestricted
        // by FOLLOW_GAP, and back off below MIN_GAP to reopen the gap.
        //
        // Scaling straight off the gap instead looked reasonable but stalled
        // the start — grid rows sit 95px apart, inside the follow distance, so
        // every row throttled the one behind it and the back of a 100-car
        // field never got going at all.
        var allowed;
        if (gap < MIN_GAP) {
          allowed = other.speed * (gap / MIN_GAP);
        } else {
          var t = (gap - MIN_GAP) / (FOLLOW_GAP - MIN_GAP);
          allowed = other.speed + t * (car.cfg.fullSpeed - other.speed);
        }
        limit = Math.min(limit, Math.max(0, allowed));
      }
      if (limit !== Infinity) car.speedLimit = limit;
      car.blocked = limit < car.cfg.fullSpeed * BLOCKED_FRACTION;
    }
    return order;
  }

  /* Is `lane` clear enough around this car to move into? */
  function laneIsClear(car, lane, order) {
    for (var i = 0; i < order.length; i++) {
      var other = order[i];
      if (other === car) continue;
      var ds = other.loc.s - car.loc.s;
      if (ds > LANE_CLEAR_AHEAD || ds < -LANE_CLEAR_BEHIND) continue;
      if (Math.abs(other.lane - lane) < SAME_LANE ||
          Math.abs(other.loc.lateral - lane) < SAME_LANE) return false;
    }
    return true;
  }

  /* A held-up car looks for a clear lane, preferring the one that needs the
   * least movement. Committing for LANE_CHANGE_WAIT stops it dithering
   * between two lanes on the boundary. */
  function considerOvertaking(cars, order, dt) {
    for (var i = 0; i < cars.length; i++) {
      var car = cars[i];
      if (car.finished) continue;
      car.laneTimer -= dt;
      if (!car.blocked || car.laneTimer > 0) continue;

      var lanes = car.lanes;
      var best = null, bestDist = Infinity;
      for (var j = 0; j < lanes.length; j++) {
        var d = Math.abs(lanes[j] - car.lane);
        if (d < 1 || d > bestDist) continue;
        if (!laneIsClear(car, lanes[j], order)) continue;
        best = lanes[j];
        bestDist = d;
      }
      if (best !== null) {
        car.lane = best;
        car.laneTimer = LANE_CHANGE_WAIT;
      }
    }
  }

  function updateField(cars, track, dt) {
    var order = applyFollowing(cars);
    considerOvertaking(cars, order, dt);
    for (var i = 0; i < cars.length; i++) {
      var car = cars[i];

      if (car.finished) {
        // Coast on straight past the line, keeping speed. Parking finishers
        // ON the line turned the finish into a wall of stationary cars: the
        // player collided with one, was capped to its speed of zero, and sat
        // there 57px short of the flag for good.
        car.x += Math.cos(car.heading) * car.speed * dt;
        car.y += Math.sin(car.heading) * car.speed * dt;
        continue;
      }

      if (car.loc.s >= track.length - 1) {
        car.finished = true;
        continue;
      }
      car.update(dt, drive(car, track));
    }
  }

  /* 1 = leading. The player is ahead of every AI car that has covered less
   * ground than they have. */
  function playerPosition(cars, playerS) {
    var ahead = 0;
    for (var i = 0; i < cars.length; i++) {
      if (cars[i].loc.s > playerS) ahead++;
    }
    return ahead + 1;
  }

  BR.ai = {
    buildField: buildField,
    updateField: updateField,
    playerPosition: playerPosition,
    PALETTE: PALETTE
  };
})(window.BR);
