/* Viewport: owns canvas sizing, device pixel ratio, and the world-to-screen
 * scale.
 *
 * The important decision here is fairness. The game is scored against a
 * qualifying time, so every screen must show the same amount of track — if a
 * phone saw less road ahead than a desktop, the same 22.5s would be a harder
 * target on the phone. So the scale is set from the SHORTER screen axis
 * against a fixed world extent (cfg.viewMinWorld): whatever the display, at
 * least that many world pixels are visible in every direction. Bigger or wider
 * screens see more, never less, and the physics are untouched either way —
 * world units are absolute, so lap times match across devices.
 */
(function (BR) {
  'use strict';

  // Rendering at full density on a 3x phone costs 9x the fill rate for very
  // little visible gain, so the backing store is capped.
  var MAX_DPR = 2;

  function Viewport(canvas, cfg) {
    this.canvas = canvas;
    this.cfg = cfg;
    this.w = 1;
    this.h = 1;
    this.dpr = 1;
    this.scale = 1;
    this.ui = 1;
    this.touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
    this.measure();
  }

  /* Re-reads the canvas's CSS size and resizes its backing store to match.
   * Returns true if anything changed. */
  Viewport.prototype.measure = function () {
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    var changed = (w !== this.w || h !== this.h || dpr !== this.dpr);

    var pxW = Math.max(1, Math.round(w * dpr));
    var pxH = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== pxW) this.canvas.width = pxW;
    if (this.canvas.height !== pxH) this.canvas.height = pxH;

    this.w = w;
    this.h = h;
    this.dpr = dpr;

    var shortAxis = Math.min(w, h);
    this.scale = shortAxis / this.cfg.viewMinWorld;

    // HUD scale. Tied to the short axis too, but clamped: below ~0.6 the
    // timer stops being readable, above ~1.1 it starts dominating the screen.
    this.ui = Math.max(0.6, Math.min(1.1, shortAxis / 600));

    return changed;
  };

  /* Visible world extent, in world units. */
  Viewport.prototype.worldWidth = function () { return this.w / this.scale; };
  Viewport.prototype.worldHeight = function () { return this.h / this.scale; };

  /* True when the screen is meaningfully taller than it is wide, which is
   * where the HUD needs to reflow. */
  Viewport.prototype.isPortrait = function () { return this.h > this.w * 1.15; };

  BR.Viewport = Viewport;
})(window.BR);
