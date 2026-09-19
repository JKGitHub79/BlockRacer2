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
        aiCars: g.cfg.aiCars
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

/* The same proportional driver as tools/simulate.js, evaluated in the page. */
function desiredInput(page) {
  return page.evaluate(function () {
    var g = window.__game, BR = window.BR, car = g.car;
    var ahead = BR.track.at(g.track,
      Math.min(g.track.length, car.loc.s + Math.max(60, car.speed * 0.35)));
    var desired = ahead.h - Math.max(-0.7, Math.min(0.7, car.loc.lateral * 0.006));
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
      { id: 'cfg-ai-cars',      key: 'aiCars',          set: '40',   shows: '40' }
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
                 'cfg-grass-slowdown', 'cfg-ai-cars'];
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
    check('derived physics values track the sliders live',
          Math.abs(s.cfg.offRoadSpeedFactor - (1 - s.cfg.grassSlowdownPct / 100)) < 1e-9,
          s.cfg.grassSlowdownPct + '% -> factor ' + s.cfg.offRoadSpeedFactor);
    return page.click('#btn-reset').then(function () { return gameState(page); });
  }).then(function (s) {
    check('"Reset to file defaults" restores all seven values',
          s.cfg.turningAngleDeg === 45 && s.cfg.accelerationTime === 2 &&
          s.cfg.laps === 1 && s.cfg.fullSpeed === 420 &&
          s.cfg.steerRateDeg === 280 && s.cfg.returnRateDeg === 170 &&
          s.cfg.grassSlowdownPct === 50 && s.cfg.aiCars === 12,
          JSON.stringify(s.cfg));
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
    // Physics are in absolute world units and never touch the viewport, so the
    // only difference should be how well the crude autopilot happens to drive.
    check('phone and desktop lap times agree within 0.5s',
          Math.abs(phoneLap - desktopLap) < 0.5,
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
