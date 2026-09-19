/* End-to-end browser test:  node tools/browser-test.js [--shots <dir>]
 *
 * Loads index.html in headless Chromium and checks:
 *   1. the title screen wiring (every slider, the range labels, reset)
 *   2. a full lap driven with real key events
 *   3. the layout and world scale across six resolutions
 *   4. touch steering on a phone viewport
 *   5. that a lap on a phone takes the same time as on a desktop
 *
 * Requires Playwright (this container ships it globally).
 */
'use strict';

var path = require('path');
var PW = process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright';
var chromium = require(PW).chromium;

var shotsIndex = process.argv.indexOf('--shots');
var SHOTS = shotsIndex > -1 ? process.argv[shotsIndex + 1] : null;
var URL = 'file://' + path.join(__dirname, '..', 'index.html');

var failures = [];
var browser = null;

function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!ok) failures.push(label);
}

function shot(page, name) {
  return SHOTS ? page.screenshot({ path: path.join(SHOTS, name) }) : Promise.resolve();
}

function newPage(size) {
  var opts = {
    viewport: { width: size.w, height: size.h },
    deviceScaleFactor: size.dpr || 1,
    isMobile: !!size.touch,
    hasTouch: !!size.touch
  };
  return browser.newPage(opts).then(function (page) {
    page.__errors = [];
    page.on('pageerror', function (e) { page.__errors.push('pageerror: ' + e.message); });
    page.on('console', function (m) {
      if (m.type() === 'error') page.__errors.push('console: ' + m.text());
    });
    return page.goto(URL).then(function () { return page; });
  });
}

function gameState(page) {
  return page.evaluate(function () {
    var g = window.__game;
    var vp = g.viewport;
    return {
      phase: g.phase,
      elapsed: g.elapsed,
      lap: g.lap,
      speed: g.car.speed,
      offRoad: g.car.offRoad,
      offsetDeg: g.car.steerOffset * 180 / Math.PI,
      s: g.car.loc.s,
      trackLength: g.track.length,
      qualifying: g.track.qualifyingTime,
      cfg: {
        turningAngleDeg: g.cfg.turningAngleDeg, accelerationTime: g.cfg.accelerationTime,
        laps: g.cfg.laps, fullSpeed: g.cfg.fullSpeed,
        steerRateDeg: g.cfg.steerRateDeg, returnRateDeg: g.cfg.returnRateDeg,
        grassSlowdownPct: g.cfg.grassSlowdownPct,
        offRoadSpeedFactor: g.cfg.offRoadSpeedFactor,
        aiCars: g.cfg.aiCars, lanes: g.cfg.lanes,
        slideDistance: g.cfg.slideDistance,
        roadWidth: g.cfg.roadWidth, laneWidth: g.cfg.laneWidth,
        gridPerRow: g.cfg.gridPerRow
      },
      fieldSize: g.field.length,
      position: g.position,
      view: {
        w: vp.w, h: vp.h, dpr: vp.dpr, scale: vp.scale, ui: vp.ui, touch: vp.touch,
        worldW: vp.worldWidth(), worldH: vp.worldHeight(),
        backingW: g.canvas.width, backingH: g.canvas.height
      }
    };
  });
}

/* The same proportional driver as tools/simulate.js, evaluated in the page —
 * including its lane changing. Now that the player collides with traffic, a
 * driver that ploughs straight into the field laps ~4s slower and cannot make
 * the qualifying time, so avoiding traffic is part of driving the lap. */
function desiredInput(page) {
  return page.evaluate(function () {
    var g = window.__game, BR = window.BR, car = g.car;

    if (window.__lane === undefined) window.__lane = 0;
    var lanes = [];
    for (var i = 0; i < g.cfg.lanes; i++) lanes.push(BR.laneCentre(g.cfg, i) * 0.8);

    var blocked = g.field.some(function (c) {
      var ds = c.loc.s - car.loc.s;
      return !c.finished && ds > 0 && ds < 220 &&
             Math.abs(c.loc.lateral - car.loc.lateral) < 34;
    });
    if (blocked) {
      var best = null, bestD = Infinity;
      lanes.forEach(function (L) {
        var clear = !g.field.some(function (c) {
          var ds = c.loc.s - car.loc.s;
          return !c.finished && ds > -90 && ds < 300 && Math.abs(c.loc.lateral - L) < 40;
        });
        var d = Math.abs(L - car.loc.lateral);
        if (clear && d < bestD && d > 10) { best = L; bestD = d; }
      });
      if (best !== null) window.__lane = best;
    }

    var ahead = BR.track.at(g.track,
      Math.min(g.track.length, car.loc.s + Math.max(60, car.speed * 0.35)));
    var desired = ahead.h -
      Math.max(-0.7, Math.min(0.7, (car.loc.lateral - window.__lane) * 0.010));
    var err = BR.wrapAngle(desired - car.heading);
    return err > 0.02 ? 1 : (err < -0.02 ? -1 : 0);
  });
}

/* Drive a full lap with real key events. Resolves with the finishing state. */
function driveLap(page, opts) {
  opts = opts || {};
  var held = 0;
  var deadline = Date.now() + 90000;
  var midShot = false;
  var peakSpeed = 0, offRoadSamples = 0, samples = 0, maxOffset = 0;

  function tick() {
    if (Date.now() > deadline) return Promise.resolve({ timeout: true });

    return gameState(page).then(function (s) {
      if (s.phase === 'finished') {
        return { final: s, peakSpeed: peakSpeed, maxOffset: maxOffset,
                 offRoadFrac: offRoadSamples / Math.max(1, samples) };
      }
      if (s.phase === 'racing') {
        samples++;
        peakSpeed = Math.max(peakSpeed, s.speed);
        maxOffset = Math.max(maxOffset, Math.abs(s.offsetDeg));
        if (s.offRoad) offRoadSamples++;
      }

      var pre = Promise.resolve();
      if (opts.midShot && !midShot && s.phase === 'racing' && s.s > s.trackLength * 0.45) {
        midShot = true;
        pre = shot(page, opts.midShot);
      }

      return pre.then(function () {
        return s.phase === 'racing' ? desiredInput(page) : 0;
      }).then(function (want) {
        if (want === held) return null;
        var steps = Promise.resolve();
        if (held === -1) steps = steps.then(function () { return page.keyboard.up('ArrowLeft'); });
        if (held === 1) steps = steps.then(function () { return page.keyboard.up('ArrowRight'); });
        if (want === -1) steps = steps.then(function () { return page.keyboard.down('ArrowLeft'); });
        if (want === 1) steps = steps.then(function () { return page.keyboard.down('ArrowRight'); });
        held = want;
        return steps;
      }).then(function () {
        return page.waitForTimeout(16);
      }).then(tick);
    });
  }
  return tick();
}

// ============================================================ 1 + 2. main ==

function sectionTitleAndRace() {
  var page, qualifying = null;

  console.log('\n=== Title screen ===\n');

  return newPage({ w: 1000, h: 680 }).then(function (p) {
    page = p;
    return page.waitForTimeout(400);
  }).then(function () {
    return gameState(page);
  }).then(function (s0) {
    check('starts on the title screen', s0.phase === 'title');
    qualifying = s0.qualifying;
    return page.textContent('#config-summary');
  }).then(function (summary) {
    // Read the expected time from the game rather than hardcoding it, so
    // changing the track does not require editing this test.
    check('summary names the track and qualifying time',
          /Track 1/.test(summary) && summary.indexOf(qualifying.toFixed(2) + 's') > -1,
          summary.trim());

    var sliders = [
      { id: 'cfg-turning-angle', key: 'turningAngleDeg',  set: '20',   shows: '20°' },
      { id: 'cfg-acceleration',  key: 'accelerationTime', set: '3',    shows: '3.0s' },
      { id: 'cfg-laps',          key: 'laps',             set: '2',    shows: '2' },
      { id: 'cfg-full-speed',    key: 'fullSpeed',        set: '600',  shows: '600 px/s' },
      { id: 'cfg-steer-rate',    key: 'steerRateDeg',     set: '6000', shows: '6000°/s' },
      { id: 'cfg-return-rate',   key: 'returnRateDeg',    set: '120',  shows: '120°/s' },
      { id: 'cfg-grass-slowdown', key: 'grassSlowdownPct', set: '75',   shows: '75%' },
      { id: 'cfg-ai-cars',      key: 'aiCars',          set: '40',   shows: '40' },
      { id: 'cfg-lanes',         key: 'lanes',           set: '4',    shows: '4' },
      { id: 'cfg-slide-distance', key: 'slideDistance',  set: '90',   shows: '90px' }
    ];

    var chain = Promise.resolve();
    sliders.forEach(function (sl) {
      chain = chain.then(function () {
        return page.fill('#' + sl.id, sl.set);
      }).then(function () {
        return page.dispatchEvent('#' + sl.id, 'input');
      }).then(function () {
        return page.textContent('#' + sl.id + '-value');
      }).then(function (text) {
        check(sl.key + ': readout updates', text.trim() === sl.shows, 'showed "' + text.trim() + '"');
        return gameState(page);
      }).then(function (st) {
        check(sl.key + ': reaches the live config',
              Number(st.cfg[sl.key]) === Number(sl.set), 'cfg=' + st.cfg[sl.key]);
      });
    });
    return chain;
  }).then(function () {
    return page.evaluate(function () {
      var ids = ['cfg-turning-angle', 'cfg-acceleration', 'cfg-steer-rate',
                 'cfg-return-rate', 'cfg-laps', 'cfg-full-speed',
                 'cfg-grass-slowdown', 'cfg-ai-cars', 'cfg-lanes',
                 'cfg-slide-distance'];
      var out = {};
      ids.forEach(function (id) {
        out[id] = {
          min: (document.getElementById(id + '-min') || {}).textContent,
          max: (document.getElementById(id + '-max') || {}).textContent,
          hint: (document.getElementById(id + '-hint') || {}).textContent,
          attrMax: document.getElementById(id).max
        };
      });
      return out;
    });
  }).then(function (labels) {
    check('every slider shows the ends of its range',
          Object.keys(labels).every(function (id) { return labels[id].min && labels[id].max; }),
          'e.g. steering ' + labels['cfg-steer-rate'].min + ' to ' + labels['cfg-steer-rate'].max);
    check('Steering Speed range tops out at 6000',
          labels['cfg-steer-rate'].attrMax === '6000', labels['cfg-steer-rate'].attrMax);
    check('Steering Speed hint shows it saturating at the top of the range',
          /lock in 0\.0(0|1)/.test(labels['cfg-steer-rate'].hint || ''),
          labels['cfg-steer-rate'].hint);
    check('Turning Angle hint reports sideways speed',
          /px\/s across/.test(labels['cfg-turning-angle'].hint || ''),
          labels['cfg-turning-angle'].hint);
    check('Grass Slowdown hint reports the resulting speed',
          /km\/h on grass/.test(labels['cfg-grass-slowdown'].hint || ''),
          labels['cfg-grass-slowdown'].hint);
    // Derived values must track the sliders LIVE, not only once a race starts.
    // This caught offRoadSpeedFactor sitting stale at 0.5 while the slider
    // read 75%, which startRace() happened to paper over by reloading.
    return gameState(page);
  }).then(function (s) {
    check('lane count drives the road width live',
          s.cfg.roadWidth === s.cfg.lanes * s.cfg.laneWidth,
          s.cfg.lanes + ' lanes -> ' + s.cfg.roadWidth + 'px');
    check('derived physics values track the sliders live',
          Math.abs(s.cfg.offRoadSpeedFactor - (1 - s.cfg.grassSlowdownPct / 100)) < 1e-9,
          s.cfg.grassSlowdownPct + '% -> factor ' + s.cfg.offRoadSpeedFactor);
    return page.click('#btn-reset').then(function () { return gameState(page); });
  }).then(function (s) {
    check('"Reset to file defaults" restores all seven values',
          s.cfg.turningAngleDeg === 45 && s.cfg.accelerationTime === 2 &&
          s.cfg.laps === 1 && s.cfg.fullSpeed === 420 &&
          s.cfg.steerRateDeg === 280 && s.cfg.returnRateDeg === 170 &&
          s.cfg.grassSlowdownPct === 50 && s.cfg.aiCars === 12 &&
          s.cfg.lanes === 5 && s.cfg.slideDistance === 50,
          JSON.stringify(s.cfg));
    check('the road width follows the lane count',
          s.cfg.roadWidth === s.cfg.lanes * s.cfg.laneWidth &&
          s.cfg.gridPerRow === s.cfg.lanes,
          s.cfg.lanes + ' lanes -> ' + s.cfg.roadWidth + 'px, ' +
          s.cfg.gridPerRow + ' per grid row');
    // The physics value has to follow the title-screen percentage.
    check('Grass Slowdown drives the physics factor',
          Math.abs(s.cfg.offRoadSpeedFactor - 0.5) < 1e-9,
          '50% -> factor ' + s.cfg.offRoadSpeedFactor);
    return shot(page, '01-title.png');
  }).then(function () {
    console.log('\n=== Race ===\n');
    return page.click('#btn-start');
  }).then(function () {
    return page.waitForTimeout(900);
  }).then(function () {
    return shot(page, '02-countdown.png');
  }).then(function () {
    return gameState(page);
  }).then(function (s) {
    check('the AI field is built to the configured size',
          s.fieldSize === s.cfg.aiCars, s.fieldSize + ' cars for a setting of ' + s.cfg.aiCars);
    // The grid sits ahead of the player, so they line up last.
    check('the player starts at the back of the grid',
          s.position === s.fieldSize + 1, 'P' + s.position + ' of ' + (s.fieldSize + 1));
    check('countdown holds the car still before GO',
          s.phase === 'countdown' && s.speed === 0 && s.elapsed === 0,
          s.phase + ' speed=' + s.speed.toFixed(0));
    return driveLap(page, { midShot: '03-racing.png' });
  }).then(function (r) {
    if (r.timeout) {
      check('race finishes', false, 'timed out');
      return shot(page, '04-result.png').then(function () { return null; });
    }
    var s = r.final;
    console.log('  lap time ' + s.elapsed.toFixed(2) + 's   qualifying ' + s.qualifying.toFixed(2) + 's');
    console.log('  peak speed ' + r.peakSpeed.toFixed(0) + ' / ' + s.cfg.fullSpeed +
                '   off-road ' + (r.offRoadFrac * 100).toFixed(0) + '% of samples' +
                '   peak steering offset ' + r.maxOffset.toFixed(0) + '°\n');

    check('race finishes', true, s.elapsed.toFixed(2) + 's');
    check('a driven lap qualifies', s.elapsed <= s.qualifying);
    check('reaches full speed', r.peakSpeed >= s.cfg.fullSpeed - 1, r.peakSpeed.toFixed(0) + ' px/s');
    check('steering offset never breaks the Turning Angle',
          r.maxOffset <= s.cfg.turningAngleDeg + 0.5, r.maxOffset.toFixed(1) + '°');

    return shot(page, '04-result.png')
      .then(function () { return page.textContent('#result-heading'); })
      .then(function (heading) {
        check('result screen reports QUALIFIED', (heading || '').trim() === 'QUALIFIED',
              (heading || '').trim());
        return s.elapsed;
      });
  }).then(function (desktopLap) {
    check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
    return page.close().then(function () { return desktopLap; });
  });
}

// ============================================================ 3. viewports ==

var SIZES = [
  { name: 'small-phone',     w: 320,  h: 568,  dpr: 2, touch: true },
  { name: 'phone-portrait',  w: 390,  h: 844,  dpr: 3, touch: true },
  { name: 'phone-landscape', w: 844,  h: 390,  dpr: 3, touch: true },
  { name: 'tablet',          w: 820,  h: 1180, dpr: 2, touch: true },
  { name: 'desktop',         w: 1440, h: 900,  dpr: 1, touch: false },
  { name: 'ultrawide',       w: 2560, h: 1080, dpr: 1, touch: false }
];

function sectionResolutions(cfgViewMinWorld) {
  var physicsReference = null;
  console.log('\n=== Resolutions ===\n');
  console.log('  size              css         dpr  backing      world seen      ui');

  var chain = Promise.resolve();
  SIZES.forEach(function (size) {
    chain = chain.then(function () {
      var page;
      return newPage(size).then(function (p) {
        page = p;
        return page.waitForTimeout(300);
      }).then(function () {
        // The primary action must not be below the fold on any screen.
        return page.evaluate(function () {
          var r = document.getElementById('btn-start').getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
        });
      }).then(function (startVisible) {
        check(size.name + ': "Start Race" reachable without scrolling', startVisible);
        return page.click('#btn-start');
      }).then(function () {
        return page.waitForTimeout(1000);        // still counting down: speed 0
      }).then(function () {
        return gameState(page);
      }).then(function (still) {
        // Stationary is the tightest the camera ever gets, so this is where
        // the guarantee has to be exact.
        var sw = Math.min(still.view.worldW, still.view.worldH);
        check(size.name + ': stationary view is exactly the guaranteed extent',
              still.speed === 0 && Math.abs(sw - cfgViewMinWorld) < 1.5,
              sw.toFixed(0) + ' vs ' + cfgViewMinWorld);
        return page.waitForTimeout(3400);        // now racing, at speed
      }).then(function () {
        return shot(page, 'res-' + size.name + '.png');
      }).then(function () {
        return gameState(page);
      }).then(function (s) {
        var v = s.view;
        console.log('  ' + size.name.padEnd(17) + (v.w + 'x' + v.h).padEnd(12) +
                    String(v.dpr).padEnd(5) + (v.backingW + 'x' + v.backingH).padEnd(13) +
                    (Math.round(v.worldW) + 'x' + Math.round(v.worldH)).padEnd(16) +
                    v.ui.toFixed(2));

        // At speed the camera pulls back, so the view may only ever be wider.
        var shortWorld = Math.min(v.worldW, v.worldH);
        check(size.name + ': at speed the view never tightens below the guarantee',
              shortWorld >= cfgViewMinWorld - 1.5,
              shortWorld.toFixed(0) + ' vs ' + cfgViewMinWorld);
        check(size.name + ': backing store matches CSS size x dpr',
              v.backingW === Math.round(v.w * v.dpr) && v.backingH === Math.round(v.h * v.dpr));
        check(size.name + ': touch detection matches the device',
              v.touch === !!size.touch, String(v.touch));

        // Run the physics directly, off the render loop, with a scripted
        // input. Identical results across resolutions prove the simulation
        // never consults the viewport — a far tighter test than comparing lap
        // times, which now swing with how traffic happens to fall.
        return page.evaluate(function () {
          var BR = window.BR, g = window.__game;
          var cfg = BR.deriveConfig(JSON.parse(JSON.stringify(BR.DEFAULT_CONFIG)));
          var track = BR.track.build(cfg);
          var car = new BR.Car(cfg, track);
          for (var i = 0; i < 1800; i++) {
            var input = (i % 400 < 120) ? -1 : ((i % 400 < 240) ? 1 : 0);
            car.update(1 / 120, input);
          }
          return { x: car.x, y: car.y, s: car.loc.s, speed: car.speed };
        }).then(function (sim) { return { v: v, sim: sim, page: page }; });
      }).then(function (bundle) {
        var v = bundle.v, sim = bundle.sim, page = bundle.page;
        if (!physicsReference) physicsReference = sim;
        check(size.name + ': physics are identical regardless of resolution',
              Math.abs(sim.x - physicsReference.x) < 1e-6 &&
              Math.abs(sim.y - physicsReference.y) < 1e-6 &&
              Math.abs(sim.speed - physicsReference.speed) < 1e-9,
              'after 15s of scripted input, s=' + sim.s.toFixed(2));
        check(size.name + ': no page errors', page.__errors.length === 0,
              page.__errors.join(' | '));
        return page.close();
      });
    });
  });
  return chain;
}

// ======================================================== 3b. sense of speed ==

/* The complaint this guards against: on a long straight it was not clear the
 * car was moving at all. Optic flow is measurable — how much of the screen
 * actually changes from frame to frame — so measure it rather than guess.
 * Before this work it was 3.1% of pixels at Full Speed, which is why the road
 * read as static. */
function sectionSenseOfSpeed() {
  console.log('\n=== Sense of speed ===\n');
  var page;

  function flow(ms) {
    return page.evaluate(function (wait) {
      var c = document.getElementById('game');
      var ctx = c.getContext('2d');
      function grab() { return ctx.getImageData(0, 0, c.width, c.height).data; }
      var a = grab();
      return new Promise(function (res) {
        setTimeout(function () {
          var b = grab(), moved = 0, sum = 0, n = 0;
          for (var i = 0; i < a.length; i += 4) {
            var d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) +
                     Math.abs(a[i + 2] - b[i + 2])) / 3;
            sum += d; if (d > 8) moved++; n++;
          }
          res({ movedPct: 100 * moved / n, meanDiff: sum / n });
        }, wait);
      });
    }, ms);
  }

  function driveTo(sMin) {
    function tick(i) {
      if (i > 2500) return Promise.resolve(false);
      return gameState(page).then(function (st) {
        if (st.phase === 'racing' && st.s > sMin && st.speed >= st.cfg.fullSpeed - 1) {
          return true;
        }
        return page.waitForTimeout(16).then(function () { return tick(i + 1); });
      });
    }
    return tick(0);
  }

  return newPage({ w: 1000, h: 680 }).then(function (p) {
    page = p;
    return page.click('#btn-start');
  }).then(function () {
    return driveTo(2600);                       // a long straight, at full speed
  }).then(function (reached) {
    check('reached a straight at full speed', reached);
    return flow(80);
  }).then(function (f) {
    console.log('  on a straight at full speed, over ~80ms:');
    console.log('    pixels visibly moving  ' + f.movedPct.toFixed(1) + '%');
    console.log('    mean pixel change      ' + f.meanDiff.toFixed(2) + ' / 255\n');
    check('the screen visibly moves on a straight', f.movedPct > 15,
          f.movedPct.toFixed(1) + '% of pixels (was 3.1% before)');
    check('mean pixel change is substantial', f.meanDiff > 3,
          f.meanDiff.toFixed(2) + ' / 255');
    return gameState(page);
  }).then(function (fast) {
    // The camera must be wider at speed than it was standing still.
    check('the camera pulls back with speed',
          fast.view.worldW > 960 * 1.05,
          Math.round(fast.view.worldW) + ' world px wide at speed vs 960 at rest');
    check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
    return page.close();
  });
}

// ================================ 3c. lanes, collisions and slide, in browser ==

/* The three new systems exercised in the real page rather than the harness:
 * the lane count reaching the road and the grid, a collision actually
 * happening while driving into traffic, and the slide carrying the car
 * sideways at top speed but not below it. */
function sectionNewSystems() {
  console.log('\n=== Lanes, collisions and slide (in the browser) ===\n');

  function withPage(setup, body) {
    var page;
    return newPage({ w: 1000, h: 680 }).then(function (p) {
      page = p;
      return setup ? setup(page) : null;
    }).then(function () {
      return body(page);
    }).then(function (r) {
      return page.close().then(function () { return r; });
    });
  }

  function setSlider(page, id, value) {
    return page.fill('#' + id, String(value)).then(function () {
      return page.dispatchEvent('#' + id, 'input');
    });
  }

  // --- lane counts reach the road, the grid and the AI ---------------------
  var chain = Promise.resolve();
  [3, 5, 6].forEach(function (lanes) {
    chain = chain.then(function () {
      return withPage(function (page) {
        return setSlider(page, 'cfg-lanes', lanes)
          .then(function () { return page.click('#btn-start'); })
          .then(function () { return page.waitForTimeout(600); });
      }, function (page) {
        return page.evaluate(function () {
          var g = window.__game;
          var lats = g.field.map(function (c) { return c.loc.lateral; });
          var distinct = [];
          lats.forEach(function (l) {
            if (!distinct.some(function (d) { return Math.abs(d - l) < 8; })) distinct.push(l);
          });
          return {
            lanes: g.cfg.lanes, road: g.cfg.roadWidth, laneWidth: g.cfg.laneWidth,
            perRow: g.cfg.gridPerRow, halfWidth: g.track.halfWidth,
            distinctLanes: distinct.length,
            widest: Math.max.apply(null, lats.map(Math.abs)),
            cars: g.field.length
          };
        });
      }).then(function (v) {
        console.log('  ' + lanes + ' lanes: road ' + v.road + 'px, ' + v.perRow +
                    ' per grid row, field across ' + v.distinctLanes + ' lanes');
        check(lanes + ' lanes: road and grid follow the setting',
              v.lanes === lanes && v.road === lanes * v.laneWidth && v.perRow === lanes);
        check(lanes + ' lanes: the track is built to that width',
              Math.abs(v.halfWidth - v.road / 2) < 0.001);
        check(lanes + ' lanes: AI cars spread across the lanes, none overhanging',
              v.distinctLanes === lanes && v.widest + 16 <= v.road / 2 + 1,
              v.distinctLanes + ' distinct lanes, widest ' + v.widest.toFixed(0) + 'px');
      });
    });
  });

  // --- a collision while driving into the pack -----------------------------
  chain = chain.then(function () {
    return withPage(function (page) {
      return setSlider(page, 'cfg-ai-cars', 100)
        .then(function () { return page.click('#btn-start'); });
    }, function (page) {
      // Drive straight into the back of the field and watch for a contact.
      function tick(i, best) {
        if (i > 1400) return Promise.resolve(best);
        return page.evaluate(function () {
          var g = window.__game;
          return { phase: g.phase, speed: g.car.speed, bump: g.car.bumpFlash || 0,
                   limit: g.car.speedLimit === undefined ? -1 : g.car.speedLimit,
                   recover: g.car.recoverFlash || 0, x: g.car.x, y: g.car.y };
        }).then(function (st) {
          // The off-road recovery deliberately lifts the car back onto the
          // racing line, a ~200px jump that has nothing to do with collisions.
          var recovered = best.prev && st.recover > best.prev.recover;
          if (best.prev && !recovered) {
            var step = Math.hypot(st.x - best.prev.x, st.y - best.prev.y);
            if (step > best.maxStep) best.maxStep = step;
          }
          best.prev = st;
          if (st.bump > 0 && !best.hit) {
            best.hit = true;
            best.speedAtHit = st.speed;
            best.limitAtHit = st.limit;
          }
          return page.waitForTimeout(16).then(function () { return tick(i + 1, best); });
        });
      }
      return tick(0, { hit: false, maxStep: 0 });
    }).then(function (r) {
      console.log('');
      check('driving into the pack produces a collision', r.hit,
            r.hit ? 'contact at ' + r.speedAtHit.toFixed(0) + ' px/s' : 'never touched a car');
      check('the collision caps the player to the car hit',
            r.hit && r.limitAtHit > 0 && r.limitAtHit < 420,
            r.hit ? 'capped to ' + r.limitAtHit.toFixed(0) + ' px/s' : 'n/a');
      check('nothing teleports while running through traffic',
            r.maxStep < 60, r.maxStep.toFixed(1) + 'px between samples');
    });
  });

  // --- a shunt costs speed, a scrape does not ------------------------------
  chain = chain.then(function () {
    return withPage(function (page) {
      return page.click('#btn-start').then(function () { return page.waitForTimeout(400); });
    }, function (page) {
      // Driven through the shipped collision module in the real page, with
      // the two cars placed by hand: real-time steering cannot be relied on
      // to produce a given overlap at a given moment.
      return page.evaluate(function () {
        var BR = window.BR, g = window.__game;

        // A straight test track built from the live config. On the real track
        // a car driving hands-off drifts wide through the corners — 217px off
        // line by the time it reaches the other car — and never touches it.
        var cfg = {};
        Object.keys(g.cfg).forEach(function (k) { cfg[k] = g.cfg[k]; });
        cfg.track = { name: 'straight', qualifyingTime: 99,
                      segments: [{ type: 'straight', seconds: 120 }] };
        var track = BR.track.build(cfg);

        function trial(lateralGap) {
          var ai = new BR.Car(cfg, track);
          var p = BR.track.at(track, 900);
          ai.x = p.x - Math.sin(p.h) * lateralGap;
          ai.y = p.y + Math.cos(p.h) * lateralGap;
          ai.heading = p.h;
          ai.speed = 200;
          ai.hint = Math.round(900 / BR.track.SAMPLE_SPACING);
          ai.loc = BR.track.locate(track, ai.x, ai.y, ai.hint);

          var car = new BR.Car(cfg, track);
          var field = [ai];
          BR.collision.reset(car, field);
          for (var i = 0; i < 1800; i++) {
            car.update(1 / 120, 0);
            var hits = BR.collision.resolve(car, field, cfg);
            if (hits > 0) {
              return { frontal: !!ai.playerContactFrontal, speed: car.speed,
                       limit: car.speedLimit === undefined ? -1 : car.speedLimit };
            }
          }
          return null;
        }
        return { square: trial(0), clip: trial(26), full: cfg.fullSpeed };
      });
    }).then(function (r) {
      console.log('');
      console.log('  square on: ' + (r.square ? (r.square.frontal ? 'shunt' : 'scrape') +
                  ' -> ' + r.square.speed.toFixed(0) + ' px/s' : 'no contact') +
                  '    clipping: ' + (r.clip ? (r.clip.frontal ? 'shunt' : 'scrape') +
                  ' -> ' + r.clip.speed.toFixed(0) + ' px/s' : 'no contact'));
      check('hitting a car square on still costs speed',
            !!r.square && r.square.frontal && r.square.speed < r.full - 100,
            r.square ? r.square.speed.toFixed(0) + ' px/s' : 'no contact');
      check('clipping a car alongside costs no speed',
            !!r.clip && !r.clip.frontal && r.clip.speed >= r.full - 1,
            r.clip ? r.clip.speed.toFixed(0) + ' px/s' : 'no contact');
      check('a scrape does not cap the player either',
            !!r.clip && r.clip.limit === -1,
            r.clip ? (r.clip.limit === -1 ? 'uncapped' : r.clip.limit.toFixed(0)) : 'n/a');
    });
  });

  // --- the slide, at top speed and below it --------------------------------
  function slideProbe(distance, fraction) {
    return withPage(function (page) {
      return setSlider(page, 'cfg-slide-distance', distance)
        .then(function () { return setSlider(page, 'cfg-ai-cars', 5); })
        .then(function () { return page.click('#btn-start'); });
    }, function (page) {
      // Wait until the car is at the requested share of top speed.
      function waitFor() {
        return page.evaluate(function (f) {
          var g = window.__game;
          if (g.phase !== 'racing') return false;
          if (f >= 1) return g.car.speed >= g.cfg.fullSpeed - 0.5;
          return g.car.speed >= g.cfg.fullSpeed * f;
        }, fraction).then(function (ready) {
          return ready ? null : page.waitForTimeout(16).then(waitFor);
        });
      }
      return waitFor().then(function () {
        // Hold the speed for the part-throttle case, then flick and release.
        return page.evaluate(function (f) {
          var g = window.__game;
          if (f < 1) g.car.speedLimit = g.cfg.fullSpeed * f;
          window.__lat0 = g.car.loc.lateral;
        }, fraction);
      }).then(function () {
        return page.keyboard.down('ArrowRight');
      }).then(function () {
        return page.waitForTimeout(120);
      }).then(function () {
        return page.keyboard.up('ArrowRight');
      }).then(function () {
        // The slide arms on the frame AFTER the steering starts easing, so
        // sampling at the exact moment of keyup always reads zero.
        return page.waitForTimeout(60);
      }).then(function () {
        return page.evaluate(function () {
          return { lat: window.__game.car.loc.lateral, start: window.__lat0,
                   slide: window.__game.car.slideVel };
        });
      }).then(function (a) {
        return page.waitForTimeout(1500).then(function () {
          return page.evaluate(function () {
            return { lat: window.__game.car.loc.lateral, start: window.__lat0 };
          });
        }).then(function (b) {
          return { moved: b.lat - a.start, slideAtRelease: a.slide };
        });
      });
    });
  }

  chain = chain.then(function () {
    return Promise.resolve()
      .then(function () { return slideProbe(0, 1); })
      .then(function (off) {
        return slideProbe(120, 1).then(function (on) {
          console.log('');
          console.log('  same flick at top speed: no slide moved ' + off.moved.toFixed(0) +
                      'px, 120px slide moved ' + on.moved.toFixed(0) + 'px');
          check('at top speed the slide carries the car further',
                on.moved > off.moved + 40,
                (on.moved - off.moved).toFixed(0) + 'px further across');
          check('the slide is live when the keys are released',
                Math.abs(on.slideAtRelease) > 1,
                on.slideAtRelease.toFixed(0) + ' px/s of drift');
        });
      })
      .then(function () { return slideProbe(120, 0.7); })
      .then(function (slow) {
        check('below top speed there is no slide at all',
              Math.abs(slow.slideAtRelease) < 1e-6,
              slow.slideAtRelease.toFixed(3) + ' px/s of drift');
      });
  });

  return chain;
}

// ================================================================ 4. touch ==

function sectionTouch() {
  console.log('\n=== Touch steering (phone portrait) ===\n');
  var page, cdp;

  function read() {
    return page.evaluate(function () {
      return {
        deg: window.__game.car.steerOffset * 180 / Math.PI,
        left: window.__game.touch.left,
        right: window.__game.touch.right
      };
    });
  }
  function hold(x, y, ms) {
    return cdp.send('Input.dispatchTouchEvent',
      { type: 'touchStart', touchPoints: [{ x: x, y: y, id: 1 }] })
      .then(function () { return page.waitForTimeout(ms); })
      .then(read)
      .then(function (st) {
        return cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          .then(function () { return st; });
      });
  }

  return newPage({ w: 390, h: 844, dpr: 3, touch: true }).then(function (p) {
    page = p;
    return page.context().newCDPSession(page);
  }).then(function (session) {
    cdp = session;
    // Check the hint while the title screen is still up — once the race
    // starts the whole overlay is display:none and nothing inside it has a
    // box, which says nothing about which hint was chosen.
    return page.evaluate(function () {
      var touchHint = document.getElementById('controls-touch');
      var keysHint = document.getElementById('controls-keys');
      return {
        touchShown: touchHint.getClientRects().length > 0,
        keysShown: keysHint.getClientRects().length > 0
      };
    });
  }).then(function (h) {
    check('touch device is told to use the screen halves, not the keyboard',
          h.touchShown && !h.keysShown,
          'touch hint ' + h.touchShown + ', keyboard hint ' + h.keysShown);
    return page.tap('#btn-start');
  }).then(function () {
    return page.waitForTimeout(4200);
  }).then(function () {
    return hold(90, 500, 450);                       // left half
  }).then(function (st) {
    check('holding the left half steers left', st.left && !st.right && st.deg < -5,
          st.deg.toFixed(0) + '°');
    return page.waitForTimeout(900).then(read);
  }).then(function (st) {
    check('releasing returns the car to the road angle',
          !st.left && !st.right && Math.abs(st.deg) < 5, st.deg.toFixed(1) + '°');
    return hold(300, 500, 450);                      // right half
  }).then(function (st) {
    check('holding the right half steers right', st.right && !st.left && st.deg > 5,
          st.deg.toFixed(0) + '°');
    return page.waitForTimeout(900);
  }).then(function () {
    return page.evaluate(function () {
      return { sx: window.scrollX, sy: window.scrollY,
               scale: window.visualViewport ? window.visualViewport.scale : 1 };
    });
  }).then(function (v) {
    check('steering never scrolls or zooms the page',
          v.sx === 0 && v.sy === 0 && Math.abs(v.scale - 1) < 0.01, JSON.stringify(v));
    check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
    return page.close();
  });
}

// ======================================================== 5. phone vs desktop ==

function sectionPhoneLap(desktopLap) {
  console.log('\n=== A lap on a phone matches a lap on a desktop ===\n');
  var page;
  return newPage({ w: 390, h: 844, dpr: 3, touch: true }).then(function (p) {
    page = p;
    return page.tap('#btn-start');
  }).then(function () {
    return driveLap(page);
  }).then(function (r) {
    if (r.timeout) {
      check('a full lap is completable on a phone', false, 'timed out');
      return page.close();
    }
    var phoneLap = r.final.elapsed;
    console.log('  desktop ' + desktopLap.toFixed(2) + 's    phone ' + phoneLap.toFixed(2) +
                's    difference ' + Math.abs(phoneLap - desktopLap).toFixed(2) + 's\n');
    check('a full lap is completable on a phone', true, phoneLap.toFixed(2) + 's');
    check('the phone lap qualifies', phoneLap <= r.final.qualifying);
    // Physics being resolution-independent is asserted exactly in the
    // resolutions section, by stepping the simulation directly. This is the
    // looser end-to-end version: with traffic and collisions in play, small
    // timing differences change which cars get passed where, so two real laps
    // no longer land within a few hundredths of each other.
    check('phone and desktop laps are comparable',
          Math.abs(phoneLap - desktopLap) < 3.0,
          Math.abs(phoneLap - desktopLap).toFixed(2) + 's apart');
    check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
    return page.close();
  });
}

// ==================================================================== main ==

var viewMinWorld = null;
var desktopLap = null;

chromium.launch().then(function (b) {
  browser = b;
  return newPage({ w: 800, h: 600 });
}).then(function (p) {
  return p.evaluate(function () { return window.BR.DEFAULT_CONFIG.viewMinWorld; })
    .then(function (v) { viewMinWorld = v; return p.close(); });
}).then(function () {
  return sectionTitleAndRace();
}).then(function (lap) {
  desktopLap = lap;
  return sectionResolutions(viewMinWorld);
}).then(function () {
  return sectionSenseOfSpeed();
}).then(function () {
  return sectionNewSystems();
}).then(function () {
  return sectionTouch();
}).then(function () {
  return desktopLap ? sectionPhoneLap(desktopLap) : null;
}).then(function () {
  return browser.close();
}).then(function () {
  console.log('');
  if (failures.length) {
    console.log(failures.length + ' PROBLEM(S):');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
  console.log('All browser checks passed.\n');
}).catch(function (err) {
  console.error(err);
  if (browser) browser.close();
  process.exit(1);
});
