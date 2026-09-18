/* End-to-end browser test:  node tools/browser-test.js [--shots <dir>]
 *
 * Loads index.html in headless Chromium, checks the title screen wiring,
 * then drives a full lap with real keyboard events and asserts the run
 * qualifies. Requires Playwright (this container ships it globally).
 */
'use strict';

var path = require('path');
var PW = process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright';
var chromium = require(PW).chromium;

var shotsIndex = process.argv.indexOf('--shots');
var SHOTS = shotsIndex > -1 ? process.argv[shotsIndex + 1] : null;
var URL = 'file://' + path.join(__dirname, '..', 'index.html');

var failures = [];
function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!ok) failures.push(label);
}

function shot(page, name) {
  return SHOTS ? page.screenshot({ path: path.join(SHOTS, name) }) : Promise.resolve();
}

(function main() {
  var browser, page;
  var errors = [];

  chromium.launch().then(function (b) {
    browser = b;
    return b.newPage({ viewport: { width: 1000, height: 680 } });
  }).then(function (p) {
    page = p;
    p.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
    p.on('console', function (m) { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    return p.goto(URL);
  }).then(function () {
    return page.waitForTimeout(400);
  }).then(function () {
    return run();
  }).then(function () {
    return browser.close();
  }).then(function () {
    console.log('');
    if (errors.length) { console.log('Page errors:'); errors.forEach(function (e) { console.log('  ' + e); }); }
    if (failures.length || errors.length) {
      console.log((failures.length + errors.length) + ' PROBLEM(S).');
      process.exit(1);
    }
    console.log('All browser checks passed.\n');
  }).catch(function (err) {
    console.error(err);
    if (browser) browser.close();
    process.exit(1);
  });

  function state() {
    return page.evaluate(function () {
      var g = window.__game;
      return {
        phase: g.phase,
        elapsed: g.elapsed,
        lap: g.lap,
        speed: g.car.speed,
        offRoad: g.car.offRoad,
        offsetDeg: g.car.steerOffset * 180 / Math.PI,
        lateral: g.car.loc.lateral,
        s: g.car.loc.s,
        cfg: { turningAngleDeg: g.cfg.turningAngleDeg, accelerationTime: g.cfg.accelerationTime,
               laps: g.cfg.laps, fullSpeed: g.cfg.fullSpeed },
        trackLength: g.track.length,
        qualifying: g.track.qualifyingTime
      };
    });
  }

  /* Same proportional driver as tools/simulate.js, evaluated in the page. */
  function desiredInput() {
    return page.evaluate(function () {
      var g = window.__game, BR = window.BR, car = g.car;
      var ahead = BR.track.at(g.track, Math.min(g.track.length, car.loc.s + Math.max(60, car.speed * 0.35)));
      var desired = ahead.h - Math.max(-0.7, Math.min(0.7, car.loc.lateral * 0.006));
      var err = BR.wrapAngle(desired - car.heading);
      return err > 0.02 ? 1 : (err < -0.02 ? -1 : 0);
    });
  }

  function run() {
    console.log('\n=== Title screen ===\n');

    return state().then(function (s0) {
      check('starts on the title screen', s0.phase === 'title');
      return page.textContent('#config-summary');
    }).then(function (summary) {
      check('summary names the track and qualifying time',
            /Track 1/.test(summary) && /12\.00s/.test(summary), summary.trim());

      // Move the Turning Angle slider and confirm it reaches the config.
      return page.fill('#cfg-turning-angle', '20').then(function () {
        return page.dispatchEvent('#cfg-turning-angle', 'input');
      });
    }).then(function () {
      return page.textContent('#cfg-turning-angle-value');
    }).then(function (text) {
      check('slider updates its readout', text.trim() === '20°', text.trim());
      return state();
    }).then(function (s) {
      check('slider updates the live config', s.cfg.turningAngleDeg === 20, 'cfg=' + s.cfg.turningAngleDeg);

      // Put it back, then verify Reset restores the file defaults.
      return page.fill('#cfg-turning-angle', '30')
        .then(function () { return page.dispatchEvent('#cfg-turning-angle', 'input'); })
        .then(function () { return page.click('#btn-reset'); })
        .then(state);
    }).then(function (s) {
      check('"Reset to file defaults" restores the file value',
            s.cfg.turningAngleDeg === 45, 'cfg=' + s.cfg.turningAngleDeg);
      return shot(page, '01-title.png');
    }).then(function () {

      console.log('\n=== Race ===\n');
      return page.click('#btn-start');
    }).then(function () {
      return page.waitForTimeout(900);
    }).then(function () {
      return shot(page, '02-countdown.png');
    }).then(function () {
      return state();
    }).then(function (s) {
      check('countdown holds the car still before GO',
            s.phase === 'countdown' && s.speed === 0 && s.elapsed === 0,
            s.phase + ' speed=' + s.speed.toFixed(0));
      return drive();
    });
  }

  /* Poll the page, press/release arrow keys for real, until the race ends. */
  function drive() {
    var held = 0;
    var deadline = Date.now() + 45000;
    var midShotTaken = false;
    var peakSpeed = 0, offRoadSamples = 0, samples = 0, maxOffset = 0;

    function tick() {
      if (Date.now() > deadline) return Promise.resolve({ timeout: true });

      return state().then(function (s) {
        if (s.phase === 'finished') return { final: s };

        if (s.phase === 'racing') {
          samples++;
          peakSpeed = Math.max(peakSpeed, s.speed);
          maxOffset = Math.max(maxOffset, Math.abs(s.offsetDeg));
          if (s.offRoad) offRoadSamples++;
        }

        var pre = Promise.resolve();
        if (!midShotTaken && s.phase === 'racing' && s.s > s.trackLength * 0.45) {
          midShotTaken = true;
          pre = shot(page, '03-racing.png');
        }

        return pre.then(function () {
          return s.phase === 'racing' ? desiredInput() : 0;
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

    return tick().then(function (result) {
      if (result.timeout) {
        check('race finishes', false, 'timed out after 45s');
        return shot(page, '04-result.png');
      }

      var s = result.final;
      console.log('  lap time ' + s.elapsed.toFixed(2) + 's   qualifying ' + s.qualifying.toFixed(2) + 's');
      console.log('  peak speed ' + peakSpeed.toFixed(0) + ' / ' + s.cfg.fullSpeed
                + '   off-road ' + ((offRoadSamples / Math.max(1, samples)) * 100).toFixed(0) + '% of samples'
                + '   peak steering offset ' + maxOffset.toFixed(0) + '°\n');

      check('race finishes', true, s.elapsed.toFixed(2) + 's');
      check('a driven lap qualifies', s.elapsed <= s.qualifying);
      check('reaches full speed', peakSpeed >= s.cfg.fullSpeed - 1,
            peakSpeed.toFixed(0) + ' px/s');
      check('steering offset never breaks the Turning Angle',
            maxOffset <= s.cfg.turningAngleDeg + 0.5, maxOffset.toFixed(1) + '°');

      return shot(page, '04-result.png')
        .then(function () { return page.textContent('#result-heading'); })
        .then(function (heading) {
          check('result screen reports QUALIFIED', (heading || '').trim() === 'QUALIFIED',
                (heading || '').trim());
        });
    });
  }
})();
