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

    this.buildWorld();
    this.bindInput();
    this.bindUI();
    this.syncFormFromConfig();
  }

  /* (Re)create the track, car and renderer from the current config. */
  Game.prototype.buildWorld = function () {
    this.track = BR.track.build(this.cfg);
    this.car = new BR.Car(this.cfg, this.track);
    this.renderer = new BR.Renderer(this.canvas, this.cfg, this.track);
    this.renderer.updateCamera(this.car, 0, true);
    this.elapsed = 0;
    this.lap = 1;
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
      if (self.phase === 'racing') self.setPhase('paused');
    });
  };

  Game.prototype.steerInput = function () {
    if (this.keys.left && !this.keys.right) return -1;
    if (this.keys.right && !this.keys.left) return 1;
    return 0;
  };

  // ------------------------------------------------------------------- UI --

  Game.prototype.formFields = function () {
    return {
      turningAngleDeg:  document.getElementById('cfg-turning-angle'),
      accelerationTime: document.getElementById('cfg-acceleration'),
      laps:             document.getElementById('cfg-laps'),
      fullSpeed:        document.getElementById('cfg-full-speed')
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
      var out = document.getElementById(el.id + '-value');
      if (out) out.textContent = self.formatSetting(key, self.cfg[key]);
    });
    this.updateSummary();
  };

  Game.prototype.formatSetting = function (key, value) {
    if (key === 'turningAngleDeg') return value + '°';
    if (key === 'accelerationTime') return Number(value).toFixed(1) + 's';
    if (key === 'fullSpeed') return value + ' px/s';
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
        var out = document.getElementById(el.id + '-value');
        if (out) out.textContent = self.formatSetting(key, value);
        self.cfg[key] = value;
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

    if (this.car.hasFinishedLap()) {
      if (this.lap >= this.cfg.laps) { this.finish(); return; }
      this.lap += 1;
      this.car.startNewLap();
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
    this.renderer.drawWorld(this.car);

    if (this.phase !== 'title') {
      BR.hud.draw(this.canvas.getContext('2d'), this.canvas, {
        elapsed: this.elapsed,
        lap: this.lap,
        car: this.car,
        phase: this.phase,
        countdown: this.countdown
      }, this.cfg, this.track);
    }

    window.requestAnimationFrame(function (t) { self.frame(t); });
  };

  Game.prototype.run = function () {
    var self = this;
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
