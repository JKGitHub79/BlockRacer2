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
               laps: g.cfg.laps, fullSpeed: g.cfg.fullSpeed,
               steerRateDeg: g.cfg.steerRateDeg, returnRateDeg: g.cfg.returnRateDeg },
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
    var qualifying = null;
    console.log('\n=== Title screen ===\n');

    return state().then(function (s0) {
      check('starts on the title screen', s0.phase === 'title');
      qualifying = s0.qualifying;
      return page.textContent('#config-summary');
    }).then(function (summary) {
      // Read the expected time from the game rather than hardcoding it, so
      // changing the track does not require editing this test.
      check('summary names the track and qualifying time',
            /Track 1/.test(summary) && summary.indexOf(qualifying.toFixed(2) + 's') > -1,
            summary.trim());

      // Every slider must reach the live config and show its own readout.
      var sliders = [
        { id: 'cfg-turning-angle', key: 'turningAngleDeg',  set: '20',  shows: '20\u00B0' },
        { id: 'cfg-acceleration',  key: 'accelerationTime', set: '3',   shows: '3.0s' },
        { id: 'cfg-laps',          key: 'laps',             set: '2',   shows: '2' },
        { id: 'cfg-full-speed',    key: 'fullSpeed',        set: '600', shows: '600 px/s' },
        { id: 'cfg-steer-rate',    key: 'steerRateDeg',     set: '6000', shows: '6000\u00B0/s' },
        { id: 'cfg-return-rate',   key: 'returnRateDeg',    set: '120', shows: '120\u00B0/s' }
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
          check(sl.key + ': readout updates', text.trim() === sl.shows,
                'showed "' + text.trim() + '"');
          return state();
        }).then(function (st) {
          check(sl.key + ': reaches the live config',
                Number(st.cfg[sl.key]) === Number(sl.set), 'cfg=' + st.cfg[sl.key]);
        });
      });
      return chain;
    }).then(function () {
      // The ends of each range must be visible, and the derived hints must say
      // what a value actually does — this is what makes the sliders trialable.
      return page.evaluate(function () {
        var ids = ['cfg-turning-angle', 'cfg-acceleration', 'cfg-steer-rate',
                   'cfg-return-rate', 'cfg-laps', 'cfg-full-speed'];
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
      var allLabelled = Object.keys(labels).every(function (id) {
        return labels[id].min && labels[id].max;
      });
      check('every slider shows the ends of its range', allLabelled,
            'e.g. steering ' + labels['cfg-steer-rate'].min + ' to ' + labels['cfg-steer-rate'].max);
      check('Steering Speed range now tops out at 6000',
            labels['cfg-steer-rate'].attrMax === '6000', labels['cfg-steer-rate'].attrMax);
      // At 6000 deg/s full lock arrives in well under one 60Hz frame (16.7ms),
      // which is the saturation the hint is there to make visible.
      check('Steering Speed hint shows it saturating at the top of the range',
            /lock in 0\.0(0|1)/.test(labels['cfg-steer-rate'].hint || ''),
            labels['cfg-steer-rate'].hint);
      check('Turning Angle hint reports sideways speed',
            /px\/s across/.test(labels['cfg-turning-angle'].hint || ''),
            labels['cfg-turning-angle'].hint);
      return null;
    }).then(function () {
      // Reset must restore every file default, not just the last one touched.
      return page.click('#btn-reset').then(state);
    }).then(function (s) {
      check('"Reset to file defaults" restores all six values',
            s.cfg.turningAngleDeg === 45 && s.cfg.accelerationTime === 2
              && s.cfg.laps === 1 && s.cfg.fullSpeed === 420
              && s.cfg.steerRateDeg === 280 && s.cfg.returnRateDeg === 170,
            JSON.stringify(s.cfg));
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
