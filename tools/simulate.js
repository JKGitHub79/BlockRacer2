/* Headless physics harness:  node tools/simulate.js
 *
 * Loads the real config/track/car modules (no browser) and runs the same
 * fixed-step loop the game uses. It answers three questions that decide
 * whether the track is fair:
 *
 *   1. Can a clean lap beat the 12s qualifying time (but not trivially)?
 *   2. Does letting go of the wheel actually lose you the corners? If a
 *      hands-off run stays on the road, the corners drive themselves and
 *      there is no game.
 *   3. Do the title-screen settings still hold up at their extremes?
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
// In a browser `window` IS the global object, so `window.BR = ...` also creates
// a bare `BR` global. Point the sandbox's `window` at itself to reproduce that.
var sandbox = { Math: Math, console: console };
sandbox.window = sandbox;
vm.createContext(sandbox);

['config.js', 'src/track.js', 'src/car.js', 'src/ai.js'].forEach(function (file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
});

var BR = sandbox.window.BR;
var STEP = 1 / 120;

function makeConfig(overrides) {
  var cfg = Object.assign({}, BR.DEFAULT_CONFIG, overrides || {});
  return BR.deriveConfig(cfg);
}

/* A proportional driver: aim at the road a short distance ahead and correct
 * for how far off the centreline we are. Deliberately simple — if a naive
 * controller can get round, a human can. */
function autopilot(cfg, track, car) {
  var aheadDist = Math.max(60, car.speed * 0.35);
  var ahead = BR.track.at(track, Math.min(track.length, car.loc.s + aheadDist));
  var desired = ahead.h - Math.max(-0.7, Math.min(0.7, car.loc.lateral * 0.006));
  var err = BR.wrapAngle(desired - car.heading);
  if (err > 0.02) return 1;
  if (err < -0.02) return -1;
  return 0;
}

function run(cfg, driver) {
  var track = BR.track.build(cfg);
  var car = new BR.Car(cfg, track);
  var t = 0, lapTime = null, offRoadTime = 0, maxLateral = 0;

  while (t < 120) {
    car.update(STEP, driver(cfg, track, car));
    t += STEP;
    if (car.offRoad) offRoadTime += STEP;
    maxLateral = Math.max(maxLateral, Math.abs(car.loc.lateral));
    if (car.hasFinishedLap()) { lapTime = t; break; }
  }
  return {
    track: track, lapTime: lapTime, offRoadTime: offRoadTime,
    maxLateral: maxLateral, halfWidth: track.halfWidth
  };
}

function fmt(n, d) { return n === null ? '  DNF ' : n.toFixed(d === undefined ? 2 : d); }

var failures = [];
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!ok) failures.push(label);
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. Clean lap vs qualifying time ===\n');

var base = makeConfig();
var clean = run(base, autopilot);
var qual = base.track.qualifyingTime;

console.log('  track length   ' + clean.track.length.toFixed(0) + ' px'
          + '  (' + (clean.track.length / base.fullSpeed).toFixed(2) + 's at full speed)');
console.log('  lap time       ' + fmt(clean.lapTime) + 's   qualifying ' + qual.toFixed(2) + 's');
console.log('  time off road  ' + clean.offRoadTime.toFixed(2) + 's');
console.log('  max lateral    ' + clean.maxLateral.toFixed(1) + ' px  (road edge at '
          + clean.halfWidth.toFixed(0) + ' px)\n');

check('a clean lap qualifies', clean.lapTime !== null && clean.lapTime <= qual,
      'margin ' + (clean.lapTime === null ? 'n/a' : (qual - clean.lapTime).toFixed(2) + 's'));
// Proportional, not absolute: the margin has to stay tight relative to the lap,
// and the track has quadrupled in length since this check was first written.
check('qualifying is not a free pass (margin < 15% of the lap)',
      clean.lapTime !== null && (qual - clean.lapTime) < clean.lapTime * 0.15,
      (100 * (qual - clean.lapTime) / clean.lapTime).toFixed(1) + '% slack');
check('a clean lap stays on the road', clean.offRoadTime < 0.30);

// ---------------------------------------------------------------------------
console.log('\n=== 2. Hands off the wheel (corners must need driving) ===\n');

// Recovery is disabled here on purpose: lifting the car back onto the track
// after 3s truncates the excursion and would understate how far a hands-off
// car actually strays. This section is about the steering model alone.
var hands = run(makeConfig({ offRoadResetSeconds: 0 }), function () { return 0; });
console.log('  lap time       ' + fmt(hands.lapTime) + 's');
console.log('  time off road  ' + hands.offRoadTime.toFixed(2) + 's');
console.log('  max lateral    ' + hands.maxLateral.toFixed(1) + ' px  (road edge at '
          + hands.halfWidth.toFixed(0) + ' px)\n');

// Measured on time as well as distance: the off-road recovery in car.js caps
// how far the car can stray, so peak lateral alone understates the excursion.
check('hands-off leaves the road decisively',
      hands.maxLateral > hands.halfWidth * 1.5 && hands.offRoadTime > 2.0,
      (hands.maxLateral - hands.halfWidth).toFixed(0) + ' px past the edge, '
        + hands.offRoadTime.toFixed(1) + 's on the grass');
check('hands-off fails to qualify', hands.lapTime === null || hands.lapTime > qual,
      hands.lapTime === null ? 'did not finish' : fmt(hands.lapTime) + 's');

// ---------------------------------------------------------------------------
console.log('\n=== 3. Settings sweep (each still drivable) ===\n');

var sweeps = [
  ['Turning Angle  15deg', { turningAngleDeg: 15 }],
  ['Turning Angle  45deg', { turningAngleDeg: 45 }],
  ['Turning Angle  90deg', { turningAngleDeg: 90 }],
  ['Acceleration   0.5s',  { accelerationTime: 0.5 }],
  ['Acceleration   2.0s',  { accelerationTime: 2.0 }],
  ['Acceleration   5.0s',  { accelerationTime: 5.0 }],
  ['Full Speed     200',   { fullSpeed: 200 }],
  ['Full Speed     420',   { fullSpeed: 420 }],
  ['Full Speed     900',   { fullSpeed: 900 }]
];

sweeps.forEach(function (entry) {
  var cfg = makeConfig(entry[1]);
  var r = run(cfg, autopilot);
  var line = entry[0].padEnd(24)
    + 'lap ' + fmt(r.lapTime) + 's'
    + '   off-road ' + r.offRoadTime.toFixed(2) + 's'
    + '   qual ' + cfg.track.qualifyingTime.toFixed(1) + 's';
  console.log('  ' + line);
  if (r.lapTime === null) failures.push(entry[0] + ' did not finish');
});

// Multi-lap: the qualifying target scales with lap count.
console.log('');
// Proportional for the same reason as the single-lap margin above: an absolute
// tolerance here was calibrated against an 11s lap and the track is now 40s.
var three = makeConfig({ laps: 3 });
var threeTarget = three.track.qualifyingTime * 3;
var threeEstimate = clean.lapTime * 3;
check('3 laps: the scaled target stays beatable but not free',
      threeEstimate <= threeTarget && (threeTarget - threeEstimate) < threeTarget * 0.15,
      '3 clean laps ~ ' + threeEstimate.toFixed(1) + 's vs ' + threeTarget.toFixed(1) + 's target');

// ---------------------------------------------------------------------------
console.log('\n=== 4. Turning Angle is respected ===\n');

[15, 45, 90].forEach(function (deg) {
  var cfg = makeConfig({ turningAngleDeg: deg });
  var track = BR.track.build(cfg);
  var car = new BR.Car(cfg, track);
  var worst = 0;
  for (var i = 0; i < 1200; i++) {          // hold full left lock for 10s
    car.update(STEP, -1);
    worst = Math.max(worst, Math.abs(car.steerOffset) * 180 / Math.PI);
  }
  check('offset never exceeds ' + deg + 'deg at full lock',
        worst <= deg + 0.5, 'peak ' + worst.toFixed(2) + 'deg');
});

// ---------------------------------------------------------------------------
console.log('\n=== 5. Acceleration reaches full speed in the configured time ===\n');

// Measured on a straight-only track: on Track 1 a hands-off car reaches the
// first corner, runs onto the grass and hits the off-road speed cap, so it
// would never reach full speed at the slower acceleration settings.
[0.5, 2.0, 5.0].forEach(function (secs) {
  var cfg = makeConfig({ accelerationTime: secs });
  cfg.track = Object.assign({}, cfg.track, {
    segments: [{ type: 'straight', seconds: 40 }]
  });
  var track = BR.track.build(cfg);
  var car = new BR.Car(cfg, track);
  var t = 0;
  while (car.speed < cfg.fullSpeed - 0.5 && t < 30) { car.update(STEP, 0); t += STEP; }
  check('reaches full speed in ~' + secs + 's', Math.abs(t - secs) < 0.05,
        'measured ' + t.toFixed(3) + 's');
});

// ---------------------------------------------------------------------------
console.log('\n=== 6. Multi-lap ===\n');

(function () {
  var cfg = makeConfig({ laps: 3 });
  var track = BR.track.build(cfg);
  var car = new BR.Car(cfg, track);
  var t = 0, lap = 1, lapTimes = [], lapStart = 0;

  while (t < 120 && lap <= cfg.laps) {
    car.update(STEP, autopilot(cfg, track, car));
    t += STEP;
    if (car.hasFinishedLap()) {
      lapTimes.push(t - lapStart);
      lapStart = t;
      lap++;
      if (lap <= cfg.laps) car.startNewLap();
    }
  }

  console.log('  lap times      ' + lapTimes.map(function (x) { return x.toFixed(2) + 's'; }).join('   '));
  console.log('  total          ' + t.toFixed(2) + 's   target '
            + (cfg.track.qualifyingTime * cfg.laps).toFixed(2) + 's\n');

  check('all 3 laps complete', lapTimes.length === 3);
  check('3 laps beat the scaled target', t <= cfg.track.qualifyingTime * cfg.laps,
        t.toFixed(2) + 's');
  // Laps 2 and 3 start with speed already carried over, so they are quicker
  // than lap 1, which begins from a standstill.
  check('laps 2 and 3 are quicker than the standing-start lap',
        lapTimes.length === 3 && lapTimes[1] < lapTimes[0] && lapTimes[2] < lapTimes[0]);
  check('finishing a lap does not instantly re-trigger',
        lapTimes.length === 3 && lapTimes[1] > 1.0 && lapTimes[2] > 1.0);
})();

// ---------------------------------------------------------------------------
console.log('\n=== 7. Off-road recovery ===\n');

// Drive hard into the grass for 2s, then let go entirely.
//
// Note what this does NOT show: the car finishes either way. The Turning Angle
// clamp keeps the car within 45 degrees of the road direction, so it always
// retains a forward component and always reaches the line. Recovery is about
// the state it is left in, not about whether the race can end.
function runStranded(cfg) {
  var track = BR.track.build(cfg);
  var car = new BR.Car(cfg, track);
  var t = 0, finished = null, maxLateral = 0, returned = false;

  while (t < 90) {
    car.update(STEP, t < 2.0 ? -1 : 0);
    t += STEP;
    maxLateral = Math.max(maxLateral, Math.abs(car.loc.lateral));
    if (t > 3 && !car.offRoad) returned = true;
    if (car.hasFinishedLap()) { finished = t; break; }
  }
  return { finished: finished, maxLateral: maxLateral,
           finalLateral: car.loc.lateral, returned: returned };
}

var withRecovery = runStranded(makeConfig());
var without = runStranded(makeConfig({ offRoadResetSeconds: 0 }));

console.log('  recovery on   finished ' + fmt(withRecovery.finished) + 's'
          + '   crossed the line ' + Math.abs(withRecovery.finalLateral).toFixed(0) + ' px off centre');
console.log('  recovery off  finished ' + fmt(without.finished) + 's'
          + '   crossed the line ' + Math.abs(without.finalLateral).toFixed(0) + ' px off centre\n');

check('a car driven into the grass gets back on track', withRecovery.returned);
check('and finishes back on the racing line',
      Math.abs(withRecovery.finalLateral) < makeConfig().roadWidth / 2,
      Math.abs(withRecovery.finalLateral).toFixed(0) + ' px off centre');
check('without recovery it finishes far wide of the track',
      Math.abs(without.finalLateral) > makeConfig().roadWidth,
      Math.abs(without.finalLateral).toFixed(0) + ' px off centre');
check('recovery ends a botched run sooner',
      withRecovery.finished !== null && without.finished !== null
        && withRecovery.finished < without.finished,
      fmt(withRecovery.finished) + 's vs ' + fmt(without.finished) + 's');

// ---------------------------------------------------------------------------
console.log('\n=== 8. Steering feel ===\n');

// These are the numbers that decide whether the car feels responsive. The
// first tuning of this game shipped with a constant-rate return at 40 deg/s,
// which took 1.06s to straighten up after a turn against a 0.22s turn-in — a
// 5:1 asymmetry that played like a boat. Proportional return fixed it without
// making the corners any easier. These assertions exist so that cannot regress
// silently: raising returnRateDeg to chase difficulty will trip them.
(function () {
  var cfg = makeConfig();
  // Straight-only track: measuring feel, not cornering.
  cfg.track = Object.assign({}, cfg.track, { segments: [{ type: 'straight', seconds: 60 }] });
  var track = BR.track.build(cfg);
  var lock = cfg.turningAngleDeg * Math.PI / 180;

  var car = new BR.Car(cfg, track);
  for (var i = 0; i < 600; i++) car.update(STEP, 0);   // up to full speed

  var turnIn = 0;
  while (Math.abs(car.steerOffset) < lock - 0.002 && turnIn < 5) {
    car.update(STEP, -1); turnIn += STEP;
  }

  var settle = 0, halfBack = null;
  while (Math.abs(car.steerOffset) > 3 * Math.PI / 180 && settle < 10) {
    car.update(STEP, 0); settle += STEP;
    if (halfBack === null && Math.abs(car.steerOffset) < lock / 2) halfBack = settle;
  }

  // Lateral agility: how long to cross from the centreline to the road edge.
  var car2 = new BR.Car(cfg, track);
  for (i = 0; i < 600; i++) car2.update(STEP, 0);
  var toEdge = 0;
  while (!car2.offRoad && toEdge < 10) { car2.update(STEP, -1); toEdge += STEP; }

  console.log('  turn-in to full lock        ' + turnIn.toFixed(2) + 's');
  console.log('  half the angle back         ' + halfBack.toFixed(2) + 's');
  console.log('  fully settled               ' + settle.toFixed(2) + 's');
  console.log('  centre -> road edge         ' + toEdge.toFixed(2) + 's\n');

  check('turn-in is prompt (< 0.25s to full lock)', turnIn < 0.25, turnIn.toFixed(2) + 's');
  check('recovers half the angle quickly (< 0.25s)', halfBack < 0.25, halfBack.toFixed(2) + 's');
  check('settles without feeling sluggish (< 0.85s)', settle < 0.85, settle.toFixed(2) + 's');
  // Guards the asymmetry that caused the original complaint.
  check('straighten is not wildly slower than turn-in (< 5x)',
        settle < turnIn * 5, (settle / turnIn).toFixed(1) + 'x');
})();

// ---------------------------------------------------------------------------
console.log('\n=== 9. Grass slowdown ===\n');

// Grass Slowdown is the percentage of speed the grass COSTS you, so the car
// should settle at (100 - pct)% of Full Speed while off the road. Recovery is
// disabled here so the car stays on the grass long enough to settle.
console.log('  setting   expected   measured   km/h');
[0, 25, 50, 75].forEach(function (pct) {
  var cfg = makeConfig({ grassSlowdownPct: pct, offRoadResetSeconds: 0 });
  var track = BR.track.build(cfg);
  var car = new BR.Car(cfg, track);

  var t = 0;
  while (t < 6 && !car.offRoad) { car.update(STEP, -1); t += STEP; }   // get onto the grass
  var onGrass = car.offRoad;
  var settle = 0;
  while (settle < 8) { car.update(STEP, 0); settle += STEP; }          // let speed settle

  var expected = cfg.fullSpeed * (1 - pct / 100);
  var kph = (car.speed / cfg.pixelsPerMetre) * 3.6;
  console.log('  ' + (pct + '%').padEnd(10) + expected.toFixed(0).padEnd(11) +
              car.speed.toFixed(0).padEnd(11) + kph.toFixed(0));

  check(pct + '% slowdown holds the car to ' + expected.toFixed(0) + ' px/s on grass',
        onGrass && Math.abs(car.speed - expected) < 2,
        car.speed.toFixed(1) + ' px/s');
});

// The default must be the 50% the game is tuned around.
var dflt = makeConfig();
check('the default is a 50% slowdown',
      dflt.grassSlowdownPct === 50 && Math.abs(dflt.offRoadSpeedFactor - 0.5) < 1e-9,
      dflt.grassSlowdownPct + '% -> factor ' + dflt.offRoadSpeedFactor);

// What the penalty is worth in lap time. A fixed proportional margin gets more
// forgiving in absolute terms as the track grows: on the 10s version 1.2s of
// slack meant any mistake was fatal, whereas 40s of track carries 4.3s.
function lapWithExcursions(windows) {
  var cfg = makeConfig();
  var track = BR.track.build(cfg);
  var car = new BR.Car(cfg, track);
  var t = 0;
  while (t < 200) {
    var forced = windows.some(function (w) { return t > w[0] && t < w[1]; });
    car.update(STEP, forced ? -1 : autopilot(cfg, track, car));
    t += STEP;
    if (car.hasFinishedLap()) return t;
  }
  return null;
}

var cleanLap = lapWithExcursions([]);
var oneOff = lapWithExcursions([[6, 9]]);
var twoOff = lapWithExcursions([[6, 9], [20, 23]]);
var target = makeConfig().track.qualifyingTime;
var margin = target - cleanLap;

console.log('');
console.log('  clean lap            ' + cleanLap.toFixed(2) + 's   (target ' + target.toFixed(2) + 's, margin ' + margin.toFixed(2) + 's)');
console.log('  one 3s excursion     ' + oneOff.toFixed(2) + 's   costs ' + (oneOff - cleanLap).toFixed(2) + 's');
console.log('  two 3s excursions    ' + twoOff.toFixed(2) + 's   costs ' + (twoOff - cleanLap).toFixed(2) + 's\n');

check('an excursion costs real lap time', (oneOff - cleanLap) > 1.5,
      (oneOff - cleanLap).toFixed(2) + 's');
check('one excursion eats most of the qualifying margin',
      (oneOff - cleanLap) > margin * 0.5,
      ((oneOff - cleanLap) / margin * 100).toFixed(0) + '% of the margin');
// One mistake on a 40s lap is survivable by design; two are not.
check('two excursions lose qualifying', twoOff > target,
      twoOff.toFixed(2) + 's vs ' + target.toFixed(2) + 's');

// ---------------------------------------------------------------------------
console.log('\n=== 10. AI cars ===\n');

/* Runs a field for `seconds` and reports how it behaved. The player is not
 * simulated here: AI cars do not collide with anything, so they cannot affect
 * a player lap, which is why sections 1-9 stay valid with a field on track. */
function runField(count, seconds) {
  var cfg = makeConfig({ aiCars: count });
  var track = BR.track.build(cfg);
  var field = BR.ai.buildField(cfg, track);

  var t = 0, offRoadSamples = 0, samples = 0, worstGap = Infinity;
  var pairSamples = 0, overlapping = 0, speedSum = 0, speedCount = 0;

  while (t < seconds) {
    BR.ai.updateField(field, track, STEP);
    t += STEP;

    // Sample occasionally: checking every pair every step is needlessly slow.
    if (Math.round(t / STEP) % 60 !== 0) continue;
    samples++;
    for (var i = 0; i < field.length; i++) {
      if (field[i].offRoad) offRoadSamples++;
      if (!field[i].finished) {
        speedSum += field[i].speed / field[i].cfg.fullSpeed;
        speedCount++;
      }
      for (var j = i + 1; j < field.length; j++) {
        var d = Math.hypot(field[i].x - field[j].x, field[i].y - field[j].y);
        pairSamples++;
        // Cars are 32px wide, so centres closer than that overlap whatever
        // their orientation.
        if (d < cfg.carWidth) overlapping++;
        if (d < worstGap) worstGap = d;
      }
    }
  }

  var moved = 0, stuck = 0;
  field.forEach(function (c) {
    if (c.loc.s > cfg.gridStartGap + 200) moved++;
    if (c.speed < 5 && !c.finished) stuck++;
  });

  return {
    cfg: cfg, track: track, field: field,
    offRoadPct: 100 * offRoadSamples / Math.max(1, samples * field.length),
    overlapPct: 100 * overlapping / Math.max(1, pairSamples),
    avgSpeedPct: 100 * speedSum / Math.max(1, speedCount),
    worstGap: worstGap, moved: moved, stuck: stuck
  };
}

console.log('  cars   placed   off-road   overlapping   avg pace   closest');
[5, 12, 40, 100].forEach(function (count) {
  var r = runField(count, count > 40 ? 12 : 20);
  console.log('  ' + String(count).padEnd(7) + String(r.field.length).padEnd(9) +
              (r.offRoadPct.toFixed(1) + '%').padEnd(11) +
              (r.overlapPct.toFixed(2) + '%').padEnd(14) +
              (r.avgSpeedPct.toFixed(0) + '%').padEnd(11) +
              r.worstGap.toFixed(0) + 'px');

  check(count + ' cars: the whole field makes it onto the grid',
        r.field.length === count, r.field.length + ' placed');
  check(count + ' cars: the field keeps to the road',
        r.offRoadPct < 4.0, r.offRoadPct.toFixed(2) + '% of samples');
  // Momentary close quarters while a car changes lane is racing; cars sitting
  // inside each other is a pile-up. Measured as a share of all pair
  // observations rather than a single worst case, which any lane change trips.
  check(count + ' cars: cars do not sit on top of each other',
        r.overlapPct < 0.5, r.overlapPct.toFixed(2) + '% of pair samples');
  // Catches the traffic jam that car following alone produced, where the tail
  // of the field crawled at 5% of its pace.
  check(count + ' cars: the field keeps racing rather than queueing',
        r.avgSpeedPct > 60, r.avgSpeedPct.toFixed(0) + '% of their own pace');
  check(count + ' cars: none are left stranded',
        r.stuck === 0 && r.moved === r.field.length,
        r.moved + ' of ' + r.field.length + ' under way');
});

// The grid must fit on the road, not just in theory.
(function () {
  var r = runField(100, 0.1);
  var lanes = r.field.map(function (c) { return Math.abs(c.loc.lateral); });
  var widest = Math.max.apply(null, lanes);
  console.log('');
  check('a 100-car grid fits inside the road',
        widest < r.track.halfWidth, widest.toFixed(0) + 'px from centre, edge at ' +
        r.track.halfWidth);
  // The player lines up on the line with the field ahead, so they start last.
  check('the player starts at the back of the grid',
        BR.ai.playerPosition(r.field, 0) === r.field.length + 1,
        'P' + BR.ai.playerPosition(r.field, 0) + ' of ' + (r.field.length + 1));
})();

// Speeds must spread, or the field moves as one block.
(function () {
  var r = runField(40, 0.1);
  var speeds = r.field.map(function (c) { return c.cfg.fullSpeed; });
  var lo = Math.min.apply(null, speeds), hi = Math.max.apply(null, speeds);
  check('the field has a spread of top speeds',
        hi - lo > r.cfg.fullSpeed * 0.15,
        lo.toFixed(0) + '-' + hi.toFixed(0) + ' px/s vs the player\'s ' + r.cfg.fullSpeed);
  check('no AI car is faster than the player',
        hi <= r.cfg.fullSpeed, 'quickest ' + hi.toFixed(0) + ' px/s');
})();

console.log('');
if (failures.length) {
  console.log(failures.length + ' CHECK(S) FAILED:');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
console.log('All checks passed.\n');
