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

['config.js', 'src/track.js', 'src/car.js', 'src/ai.js',
 'src/collision.js'].forEach(function (file) {
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
// Measured as an ABSOLUTE margin past the edge, not a multiple of the road
// width: how far a hands-off car drifts is set by the steering physics, so
// scaling the bar with the road made a wider road look like a regression when
// nothing about the handling had changed.
check('hands-off leaves the road decisively',
      hands.maxLateral > hands.halfWidth + base.carWidth * 2 && hands.offRoadTime > 2.0,
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
  // The spread is deliberately narrower than it was (0.82-0.96, not
  // 0.72-0.96) so the chase lasts; this only guards against the field all
  // running at one speed.
  check('the field has a spread of top speeds',
        hi - lo > r.cfg.fullSpeed * 0.10,
        lo.toFixed(0) + '-' + hi.toFixed(0) + ' px/s vs the player\'s ' + r.cfg.fullSpeed);
  check('no AI car is faster than the player',
        hi <= r.cfg.fullSpeed, 'quickest ' + hi.toFixed(0) + ' px/s');
})();

// ---------------------------------------------------------------------------
console.log('\n=== 11. The chase ===\n');

/* The field has to get away off the line and take most of the lap to reel in.
 * Before the AI were given their own acceleration and a tighter speed spread,
 * a clean player led a 12-car field outright by 10s of a 40s lap — the race
 * was over in a quarter of the distance. */
(function () {
  var cfg = makeConfig();
  var track = BR.track.build(cfg);
  var field = BR.ai.buildField(cfg, track);
  var player = new BR.Car(cfg, track);

  var t = 0, leadAt = null, lastAt2s = null, gapAt2s = null;
  var positions = [];

  while (t < 120) {
    BR.ai.updateField(field, track, STEP);
    player.update(STEP, autopilot(cfg, track, player));
    t += STEP;

    var pos = BR.ai.playerPosition(field, player.loc.s);
    if (leadAt === null && pos === 1) leadAt = t;
    if (lastAt2s === null && t >= 2.0) {
      lastAt2s = pos;
      var ss = field.map(function (c) { return c.loc.s; });
      gapAt2s = Math.max.apply(null, ss) - player.loc.s;
    }
    if (Math.round(t / STEP) % 600 === 0) positions.push(pos);
    if (player.hasFinishedLap()) break;
  }

  var passed = field.filter(function (c) { return c.loc.s < player.loc.s; }).length;
  var leadFrac = leadAt === null ? 1 : leadAt / t;

  console.log('  field size           ' + field.length);
  console.log('  position at 2s       P' + lastAt2s + ', leader ' + gapAt2s.toFixed(0) + 'px up the road');
  console.log('  took the lead at     ' + (leadAt === null ? 'never' : leadAt.toFixed(1) + 's')
            + '  (' + (leadFrac * 100).toFixed(0) + '% into the lap)');
  console.log('  position every 5s    ' + positions.map(function (p) { return 'P' + p; }).join(' ') + '\n');

  check('the field gets away off the line',
        lastAt2s === field.length + 1 && gapAt2s > 300,
        'still P' + lastAt2s + ' at 2s, leader ' + gapAt2s.toFixed(0) + 'px ahead');
  check('the player does not lead in the first third of the lap',
        leadFrac > 0.33, 'led from ' + (leadFrac * 100).toFixed(0) + '%');
  check('but the field is catchable with a clean lap',
        leadAt !== null, leadAt === null ? 'never caught them' : 'led from ' + leadAt.toFixed(1) + 's');
  check('the player works through the whole field',
        passed === field.length, passed + ' of ' + field.length + ' passed');
})();

// ---------------------------------------------------------------------------
console.log('\n=== 12. Lanes ===\n');

console.log('  lanes   road    lane    grid/row   AI on lane centres   widest car');
[3, 4, 5, 6].forEach(function (n) {
  var cfg = makeConfig({ lanes: n });
  var track = BR.track.build(cfg);
  var field = BR.ai.buildField(cfg, track);

  // Lane centres must be evenly spaced and sit inside the road.
  var centres = [];
  for (var i = 0; i < n; i++) centres.push(BR.laneCentre(cfg, i));
  var evenlySpaced = true;
  for (var k = 1; k < centres.length; k++) {
    if (Math.abs((centres[k] - centres[k - 1]) - cfg.laneWidth) > 1e-9) evenlySpaced = false;
  }
  var widest = Math.max.apply(null, centres.map(Math.abs));
  var insideRoad = widest + cfg.carWidth / 2 <= cfg.roadWidth / 2 + 1e-9;

  // Every car in the first row should be sitting on a lane centre.
  var firstRow = field.slice(0, cfg.gridPerRow);
  var onCentres = firstRow.every(function (c) {
    return centres.some(function (ct) { return Math.abs(c.loc.lateral - ct) < 1.5; });
  });

  console.log('  ' + String(n).padEnd(8) + (cfg.roadWidth + 'px').padEnd(8) +
              (cfg.laneWidth + 'px').padEnd(8) + String(cfg.gridPerRow).padEnd(11) +
              (onCentres ? 'yes' : 'NO').padEnd(21) + widest.toFixed(0) + 'px');

  check(n + ' lanes: road width follows the lane count',
        cfg.roadWidth === n * cfg.laneWidth, cfg.roadWidth + 'px');
  check(n + ' lanes: lane centres are evenly spaced and inside the road',
        evenlySpaced && insideRoad);
  check(n + ' lanes: one grid column per lane', cfg.gridPerRow === n);
  check(n + ' lanes: the front row grids on the lane centres', onCentres);
  check(n + ' lanes: the whole field is placed', field.length === cfg.aiCars);
});

// The track doubles back, so a road wide enough would overlap itself.
(function () {
  var cfg = makeConfig({ lanes: BR.CONFIG_LIMITS.lanes.max });
  var track = BR.track.build(cfg);
  var pts = track.points;
  var closest = Infinity;
  for (var i = 0; i < pts.length; i++) {
    for (var j = i + 1; j < pts.length; j++) {
      if (pts[j].s - pts[i].s < 600) continue;
      var d = Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
      if (d < closest) closest = d;
    }
  }
  console.log('');
  check('at the maximum lane count the road still does not overlap itself',
        closest > cfg.roadWidth,
        closest.toFixed(0) + 'px apart, road is ' + cfg.roadWidth + 'px wide');
})();

// ---------------------------------------------------------------------------
console.log('\n=== 13. Player / AI collisions ===\n');

/* A controlled straight with cars planted at known speeds, so impacts can be
 * measured rather than eyeballed. */
function collisionRig(targets) {
  var cfg = makeConfig();
  cfg.track = Object.assign({}, cfg.track, {
    segments: [{ type: 'straight', seconds: 120 }]
  });
  var track = BR.track.build(cfg);

  var field = targets.map(function (t) {
    var aiCfg = {};
    Object.keys(cfg).forEach(function (k) { aiCfg[k] = cfg[k]; });
    aiCfg.fullSpeed = t.speed;
    aiCfg.accelerationTime = 0.001;        // already up to speed
    var car = new BR.Car(aiCfg, track);
    var p = BR.track.at(track, t.s);
    var lane = t.lane === undefined ? 0 : t.lane;
    car.x = p.x - Math.sin(p.h) * lane;
    car.y = p.y + Math.cos(p.h) * lane;
    car.heading = p.h;
    car.speed = t.speed;
    car.hint = Math.round(t.s / BR.track.SAMPLE_SPACING);
    car.loc = BR.track.locate(track, car.x, car.y, car.hint);
    car.lane = lane;
    car.searchBehind = 8;
    car.searchAhead = 40;
    return car;
  });

  var player = new BR.Car(cfg, track);
  BR.collision.reset(player, field);
  return { cfg: cfg, track: track, field: field, player: player };
}

/* Drives the player forward for `seconds`, optionally steering, and records
 * everything needed to judge the collision response. */
function runRig(rig, seconds, steer, afterStep) {
  var p = rig.player, log = {
    impacts: [], maxStep: 0, passedThrough: false, recoveries: 0,
    minSpeed: Infinity, maxSpeed: 0, samples: []
  };
  var t = 0;
  while (t < seconds) {
    var before = p.speed;
    var px = p.x, py = p.y;

    var recoverBefore = p.recoverFlash;
    var contactBefore = rig.field.map(function (ai) { return !!ai.playerContact; });
    rig.field.forEach(function (ai) { ai.update(STEP, 0); });
    p.update(STEP, steer ? steer(t, p, rig) : 0);
    var hits = BR.collision.resolve(p, rig.field, rig.cfg);
    t += STEP;

    if (hits > 0) {
      // Record WHICH car each impact was with. A car hit, escaped and then
      // caught again is a legitimate second impact, not a double count, so
      // the tests need to distinguish cars from events.
      var which = -1;
      rig.field.forEach(function (ai, idx) {
        if (ai.playerContact && !contactBefore[idx]) which = idx;
      });
      log.impacts.push({ t: t, from: before, to: p.speed, car: which });
    }
    // The off-road recovery deliberately lifts the car back onto the racing
    // line, which is a ~200px jump and nothing to do with collisions. Only
    // count ordinary steps, or every run that touches grass looks unstable.
    var recovered = p.recoverFlash > recoverBefore;
    if (recovered) log.recoveries++;
    else log.maxStep = Math.max(log.maxStep, Math.hypot(p.x - px, p.y - py));
    log.minSpeed = Math.min(log.minSpeed, p.speed);
    log.maxSpeed = Math.max(log.maxSpeed, p.speed);
    // Pass-through: the player ending up in front of a car it is touching.
    rig.field.forEach(function (ai) {
      if (ai.playerContact && p.loc.s > ai.loc.s + rig.cfg.carLength) log.passedThrough = true;
    });
    if (afterStep) afterStep(rig);
    if (Math.round(t / STEP) % 60 === 0) log.samples.push(Math.round(p.speed));
  }
  return log;
}

// --- One impact at top speed ------------------------------------------------
(function () {
  var rig = collisionRig([{ s: 900, speed: 240 }]);
  var log = runRig(rig, 8);
  var first = log.impacts[0];

  console.log('  hitting a 240 px/s car at full speed');
  console.log('    impacts            ' + log.impacts.length);
  console.log('    speed before/after ' + (first ? first.from.toFixed(0) + ' -> ' + first.to.toFixed(0) : 'none'));
  console.log('    biggest step       ' + log.maxStep.toFixed(2) + 'px  (a clean step is '
            + (rig.cfg.fullSpeed * STEP).toFixed(2) + 'px)\n');

  check('the player is slowed by the impact', !!first && first.from > 400);
  check('speed drops to about the car hit',
        !!first && Math.abs(first.to - 240) < 25, first ? first.to.toFixed(0) + ' px/s vs 240' : 'no impact');
  check('one contact counts once, not every frame',
        log.impacts.length === 1, log.impacts.length + ' impacts recorded');
  check('the player does not pass through the car', !log.passedThrough);
  check('no teleporting', log.maxStep < rig.cfg.fullSpeed * STEP + 7,
        log.maxStep.toFixed(2) + 'px in one step');
  check('the player is not left stuck', rig.player.speed > 200,
        rig.player.speed.toFixed(0) + ' px/s at the end');
})();

// --- Consecutive collisions with acceleration in between --------------------
//
// Once the player is held behind a slower car they cannot reach the next one
// without pulling out, which is the intended behaviour — so this steers for
// the lane of the next car it has not hit yet, hits it, pulls out, winds back
// up to full speed, and hits the next.
(function () {
  var cfg = makeConfig();
  var targets = [
    { s: 900,  speed: 300, lane: BR.laneCentre(cfg, 1) },
    { s: 2600, speed: 240, lane: BR.laneCentre(cfg, 3) },
    { s: 4400, speed: 180, lane: BR.laneCentre(cfg, 0) }
  ];
  var rig = collisionRig(targets);
  rig.field.forEach(function (c) { c.hitOnce = false; });

  var recovered = [];
  var log = runRig(rig, 45, function (t, p) {
    // Aim for the lane of the next car still to be hit.
    var next = null;
    for (var i = 0; i < rig.field.length; i++) {
      if (!rig.field[i].hitOnce) { next = rig.field[i]; break; }
    }
    if (!next) return 0;
    var want = next.lane;
    return p.loc.lateral < want - 5 ? 1 : (p.loc.lateral > want + 5 ? -1 : 0);
  }, function (rig2) {
    // Book-keeping each step: mark cars hit, and note the best speed reached
    // between impacts.
    rig2.field.forEach(function (c) { if (c.playerContact) c.hitOnce = true; });
  });

  // First impact with each distinct car, in the order they were met.
  var firsts = [];
  log.impacts.forEach(function (i) {
    if (!firsts.some(function (f) { return f.car === i.car; })) firsts.push(i);
  });
  var drops = firsts.map(function (i) { return Math.round(i.to); });
  var befores = firsts.map(function (i) { return Math.round(i.from); });
  var speeds = targets.map(function (t) { return t.speed; });

  console.log('  three cars at 300 / 240 / 180 px/s, each in its own lane');
  console.log('    impacts            ' + log.impacts.map(function (i) {
    return 'car' + i.car + ' ' + i.from.toFixed(0) + '->' + i.to.toFixed(0);
  }).join(',  '));
  console.log('    biggest step       ' + log.maxStep.toFixed(2) + 'px\n');

  check('every car in the line is hit', firsts.length === 3,
        firsts.length + ' distinct cars hit');
  check('each impact drops to roughly the speed of the car hit',
        firsts.every(function (f, k) {
          return Math.abs(f.to - speeds[f.car]) < 30;
        }), drops.join(', ') + ' vs ' + speeds.join(', '));
  check('the player accelerates back up between different cars',
        befores.length === 3 && befores[1] > drops[0] + 80 && befores[2] > drops[1] + 80,
        'dropped to ' + drops.join('/') + ', arrived at ' + befores.join('/') + ' px/s');
  // Catching a slower car again after being pushed clear is correct, not a
  // double count — the contact genuinely ended and began again.
  check('re-catching a car already hit counts as a fresh impact',
        log.impacts.length >= firsts.length,
        log.impacts.length + ' impacts across ' + firsts.length + ' cars');
  check('repeated collisions stay stable',
        log.maxStep < cfg.fullSpeed * STEP + 7 && !log.passedThrough,
        log.maxStep.toFixed(2) + 'px biggest step');
})();

// --- Colliding while still accelerating -------------------------------------
// Two cars close together: the player is knocked down by the first and meets
// the second before it has wound back up to full speed.
(function () {
  var cfg = makeConfig();
  var rig = collisionRig([
    { s: 900,  speed: 200, lane: BR.laneCentre(cfg, 1) },
    { s: 1400, speed: 120, lane: BR.laneCentre(cfg, 3) }
  ]);
  rig.field.forEach(function (c) { c.hitOnce = false; });
  var log = runRig(rig, 25, function (t, p) {
    var next = null;
    for (var i = 0; i < rig.field.length; i++) {
      if (!rig.field[i].hitOnce) { next = rig.field[i]; break; }
    }
    if (!next) return 0;
    return p.loc.lateral < next.lane - 5 ? 1 : (p.loc.lateral > next.lane + 5 ? -1 : 0);
  }, function (r) {
    r.field.forEach(function (c) { if (c.playerContact) c.hitOnce = true; });
  });

  var second = log.impacts[1];
  console.log('  a second car met before the player is back up to speed');
  console.log('    impacts            ' + log.impacts.map(function (i) {
    return i.from.toFixed(0) + '->' + i.to.toFixed(0);
  }).join(',  ') + '\n');

  check('both cars register an impact', log.impacts.length === 2,
        log.impacts.length + ' impacts');
  check('the second impact lands mid-acceleration',
        !!second && second.from < cfg.fullSpeed - 20,
        second ? 'arrived at ' + second.from.toFixed(0) + ' px/s' : 'n/a');
  check('and still drops to roughly that car speed',
        !!second && Math.abs(second.to - 120) < 30,
        second ? second.to.toFixed(0) + ' px/s vs 120' : 'n/a');
})();

// --- Cars running side by side must not collide -----------------------------
(function () {
  var cfg = makeConfig();
  var lane = BR.laneCentre(cfg, 3) * 0.8;
  var rig = collisionRig([{ s: 400, speed: 420, lane: lane }]);
  // Player holds the centre lane; the other car runs alongside at the same pace.
  var log = runRig(rig, 10, function (t, p) {
    return p.loc.lateral < -4 ? 1 : (p.loc.lateral > 4 ? -1 : 0);
  });
  console.log('  a car running alongside in another lane');
  console.log('    impacts            ' + log.impacts.length + '  (lane gap '
            + Math.abs(lane).toFixed(0) + 'px, cars are ' + cfg.carWidth + 'px wide)\n');
  check('cars in neighbouring lanes do not collide', log.impacts.length === 0,
        log.impacts.length + ' false impacts');
})();

// ---------------------------------------------------------------------------
console.log('\n=== 14. Turning slide ===\n');

/* Runs an identical input sequence on a straight and reports where the car
 * ends up across the road, plus the biggest single step it took. Comparing a
 * run against the same run with slideDistance 0 isolates the slide exactly. */
function slideRun(opts) {
  var cfg = makeConfig({ slideDistance: opts.distance });
  cfg.track = Object.assign({}, cfg.track, { segments: [{ type: 'straight', seconds: 120 }] });
  var track = BR.track.build(cfg);
  var car = new BR.Car(cfg, track);

  // Wind up to the requested fraction of top speed before turning.
  var target = cfg.fullSpeed * (opts.speedFraction === undefined ? 1 : opts.speedFraction);
  var t = 0;
  while (car.speed < target - 0.5 && t < 10) { car.update(STEP, 0); t += STEP; }
  // Hold the speed by capping it, so a part-throttle case stays part-throttle.
  if (opts.speedFraction !== undefined && opts.speedFraction < 1) car.speedLimit = target;

  var maxStep = 0, held = 0, offRoad = false;
  function step(input) {
    var px = car.x, py = car.y;
    car.update(STEP, input);
    maxStep = Math.max(maxStep, Math.hypot(car.x - px, car.y - py));
    if (car.offRoad) offRoad = true;
  }

  while (held < opts.hold) { step(-1); held += STEP; }      // turn
  var atRelease = car.loc.lateral;
  var after = 0;
  while (after < 3.0) { step(0); after += STEP; }            // let go

  return {
    cfg: cfg, finalLateral: car.loc.lateral, atRelease: atRelease,
    maxStep: maxStep, offRoad: offRoad, halfWidth: track.halfWidth
  };
}

function slideCarry(distance, hold, speedFraction) {
  var withSlide = slideRun({ distance: distance, hold: hold, speedFraction: speedFraction });
  var without = slideRun({ distance: 0, hold: hold, speedFraction: speedFraction });
  return {
    carry: Math.abs(withSlide.finalLateral) - Math.abs(without.finalLateral),
    withSlide: withSlide, without: without
  };
}

console.log('  setting   measured carry   biggest step   stayed on road');
// Settings kept to values a 0.12s flick can carry without reaching the grass;
// beyond that the measurement is about the grass, not the slide.
[0, 20, 40, 60, 80].forEach(function (d) {
  var r = slideCarry(d, 0.12);
  console.log('  ' + (d + 'px').padEnd(10) + (r.carry.toFixed(0) + 'px').padEnd(17) +
              (r.withSlide.maxStep.toFixed(2) + 'px').padEnd(15) +
              (r.withSlide.offRoad ? 'no' : 'yes'));

  if (d === 0) {
    check('slide off means no extra travel at all', Math.abs(r.carry) < 0.5,
          r.carry.toFixed(2) + 'px');
  } else {
    // Within 15%: the heading is still unwinding while the slide bleeds off,
    // so the two overlap slightly. Close enough that the number means what it
    // says on the slider.
    check(d + 'px: the run stayed on tarmac (else the grass distorts it)',
          !r.withSlide.offRoad && !r.without.offRoad);
    check(d + 'px setting carries about that far',
          Math.abs(r.carry - d) < d * 0.15,
          'measured ' + r.carry.toFixed(0) + 'px');
  }
  check(d + 'px: movement stays smooth',
        r.withSlide.maxStep < r.withSlide.cfg.fullSpeed * STEP * 1.6,
        r.withSlide.maxStep.toFixed(2) + 'px in one step');
});

// --- Below top speed there must be no slide at all --------------------------
console.log('');
[0.5, 0.8, 0.95].forEach(function (frac) {
  var r = slideCarry(50, 0.12, frac);
  check('at ' + Math.round(frac * 100) + '% of top speed the car does not slide',
        Math.abs(r.carry) < 1.0, r.carry.toFixed(2) + 'px of carry');
});
(function () {
  var r = slideCarry(50, 0.12, 1.0);
  check('at top speed it does slide', r.carry > 20, r.carry.toFixed(0) + 'px of carry');
})();

// --- The slide must not fling a car that is already off the road ------------
// Measured as what the slide ADDS: driving hard off the side takes the car a
// long way out by itself, which is normal. The guard is that the slide stops
// contributing once the car is past the overrun limit.
(function () {
  function peakOut(distance) {
    var cfg = makeConfig({ slideDistance: distance });
    cfg.track = Object.assign({}, cfg.track, { segments: [{ type: 'straight', seconds: 120 }] });
    var track = BR.track.build(cfg);
    var car = new BR.Car(cfg, track);
    var t = 0;
    while (car.speed < cfg.fullSpeed - 0.5 && t < 10) { car.update(STEP, 0); t += STEP; }
    var held = 0, peak = 0;
    while (held < 1.2) { car.update(STEP, -1); held += STEP; peak = Math.max(peak, Math.abs(car.loc.lateral)); }
    var after = 0;
    while (after < 2.0) { car.update(STEP, 0); after += STEP; peak = Math.max(peak, Math.abs(car.loc.lateral)); }
    return { peak: peak, limit: track.halfWidth + cfg.carWidth * cfg.slideOverrunLimitInCars };
  }
  var big = peakOut(250);
  var none = peakOut(0);
  var added = big.peak - none.peak;
  console.log('');
  console.log('  driving hard off the side, 250px slide vs none:');
  console.log('    peak out           ' + big.peak.toFixed(0) + 'px vs ' + none.peak.toFixed(0) +
              'px   (overrun limit ' + big.limit.toFixed(0) + 'px)\n');
  check('a big slide setting cannot fling a car that is already off the road',
        added < 60, 'added only ' + added.toFixed(0) + 'px past the limit');
})();

// --- A collision while the car is sliding ------------------------------------
//
// Every collision test above already runs with the slide enabled at its
// default, so collisions and the slide coexist. What needs checking on its own
// is the handover: a car that arrives mid-slide must still register the
// contact, and the drift must stop dead rather than carrying the player
// sideways through the car it just hit.
//
// Done directly rather than by flicking the car across a lane and hoping the
// timing lines up: a short flick at full lock carries 173px on a road whose
// edge is 160px away, so the car left the road and the recovery put it back on
// the centreline before it ever reached the traffic.
(function () {
  var cfg = makeConfig({ slideDistance: 80 });
  var rig = collisionRig([{ s: 150, speed: 180, lane: 0 }]);
  rig.cfg.slideDistance = 80;

  var p = rig.player;
  // Bring the player up to speed just behind the other car.
  var t = 0;
  while (p.speed < rig.cfg.fullSpeed - 0.5 && t < 6) {
    rig.field[0].update(STEP, 0);
    p.update(STEP, 0);
    BR.collision.resolve(p, rig.field, rig.cfg);
    t += STEP;
  }

  // Force a live slide, then step until contact.
  // Modest enough that the car does not drift out of the other car's lane
  // before it gets there, but live for long enough to still be sliding on
  // contact.
  p.slideVel = 80;
  p.slideDecel = (80 * 80) / (2 * rig.cfg.slideDistance);
  var slidingAtImpact = false, impacts = 0, maxStep = 0, guard = 0;
  while (impacts === 0 && guard < 2400) {
    var px = p.x, py = p.y;
    var wasSliding = Math.abs(p.slideVel) > 1;
    rig.field[0].update(STEP, 0);
    p.update(STEP, 0);
    var hits = BR.collision.resolve(p, rig.field, rig.cfg);
    if (hits > 0) { impacts += hits; slidingAtImpact = wasSliding; }
    maxStep = Math.max(maxStep, Math.hypot(p.x - px, p.y - py));
    guard++;
  }

  console.log('');
  console.log('  a collision arriving while the car is sliding');
  console.log('    impacts            ' + impacts +
              '   sliding on contact: ' + (slidingAtImpact ? 'yes' : 'no'));
  console.log('    slide after impact ' + p.slideVel.toFixed(2) + ' px/s' +
              '   biggest step ' + maxStep.toFixed(2) + 'px\n');

  check('a car arriving mid-slide still registers the collision', impacts === 1,
        impacts + ' impacts');
  check('the contact happened while the slide was live', slidingAtImpact);
  check('the collision kills the slide', Math.abs(p.slideVel) < 1e-9,
        p.slideVel.toFixed(3) + ' px/s left');
  check('sliding into a car is not unstable',
        maxStep < rig.cfg.fullSpeed * STEP + 7, maxStep.toFixed(2) + 'px biggest step');
})();

// ---------------------------------------------------------------------------
console.log('\n=== 15. All three together: traffic, lanes and slide ===\n');

/* A lap driven for real against a live field, with collisions and the slide
 * both active. Sections 1-9 drive an empty track, so this is the only place
 * the three new systems meet. */
function trafficLap(opts) {
  var cfg = makeConfig(opts.cfg || {});
  var track = BR.track.build(cfg);
  var field = BR.ai.buildField(cfg, track);
  var player = new BR.Car(cfg, track);
  BR.collision.reset(player, field);

  var lanes = [];
  for (var i = 0; i < cfg.lanes; i++) lanes.push(BR.laneCentre(cfg, i) * 0.8);
  var lane = 0, t = 0, contacts = 0, crawling = 0, frozen = 0;

  while (t < 200) {
    BR.ai.updateField(field, track, STEP);

    // Move over when something slow is sitting in this lane.
    if (opts.avoid && Math.round(t / STEP) % 12 === 0) {
      var blocked = field.some(function (c) {
        var ds = c.loc.s - player.loc.s;
        return !c.finished && ds > 0 && ds < 220 &&
               Math.abs(c.loc.lateral - player.loc.lateral) < 34;
      });
      if (blocked) {
        var best = null, bestD = Infinity;
        lanes.forEach(function (L) {
          var clear = !field.some(function (c) {
            var ds = c.loc.s - player.loc.s;
            return !c.finished && ds > -90 && ds < 300 && Math.abs(c.loc.lateral - L) < 40;
          });
          var d = Math.abs(L - player.loc.lateral);
          if (clear && d < bestD && d > 10) { best = L; bestD = d; }
        });
        if (best !== null) lane = best;
      }
    }

    var ahead = BR.track.at(track, Math.min(track.length, player.loc.s + Math.max(60, player.speed * 0.35)));
    var desired = ahead.h - Math.max(-0.7, Math.min(0.7, (player.loc.lateral - lane) * 0.010));
    var err = BR.wrapAngle(desired - player.heading);
    player.update(STEP, err > 0.02 ? 1 : (err < -0.02 ? -1 : 0));
    contacts += BR.collision.resolve(player, field, cfg);
    t += STEP;

    if (t > 3 && player.speed < 60) crawling += STEP;
    if (t > 3 && player.speed < 1) frozen += STEP;
    if (player.hasFinishedLap()) {
      return { t: t, contacts: contacts, crawling: crawling, frozen: frozen };
    }
  }
  return { t: null, contacts: contacts, crawling: crawling, frozen: frozen };
}

var clean = trafficLap({ cfg: { aiCars: 5 }, avoid: true });
console.log('  cars   lane changes   lap        contacts   crawling   never finished');
[[12, true], [12, false], [40, true], [100, true]].forEach(function (e) {
  var r = trafficLap({ cfg: { aiCars: e[0] }, avoid: e[1] });
  console.log('  ' + String(e[0]).padEnd(7) + (e[1] ? 'yes' : 'no').padEnd(15) +
              (r.t === null ? ' DNF ' : r.t.toFixed(2) + 's').padEnd(11) +
              String(r.contacts).padEnd(11) + (r.crawling.toFixed(1) + 's').padEnd(11) +
              (r.t === null ? 'YES' : 'no'));

  check(e[0] + ' cars' + (e[1] ? '' : ', no lane changes') + ': the lap always finishes',
        r.t !== null, r.t === null ? 'never finished' : r.t.toFixed(2) + 's');
  // The bug this guards: AI cars used to park ON the finish line at zero
  // speed, so the player collided with one, was capped to zero and sat 57px
  // short of the flag for good.
  check(e[0] + ' cars' + (e[1] ? '' : ', no lane changes') + ': never frozen in place',
        r.frozen < 0.1, r.frozen.toFixed(1) + 's at a standstill');
  check(e[0] + ' cars' + (e[1] ? '' : ', no lane changes') + ': never left crawling',
        r.crawling < 2.0, r.crawling.toFixed(1) + 's under 60 px/s');
});

console.log('');
check('traffic costs lap time, so collisions matter',
      trafficLap({ cfg: { aiCars: 40 }, avoid: true }).t > clean.t + 1.5,
      'a light field laps in ' + clean.t.toFixed(2) + 's');

// Lanes and the slide must not break the pairing either.
[3, 6].forEach(function (n) {
  var r = trafficLap({ cfg: { lanes: n, aiCars: 20 }, avoid: true });
  check(n + ' lanes with traffic and slide: the lap still finishes',
        r.t !== null && r.frozen < 0.1,
        r.t === null ? 'never finished' : r.t.toFixed(2) + 's');
});
[0, 150].forEach(function (d) {
  var r = trafficLap({ cfg: { slideDistance: d, aiCars: 20 }, avoid: true });
  check('slide ' + d + 'px with traffic: the lap still finishes',
        r.t !== null && r.frozen < 0.1,
        r.t === null ? 'never finished' : r.t.toFixed(2) + 's');
});

console.log('');
if (failures.length) {
  console.log(failures.length + ' CHECK(S) FAILED:');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
console.log('All checks passed.\n');
