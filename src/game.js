/* Game: state machine, input, fixed-step loop and title-screen wiring. */
(function (BR) {
  'use strict';

  // Physics runs at a fixed step so lap times do not depend on the player's
  // monitor refresh rate — important for a game that is scored on time.
  var STEP = 1 / 120;
  var MAX_FRAME = 0.25;
  var COUNTDOWN = 3.0;

  function Game(canvas) {
    this.canvas = canvas;
    this.cfg = BR.settings.load();
    this.keys = { left: false, right: false };
    this.phase = 'title';
    this.accumulator = 0;
    this.lastFrame = 0;

    this.dom = {
      title:      document.getElementById('title-screen'),
      result:     document.getElementById('result-screen'),
      resultHead: document.getElementById('result-heading'),
      resultBody: document.getElementById('result-body'),
      start:      document.getElementById('btn-start'),
      reset:      document.getElementById('btn-reset'),
      again:      document.getElementById('btn-again'),
      menu:       document.getElementById('btn-menu'),
      pause:      document.getElementById('pause-overlay'),
      summary:    document.getElementById('config-summary')
    };

    this.viewport = new BR.Viewport(canvas, this.cfg);
    this.buildWorld();
    this.bindInput();
    this.bindTouch();
    this.bindResize();
    this.bindUI();
    this.syncFormFromConfig();
  }

  /* (Re)create the track, car and renderer from the current config. */
  Game.prototype.buildWorld = function () {
    this.track = BR.track.build(this.cfg);
    this.car = new BR.Car(this.cfg, this.track);
    this.viewport.cfg = this.cfg;
    this.viewport.measure();
    this.renderer = new BR.Renderer(this.canvas, this.cfg, this.track, this.viewport);
    this.field = BR.ai.buildField(this.cfg, this.track);
    BR.collision.reset(this.car, this.field);
    this.renderer.updateCamera(this.car, 0, true);
    this.elapsed = 0;
    this.lap = 1;
    // Worked out from the grid rather than assumed: the player starts on the
    // line with the whole field ahead, so they line up LAST, not first.
    this.position = BR.ai.playerPosition(this.field, this.car.loc.s);
    this.countdown = COUNTDOWN;
  };

  // ---------------------------------------------------------------- input --

  Game.prototype.bindInput = function () {
    var self = this;

    function setKey(e, down) {
      switch (e.key) {
        case 'ArrowLeft': case 'a': case 'A':
          self.keys.left = down; e.preventDefault(); break;
        case 'ArrowRight': case 'd': case 'D':
          self.keys.right = down; e.preventDefault(); break;
        default: return;
      }
    }

    window.addEventListener('keydown', function (e) {
      if (e.repeat) { setKey(e, true); return; }
      setKey(e, true);

      if (e.key === 'Enter' || e.key === ' ') {
        if (self.phase === 'title') { self.startRace(); e.preventDefault(); }
        else if (self.phase === 'finished') { self.startRace(); e.preventDefault(); }
      }
      if (e.key === 'r' || e.key === 'R') {
        if (self.phase !== 'title') { self.startRace(); }
      }
      if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
        if (self.phase === 'racing') self.setPhase('paused');
        else if (self.phase === 'paused') self.setPhase('racing');
      }
    });

    window.addEventListener('keyup', function (e) { setKey(e, false); });

    // Releasing focus must not leave a key stuck down.
    window.addEventListener('blur', function () {
      self.keys.left = false;
      self.keys.right = false;
      if (self.releaseTouch) self.releaseTouch();
      if (self.phase === 'racing') self.setPhase('paused');
    });

    // Switching apps or locking a phone should not run the clock on.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        self.keys.left = self.keys.right = false;
        if (self.releaseTouch) self.releaseTouch();
        if (self.phase === 'racing') self.setPhase('paused');
      }
    });
  };

  Game.prototype.steerInput = function () {
    var left = this.keys.left || this.touch.left;
    var right = this.keys.right || this.touch.right;
    if (left && !right) return -1;
    if (right && !left) return 1;
    return 0;
  };

  // ---------------------------------------------------------------- touch --

  /* Touch steering: the left half of the screen steers left, the right half
   * steers right. Pointers are tracked by id so that holding one side and
   * tapping the other behaves, and so a lifted finger only releases its own
   * side. The canvas sets `touch-action: none`, so these never scroll or zoom
   * the page. */
  Game.prototype.bindTouch = function () {
    var self = this;
    this.touch = { left: false, right: false };
    this.pointers = {};

    function sideFor(clientX) {
      var rect = self.canvas.getBoundingClientRect();
      return (clientX - rect.left) < rect.width / 2 ? 'left' : 'right';
    }

    function apply() {
      var left = false, right = false;
      Object.keys(self.pointers).forEach(function (id) {
        if (self.pointers[id] === 'left') left = true; else right = true;
      });
      self.touch.left = left;
      self.touch.right = right;
    }

    function down(e) {
      if (self.phase !== 'racing' && self.phase !== 'countdown') return;
      self.pointers[e.pointerId] = sideFor(e.clientX);
      apply();
      e.preventDefault();
    }
    function move(e) {
      if (self.pointers[e.pointerId] === undefined) return;
      // Sliding across the middle switches sides without lifting a finger.
      self.pointers[e.pointerId] = sideFor(e.clientX);
      apply();
      e.preventDefault();
    }
    function up(e) {
      if (self.pointers[e.pointerId] === undefined) return;
      delete self.pointers[e.pointerId];
      apply();
      e.preventDefault();
    }

    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('pointerleave', up);

    this.releaseTouch = function () {
      self.pointers = {};
      self.touch.left = self.touch.right = false;
    };
  };

  // --------------------------------------------------------------- resize --

  Game.prototype.bindResize = function () {
    var self = this;
    var pending = null;

    function onResize() {
      // Coalesce bursts (orientation changes fire several events) into one
      // measure on the next frame.
      if (pending) return;
      pending = window.requestAnimationFrame(function () {
        pending = null;
        if (self.viewport.measure()) {
          // Re-frame immediately so a rotation does not pan the camera.
          self.renderer.updateCamera(self.car, 0, true);
        }
      });
    }

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    // Mobile browsers change the visual viewport when chrome hides/shows
    // without always firing a window resize.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
    }
  };

  // ------------------------------------------------------------------- UI --

  Game.prototype.formFields = function () {
    return {
      turningAngleDeg:  document.getElementById('cfg-turning-angle'),
      accelerationTime: document.getElementById('cfg-acceleration'),
      lanes:            document.getElementById('cfg-lanes'),
      aiCars:           document.getElementById('cfg-ai-cars'),
      laps:             document.getElementById('cfg-laps'),
      fullSpeed:        document.getElementById('cfg-full-speed'),
      steerRateDeg:     document.getElementById('cfg-steer-rate'),
      returnRateDeg:    document.getElementById('cfg-return-rate'),
      grassSlowdownPct: document.getElementById('cfg-grass-slowdown'),
      slideDistance:    document.getElementById('cfg-slide-distance')
    };
  };

  Game.prototype.syncFormFromConfig = function () {
    var fields = this.formFields();
    var self = this;
    Object.keys(fields).forEach(function (key) {
      var el = fields[key];
      if (!el) return;
      var lim = BR.CONFIG_LIMITS[key];
      el.min = lim.min; el.max = lim.max; el.step = lim.step;
      el.value = self.cfg[key];

      // The ends of the range, so the scale of each slider is visible.
      var lo = document.getElementById(el.id + '-min');
      var hi = document.getElementById(el.id + '-max');
      if (lo) lo.textContent = self.formatSetting(key, lim.min);
      if (hi) hi.textContent = self.formatSetting(key, lim.max);

      self.renderValue(key, el, self.cfg[key]);
    });
    this.updateSummary();
  };

  /* Current value plus, where it helps, what that value actually does. */
  Game.prototype.renderValue = function (key, el, value) {
    var out = document.getElementById(el.id + '-value');
    if (out) out.textContent = this.formatSetting(key, value);
    var hint = document.getElementById(el.id + '-hint');
    if (hint) hint.textContent = this.describeSetting(key, value);
  };

  /* Derived effect of a setting, so a value can be judged before racing.
   * These are the same formulas the physics uses, so they stay honest. */
  Game.prototype.describeSetting = function (key, value) {
    var cfg = this.cfg;
    switch (key) {
      case 'turningAngleDeg':
        // Sideways speed is what actually moves the car across the road.
        return Math.round(cfg.fullSpeed * Math.sin(value * Math.PI / 180)) + ' px/s across';
      case 'steerRateDeg':
        // Saturates: the car stops turning at the Turning Angle.
        return 'lock in ' + (cfg.turningAngleDeg / value).toFixed(3) + 's';
      case 'returnRateDeg':
        // Proportional return: half the angle back in (45/R) * ln2 seconds.
        return 'half back ' + ((45 / value) * Math.LN2).toFixed(2) + 's';
      case 'fullSpeed':
        return Math.round(cfg.fullSpeed * Math.sin(cfg.turningAngleDeg * Math.PI / 180))
             + ' px/s across';
      case 'lanes':
        return cfg.roadWidth + 'px road';
      case 'slideDistance':
        // Expressed in lanes, which is what it costs you on track.
        if (value === 0) return 'no slide';
        return (value / cfg.laneWidth).toFixed(1) + ' lanes wide';
      case 'aiCars':
        // How much road the grid occupies, which is what the number means on
        // track: 100 cars is a field stretching well up the first straight.
        var rows = Math.ceil(value / cfg.gridPerRow);
        return (cfg.gridStartGap + (rows - 1) * cfg.gridRowSpacing) + 'px of grid';
      case 'grassSlowdownPct':
        // What the penalty actually leaves you with, in the same units as the
        // in-race speed readout.
        return Math.round((cfg.fullSpeed * (1 - value / 100) / cfg.pixelsPerMetre) * 3.6)
             + ' km/h on grass';
      default:
        return '';
    }
  };

  Game.prototype.formatSetting = function (key, value) {
    if (key === 'turningAngleDeg') return value + '°';
    if (key === 'accelerationTime') return Number(value).toFixed(1) + 's';
    if (key === 'fullSpeed') return value + ' px/s';
    if (key === 'steerRateDeg' || key === 'returnRateDeg') return value + '\u00B0/s';
    if (key === 'grassSlowdownPct') return value + '%';
    if (key === 'slideDistance') return value + 'px';
    return String(value);
  };

  Game.prototype.readForm = function () {
    var fields = this.formFields();
    var values = {};
    Object.keys(fields).forEach(function (key) {
      if (fields[key]) values[key] = fields[key].value;
    });
    return values;
  };

  Game.prototype.updateSummary = function () {
    if (!this.dom.summary) return;
    var qual = this.track ? this.track.qualifyingTime * this.cfg.laps
                          : BR.DEFAULT_CONFIG.track.qualifyingTime * this.cfg.laps;
    this.dom.summary.textContent =
      (this.track ? this.track.name : 'Track 1') +
      ' — qualifying ' + qual.toFixed(2) + 's' +
      (this.cfg.laps > 1 ? ' over ' + this.cfg.laps + ' laps' : '');
  };

  Game.prototype.bindUI = function () {
    var self = this;
    var fields = this.formFields();

    Object.keys(fields).forEach(function (key) {
      var el = fields[key];
      if (!el) return;
      el.addEventListener('input', function () {
        var value = BR.settings.clampValue(key, el.value);
        self.cfg[key] = value;
        // Keep the derived values in step. Without this the live config is
        // inconsistent while the title screen is open — Grass Slowdown would
        // read 75% with offRoadSpeedFactor still at 0.5 — and only came right
        // because startRace() reloads the settings from scratch.
        BR.deriveConfig(self.cfg);
        self.renderValue(key, el, value);
        // Turning Angle and Full Speed feed each other's derived readouts.
        if (key === 'turningAngleDeg' || key === 'fullSpeed' || key === 'lanes') {
          ['turningAngleDeg', 'steerRateDeg', 'fullSpeed', 'grassSlowdownPct',
           'lanes', 'aiCars', 'slideDistance'].forEach(function (other) {
            var oel = fields[other];
            if (oel && other !== key) self.renderValue(other, oel, self.cfg[other]);
          });
        }
        self.updateSummary();
      });
    });

    this.dom.start.addEventListener('click', function () { self.startRace(); });
    this.dom.again.addEventListener('click', function () { self.startRace(); });
    this.dom.menu.addEventListener('click', function () { self.setPhase('title'); });

    this.dom.reset.addEventListener('click', function () {
      self.cfg = BR.settings.reset();
      self.buildWorld();
      self.syncFormFromConfig();
    });
  };

  // -------------------------------------------------------------- phases --

  Game.prototype.setPhase = function (phase) {
    this.phase = phase;
    this.dom.title.classList.toggle('hidden', phase !== 'title');
    this.dom.result.classList.toggle('hidden', phase !== 'finished');
    this.dom.pause.classList.toggle('hidden', phase !== 'paused');
    if (phase === 'title') this.syncFormFromConfig();
  };

  Game.prototype.startRace = function () {
    // Persist whatever the title screen is showing, then rebuild from it.
    this.cfg = BR.settings.save(this.readForm());
    this.buildWorld();
    this.keys.left = this.keys.right = false;
    if (this.releaseTouch) this.releaseTouch();
    this.setPhase('countdown');
  };

  Game.prototype.finish = function () {
    var qualTotal = this.track.qualifyingTime * this.cfg.laps;
    var qualified = this.elapsed <= qualTotal;
    var delta = this.elapsed - qualTotal;

    this.dom.resultHead.textContent = qualified ? 'QUALIFIED' : 'TOO SLOW';
    this.dom.resultHead.className = qualified ? 'result-good' : 'result-bad';
    this.dom.resultBody.innerHTML =
      '<strong>' + BR.hud.formatTime(this.elapsed) + '</strong>' +
      ' vs qualifying ' + BR.hud.formatTime(qualTotal) +
      '<br><span class="delta ' + (qualified ? 'result-good' : 'result-bad') + '">' +
      (delta <= 0 ? '−' : '+') + BR.hud.formatTime(Math.abs(delta)) + '</span>';

    this.setPhase('finished');
  };

  // ---------------------------------------------------------------- loop --

  Game.prototype.step = function (dt) {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= -0.6) this.setPhase('racing');
      return;
    }
    if (this.phase !== 'racing') return;

    this.elapsed += dt;
    this.car.update(dt, this.steerInput());
    BR.ai.updateField(this.field, this.track, dt);
    // After both have moved, so contacts are tested against final positions.
    BR.collision.resolve(this.car, this.field, this.cfg);
    if (this.car.bumpFlash > 0) this.car.bumpFlash -= dt;
    if (this.car.scrapeFlash > 0) this.car.scrapeFlash -= dt;
    this.position = BR.ai.playerPosition(this.field, this.car.loc.s);

    if (this.car.hasFinishedLap()) {
      if (this.lap >= this.cfg.laps) { this.finish(); return; }
      this.lap += 1;
      this.car.startNewLap();
      this.field = BR.ai.buildField(this.cfg, this.track);
      BR.collision.reset(this.car, this.field);
      this.renderer.updateCamera(this.car, 0, true);
    }
  };

  Game.prototype.frame = function (now) {
    var self = this;
    if (!this.lastFrame) this.lastFrame = now;
    var frameTime = Math.min(MAX_FRAME, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this.accumulator += frameTime;
    while (this.accumulator >= STEP) {
      this.step(STEP);
      this.accumulator -= STEP;
    }

    var animating = this.phase === 'racing' || this.phase === 'countdown';
    this.renderer.updateCamera(this.car, animating ? frameTime : 0, !animating);
    this.renderer.drawWorld(this.car, this.field);

    if (this.phase !== 'title') {
      BR.hud.draw(this.canvas.getContext('2d'), this.viewport, {
        elapsed: this.elapsed,
        lap: this.lap,
        car: this.car,
        phase: this.phase,
        countdown: this.countdown,
        position: this.position,
        fieldSize: this.field.length
      }, this.cfg, this.track);
    }

    window.requestAnimationFrame(function (t) { self.frame(t); });
  };

  Game.prototype.run = function () {
    var self = this;
    // Show whichever control hint applies to this device.
    var keysHint = document.getElementById('controls-keys');
    var touchHint = document.getElementById('controls-touch');
    if (keysHint && touchHint && this.viewport.touch) {
      keysHint.classList.add('hidden');
      touchHint.classList.remove('hidden');
    }
    this.setPhase('title');
    window.requestAnimationFrame(function (t) { self.frame(t); });
  };

  BR.Game = Game;

  window.addEventListener('DOMContentLoaded', function () {
    var canvas = document.getElementById('game');
    var game = new BR.Game(canvas);
    // Exposed so tools/browser-test.js (and the console) can inspect the race.
    window.__game = game;
    game.run();
  });
})(window.BR);
