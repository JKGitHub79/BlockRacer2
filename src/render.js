/* Rendering: a top-down view that scrolls with the car. The camera translates
 * but never rotates, so corners read as corners rather than as the world
 * spinning around a static car. */
(function (BR) {
  'use strict';

  var COLOURS = {
    grass:       '#3f7a34',
    grassDark:   '#31652a',
    grassLight:  '#4e9240',
    grassPatchA: '#3c7632',
    grassPatchB: '#427e38',
    verge:      '#e8e4d6',
    asphalt:     '#4a4a52',
    asphaltDark: '#42424b',
    asphaltLight:'#54545d',
    asphaltEdge:'#ffffff',
    laneLine:   '#f2d94e',
    carBody:    '#e03b3b',
    carRoof:    '#2b2b33',
    carGlass:   '#8fd0ee',
    markerPost:  '#f4f1e8',
    markerBandA: '#d8433c',
    markerBandB: '#2f3440'
  };

  /* The grass covers most of the screen, so it is the main source of optic
   * flow — the visual evidence that the car is moving at all. The first
   * version scattered a few marks of #376d2d on #3f7a34, a ~5% difference that
   * simply vanished at speed: measured on a straight at full speed, only 3% of
   * pixels changed from frame to frame and the road read as static.
   *
   * The tufts do the work here: numerous, small and genuinely contrasty. The
   * patches underneath only break up flat colour, so they are kept close to
   * the base tone — at higher contrast they read as circular blobs rather than
   * as ground. The texture is deliberately isotropic: banding gives no cue
   * when travelling along the bands, and this track runs in every direction. */
  function makeGrassPattern(ctx) {
    var size = 384;
    var tile = document.createElement('canvas');
    tile.width = tile.height = size;
    var t = tile.getContext('2d');

    // Deterministic, so the grass never shimmers between frames.
    var seed = 1337;
    function rand() {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }

    /* Draws the same shape at all nine wrap offsets, so anything overlapping
     * an edge continues on the opposite side and the tile joins seamlessly.
     * Without this the marks are clipped at the edges and the repeat shows up
     * as a visible grid. Tile generation happens once, so the cost is free. */
    function wrapped(fn) {
      for (var ox = -1; ox <= 1; ox++) {
        for (var oy = -1; oy <= 1; oy++) fn(ox * size, oy * size);
      }
    }

    t.fillStyle = COLOURS.grass;
    t.fillRect(0, 0, size, size);

    var patches = [COLOURS.grassPatchA, COLOURS.grassPatchB];
    for (var p = 0; p < 18; p++) {
      var px = rand() * size, py = rand() * size;
      var rx = 55 + rand() * 80, ry = 45 + rand() * 70, rot = rand() * Math.PI;
      t.fillStyle = patches[p % patches.length];
      wrapped(function (dx, dy) {
        t.beginPath();
        t.ellipse(px + dx, py + dy, rx, ry, rot, 0, Math.PI * 2);
        t.fill();
      });
    }

    var tones = [COLOURS.grassDark, COLOURS.grassDark, COLOURS.grassLight];
    for (var i = 0; i < 1100; i++) {
      var x = rand() * size, y = rand() * size;
      var w = 3 + rand() * 7, h = 2 + rand() * 4;
      var tuft = rand() > 0.6;
      t.fillStyle = tones[i % tones.length];
      wrapped(function (dx, dy) {
        t.fillRect(x + dx, y + dy, w, h);
        if (tuft) t.fillRect(x + dx + w * 0.3, y + dy - h, w * 0.5, h);
      });
    }

    return ctx.createPattern(tile, 'repeat');
  }

  /* Asphalt speckle. The road sits in the middle of the screen — exactly where
   * the player is looking — and as flat colour it contributed no motion at all;
   * only the lane dashes moved. Kept low contrast so it reads as surface
   * grain rather than noise. Used as a stroke style, so it follows the road. */
  function makeAsphaltPattern(ctx) {
    var size = 192;
    var tile = document.createElement('canvas');
    tile.width = tile.height = size;
    var t = tile.getContext('2d');

    var seed = 991;
    function rand() {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }
    function wrapped(fn) {
      for (var ox = -1; ox <= 1; ox++) {
        for (var oy = -1; oy <= 1; oy++) fn(ox * size, oy * size);
      }
    }

    t.fillStyle = COLOURS.asphalt;
    t.fillRect(0, 0, size, size);

    var tones = [COLOURS.asphaltDark, COLOURS.asphaltLight, COLOURS.asphaltLight];
    for (var i = 0; i < 520; i++) {
      var x = rand() * size, y = rand() * size;
      var w = 2 + rand() * 6, h = 2 + rand() * 4;
      t.fillStyle = tones[i % tones.length];
      wrapped(function (dx, dy) { t.fillRect(x + dx, y + dy, w, h); });
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
    this.asphalt = makeAsphaltPattern(this.ctx);
    this.camera = { x: track.start.x, y: track.start.y };
    this.markers = buildMarkers(cfg, track);
  }

  /* Evenly spaced posts down both verges. Periodic, high contrast and right at
   * the edge of the road where the player is already looking, so they read as
   * speed far better than the texture alone — and unlike the continuous white
   * edge line, a post that flicks past is unambiguous evidence of motion. */
  function buildMarkers(cfg, track) {
    var spacing = cfg.markerSpacing || 120;
    var out = [];
    var pts = track.points;
    var next = spacing;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.s < next) continue;
      next += spacing;
      var nx = -Math.sin(p.h), ny = Math.cos(p.h);   // unit normal, to the right
      var d = track.halfWidth + 17;
      out.push({
        lx: p.x - nx * d, ly: p.y - ny * d,
        rx: p.x + nx * d, ry: p.y + ny * d,
        h: p.h,
        alt: out.length % 2 === 0
      });
    }
    return out;
  }

  Renderer.prototype.updateCamera = function (car, dt, snap) {
    var cfg = this.cfg;
    var vp = this.viewport;

    // Pull the camera back as the car speeds up. Standing still the view is at
    // its tightest; at Full Speed it has widened by speedZoom. Acceleration
    // then reads as the world opening out, which a fixed camera cannot convey
    // at all — without it, 33% and 100% speed look identical bar how fast
    // things slide past.
    vp.setSpeedZoom(car.speed / cfg.fullSpeed, cfg.speedZoom);

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

  Renderer.prototype.drawMarkers = function () {
    var ctx = this.ctx;
    var vp = this.viewport;
    var pad = 40;
    var left = this.camera.x - vp.worldWidth() / 2 - pad;
    var right = this.camera.x + vp.worldWidth() / 2 + pad;
    var top = this.camera.y - vp.worldHeight() / 2 - pad;
    var bottom = this.camera.y + vp.worldHeight() / 2 + pad;

    var W = 7, L = 16;
    for (var i = 0; i < this.markers.length; i++) {
      var m = this.markers[i];
      for (var side = 0; side < 2; side++) {
        var x = side ? m.rx : m.lx;
        var y = side ? m.ry : m.ly;
        if (x < left || x > right || y < top || y > bottom) continue;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(m.h);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(-L / 2 + 2, -W / 2 + 3, L, W);
        ctx.fillStyle = COLOURS.markerPost;
        ctx.fillRect(-L / 2, -W / 2, L, W);
        // Alternating band, so consecutive posts differ as well as recur.
        ctx.fillStyle = m.alt ? COLOURS.markerBandA : COLOURS.markerBandB;
        ctx.fillRect(-L / 2, -W / 2, L * 0.38, W);
        ctx.restore();
      }
    }
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
    ctx.scale(vp.effectiveScale(), vp.effectiveScale());
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
      ctx.strokeStyle = this.asphalt;
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

    this.drawMarkers();
    this.drawLine(this.track.start, false);
    this.drawLine(this.track.finish, true);
    this.drawCar(car);

    ctx.restore();
  };

  BR.Renderer = Renderer;
  BR.COLOURS = COLOURS;
})(window.BR);
