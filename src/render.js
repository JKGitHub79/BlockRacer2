/* Rendering: a top-down view that scrolls with the car. The camera translates
 * but never rotates, so corners read as corners rather than as the world
 * spinning around a static car. */
(function (BR) {
  'use strict';

  var COLOURS = {
    grass:      '#3f7a34',
    grassDark:  '#376d2d',
    verge:      '#e8e4d6',
    asphalt:    '#4a4a52',
    asphaltEdge:'#ffffff',
    laneLine:   '#f2d94e',
    carBody:    '#e03b3b',
    carRoof:    '#2b2b33',
    carGlass:   '#8fd0ee'
  };

  function makeGrassPattern(ctx) {
    var size = 128;
    var tile = document.createElement('canvas');
    tile.width = tile.height = size;
    var t = tile.getContext('2d');

    t.fillStyle = COLOURS.grass;
    t.fillRect(0, 0, size, size);

    // Deterministic scatter so the grass never shimmers between frames.
    var seed = 1337;
    function rand() {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }
    t.fillStyle = COLOURS.grassDark;
    for (var i = 0; i < 90; i++) {
      var x = rand() * size;
      var y = rand() * size;
      var w = 2 + rand() * 5;
      t.fillRect(x, y, w, 1 + rand() * 2);
    }
    return ctx.createPattern(tile, 'repeat');
  }

  function Renderer(canvas, cfg, track, viewport) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    this.track = track;
    this.viewport = viewport;
    this.grass = makeGrassPattern(this.ctx);
    this.camera = { x: track.start.x, y: track.start.y };
  }

  Renderer.prototype.updateCamera = function (car, dt, snap) {
    var cfg = this.cfg;
    var vp = this.viewport;

    // Look-ahead is taken PER AXIS, each as a fraction of however much world
    // that axis can see. This keeps the car in the same place on screen on
    // every display (at most 2 x lookAhead of the half-extent from centre,
    // whatever the resolution) while a tall portrait phone still gets to use
    // its height: 38% of 1298 visible world px is far more road ahead than 38%
    // of a desktop's 600. A single distance along the heading does neither —
    // fixed, it wasted half a portrait screen on empty road behind; scaled by
    // the combined extent, a diagonal heading shoved the car off the side.
    var frac = car.speed / cfg.fullSpeed;
    var tx = car.x + Math.cos(car.heading) * cfg.lookAhead * vp.worldWidth() * frac;
    var ty = car.y + Math.sin(car.heading) * cfg.lookAhead * vp.worldHeight() * frac;

    if (snap) {
      this.camera.x = tx;
      this.camera.y = ty;
      return;
    }
    // Critically-damped-ish follow, frame-rate independent.
    var k = 1 - Math.exp(-8 * dt);
    this.camera.x += (tx - this.camera.x) * k;
    this.camera.y += (ty - this.camera.y) * k;
  };

  /* Index range of centreline samples that could touch the viewport. */
  Renderer.prototype.visibleRange = function () {
    var pts = this.track.points;
    var margin = this.track.halfWidth + 80;
    var halfW = this.viewport.worldWidth() / 2;
    var halfH = this.viewport.worldHeight() / 2;
    var left = this.camera.x - halfW - margin;
    var right = this.camera.x + halfW + margin;
    var top = this.camera.y - halfH - margin;
    var bottom = this.camera.y + halfH + margin;

    var first = -1, last = -1;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) {
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first === -1) return null;
    // Extend by one sample each way so the stroke runs off-screen cleanly.
    return { from: Math.max(0, first - 2), to: Math.min(pts.length - 1, last + 2) };
  };

  Renderer.prototype.tracePath = function (range) {
    var ctx = this.ctx;
    var pts = this.track.points;
    ctx.beginPath();
    ctx.moveTo(pts[range.from].x, pts[range.from].y);
    for (var i = range.from + 1; i <= range.to; i++) ctx.lineTo(pts[i].x, pts[i].y);
  };

  /* The centreline shifted sideways by `offset` px (positive = to the right of
   * the direction of travel). Used for the lane dividers. Safe because the
   * offsets are far smaller than the 214px corner radius, so the shifted path
   * cannot fold back on itself. */
  Renderer.prototype.traceOffsetPath = function (range, offset) {
    var ctx = this.ctx;
    var pts = this.track.points;
    ctx.beginPath();
    for (var i = range.from; i <= range.to; i++) {
      var p = pts[i];
      var x = p.x - Math.sin(p.h) * offset;
      var y = p.y + Math.cos(p.h) * offset;
      if (i === range.from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  };

  /* A checkered band laid across the road at distance `s`. */
  Renderer.prototype.drawLine = function (point, checkered) {
    var ctx = this.ctx;
    var hw = this.track.halfWidth;
    var depth = 22;

    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(point.h);

    if (checkered) {
      var cols = 10;
      var cell = (hw * 2) / cols;
      for (var c = 0; c < cols; c++) {
        for (var r = 0; r < 2; r++) {
          ctx.fillStyle = ((c + r) % 2 === 0) ? '#ffffff' : '#1b1b20';
          ctx.fillRect(-depth / 2 + r * (depth / 2), -hw + c * cell, depth / 2, cell);
        }
      }
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-4, -hw, 8, hw * 2);
    }
    ctx.restore();
  };

  Renderer.prototype.drawCar = function (car) {
    var ctx = this.ctx;
    var L = this.cfg.carLength;
    var W = this.cfg.carWidth;

    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.heading);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(-L / 2 + 3, -W / 2 + 4, L, W);

    // Body
    ctx.fillStyle = COLOURS.carBody;
    ctx.fillRect(-L / 2, -W / 2, L, W);

    // Wheels
    ctx.fillStyle = '#1b1b20';
    ctx.fillRect(-L / 2 + 5, -W / 2 - 3, 12, 5);
    ctx.fillRect(-L / 2 + 5, W / 2 - 2, 12, 5);
    ctx.fillRect(L / 2 - 17, -W / 2 - 3, 12, 5);
    ctx.fillRect(L / 2 - 17, W / 2 - 2, 12, 5);

    // Roof + windscreen (nose points along +x)
    ctx.fillStyle = COLOURS.carRoof;
    ctx.fillRect(-L / 2 + 14, -W / 2 + 4, L * 0.42, W - 8);
    ctx.fillStyle = COLOURS.carGlass;
    ctx.fillRect(-L / 2 + 14 + L * 0.42, -W / 2 + 5, 6, W - 10);

    ctx.restore();
  };

  Renderer.prototype.drawWorld = function (car) {
    var ctx = this.ctx;
    var vp = this.viewport;

    // Work in CSS pixels; the device pixel ratio is folded into the transform
    // so nothing else in the renderer has to know about it.
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    ctx.clearRect(0, 0, vp.w, vp.h);

    // World transform: centre on the camera, then scale world units to screen.
    ctx.save();
    ctx.translate(vp.w / 2, vp.h / 2);
    ctx.scale(vp.scale, vp.scale);
    ctx.translate(-this.camera.x, -this.camera.y);

    // Grass over the visible world rect. The pattern lives in world space, so
    // it scrolls with the camera and scales with everything else.
    var ww = vp.worldWidth();
    var wh = vp.worldHeight();
    ctx.fillStyle = this.grass;
    ctx.fillRect(this.camera.x - ww / 2, this.camera.y - wh / 2, ww, wh);

    var range = this.visibleRange();
    if (range) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Verge, then asphalt, then the white edge lines fall out as the gap.
      this.tracePath(range);
      ctx.strokeStyle = COLOURS.verge;
      ctx.lineWidth = this.track.halfWidth * 2 + 10;
      ctx.stroke();

      this.tracePath(range);
      ctx.strokeStyle = COLOURS.asphaltEdge;
      ctx.lineWidth = this.track.halfWidth * 2;
      ctx.stroke();

      this.tracePath(range);
      ctx.strokeStyle = COLOURS.asphalt;
      ctx.lineWidth = this.track.halfWidth * 2 - 8;
      ctx.stroke();

      // Dashed lane dividers. A road of `lanes` lanes needs lanes-1 dividers,
      // evenly spaced across the width.
      var lanes = this.cfg.lanes || 2;
      ctx.setLineDash([26, 26]);
      ctx.strokeStyle = COLOURS.laneLine;
      ctx.lineWidth = 3;
      for (var n = 1; n < lanes; n++) {
        var offset = (n / lanes - 0.5) * this.track.halfWidth * 2;
        this.traceOffsetPath(range, offset);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    this.drawLine(this.track.start, false);
    this.drawLine(this.track.finish, true);
    this.drawCar(car);

    ctx.restore();
  };

  BR.Renderer = Renderer;
  BR.COLOURS = COLOURS;
})(window.BR);
