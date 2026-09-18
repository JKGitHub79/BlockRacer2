/* Settings: merges the config file with any title-screen overrides the player
 * has saved in this browser. The file is always the source of truth for
 * anything the title screen does not expose. */
(function (BR) {
  'use strict';

  var STORAGE_KEY = 'blockracer2.settings.v1';

  // Only these may be overridden from the title screen.
  var OVERRIDABLE = ['turningAngleDeg', 'accelerationTime', 'laps', 'fullSpeed',
                     'steerRateDeg', 'returnRateDeg'];

  function clampValue(key, value) {
    var lim = BR.CONFIG_LIMITS[key];
    var n = Number(value);
    if (!isFinite(n)) return BR.DEFAULT_CONFIG[key];
    if (!lim) return n;
    n = Math.min(lim.max, Math.max(lim.min, n));
    if (lim.step >= 1) n = Math.round(n);
    return n;
  }

  function readOverrides() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      var out = {};
      OVERRIDABLE.forEach(function (key) {
        if (parsed && parsed[key] !== undefined) out[key] = clampValue(key, parsed[key]);
      });
      return out;
    } catch (err) {
      return {}; // private browsing, corrupt JSON — fall back to the file
    }
  }

  function writeOverrides(overrides) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch (err) {
      /* storage unavailable: settings still apply for this session */
    }
  }

  /* Returns a fresh, fully-resolved config object. */
  function load() {
    var cfg = {};
    Object.keys(BR.DEFAULT_CONFIG).forEach(function (key) {
      cfg[key] = BR.DEFAULT_CONFIG[key];
    });
    // Every value from the file is clamped too, so a bad hand-edit cannot
    // produce an unplayable game.
    OVERRIDABLE.forEach(function (key) { cfg[key] = clampValue(key, cfg[key]); });

    var overrides = readOverrides();
    Object.keys(overrides).forEach(function (key) { cfg[key] = overrides[key]; });

    cfg.roadWidth = cfg.carWidth * cfg.roadWidthInCars;
    return cfg;
  }

  function save(values) {
    var overrides = {};
    OVERRIDABLE.forEach(function (key) {
      if (values[key] !== undefined) overrides[key] = clampValue(key, values[key]);
    });
    writeOverrides(overrides);
    return load();
  }

  function reset() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
    return load();
  }

  BR.settings = {
    OVERRIDABLE: OVERRIDABLE,
    clampValue: clampValue,
    load: load,
    save: save,
    reset: reset
  };
})(window.BR);
