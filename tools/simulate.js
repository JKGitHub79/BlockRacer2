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

['config.js', 'src/track.js', 'src/car.js'].forEach(function (file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
});

var BR = sandbox.window.BR;
var STEP = 1 / 120;

function makeConfig(overrides) {
  var cfg = Object.assign({}, BR.DEFAULT_CONFIG, overrides || {});
  cfg.roadWidth = cfg.carWidth * cfg.roadWidthInCars;
  return cfg;
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
check('qualifying is not a free pass (margin < 3s)',
      clean.lapTime !== null && (qual - clean.lapTime) < 3.0);
check('a clean lap stays on the road', clean.offRoadTime < 0.30);

// ---------------------------------------------------------------------------
console.log('\n=== 2. Hands off the wheel (corners must need driving) ===\n');

var hands = run(base, function () { return 0; });
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
var three = makeConfig({ laps: 3 });
check('3 laps: target scales to ' + (three.track.qualifyingTime * 3).toFixed(1) + 's',
      Math.abs(clean.lapTime * 3 - three.track.qualifyingTime * 3) < 9.0,
      '3 clean laps ~ ' + (clean.lapTime * 3).toFixed(2) + 's');

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

console.log('');
if (failures.length) {
  console.log(failures.length + ' CHECK(S) FAILED:');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
console.log('All checks passed.\n');
