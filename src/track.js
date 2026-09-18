/* Track: turns the timed section list from the config file into a sampled
 * centreline, and answers the two questions the game asks every frame —
 * "how far along the track am I?" and "which way is the road pointing here?" */
(function (BR) {
  'use strict';

  var SAMPLE_SPACING = 5; // world pixels between centreline samples

  function build(cfg) {
    var def = cfg.track;
    var pts = [];
    var x = 0, y = 0;
    var h = -Math.PI / 2;   // canvas y grows downwards, so -90deg points up-screen
    var s = 0;

    pts.push({ x: x, y: y, h: h, s: s });

    def.segments.forEach(function (seg) {
      var length = seg.seconds * cfg.fullSpeed;
      var steps = Math.max(2, Math.ceil(length / SAMPLE_SPACING));
      var d = length / steps;
      var dh = seg.type === 'turn' ? (seg.dir * seg.degrees * Math.PI / 180) / steps : 0;

      for (var i = 0; i < steps; i++) {
        // Rotate half a step, advance, rotate the other half. This midpoint
        // integration keeps arcs from drifting outwards.
        h += dh / 2;
        x += Math.cos(h) * d;
        y += Math.sin(h) * d;
        h += dh / 2;
        s += d;
        pts.push({ x: x, y: y, h: h, s: s });
      }
    });

    var last = pts[pts.length - 1];

    return {
      name: def.name,
      qualifyingTime: def.qualifyingTime,
      points: pts,
      length: last.s,
      halfWidth: cfg.roadWidth / 2,
      start: pts[0],
      finish: last
    };
  }

  /* Nearest point on the centreline, searched in a window around `hint` so a
   * car that doubles back cannot teleport to a far-away part of the track. */
  function locate(track, px, py, hint) {
    var pts = track.points;
    var lo = Math.max(0, (hint | 0) - 60);
    var hi = Math.min(pts.length - 1, (hint | 0) + 240);

    var bestIndex = lo;
    var bestDist = Infinity;
    for (var i = lo; i <= hi; i++) {
      var dx = px - pts[i].x;
      var dy = py - pts[i].y;
      var d2 = dx * dx + dy * dy;
      if (d2 < bestDist) { bestDist = d2; bestIndex = i; }
    }

    var p = pts[bestIndex];

    // Project onto the neighbouring segment so `s` and the lateral offset move
    // smoothly rather than in 5px jumps.
    var neighbour = pts[bestIndex + 1] || pts[bestIndex - 1] || p;
    var ex = neighbour.x - p.x;
    var ey = neighbour.y - p.y;
    var elen = Math.hypot(ex, ey) || 1;
    ex /= elen; ey /= elen;
    if (!pts[bestIndex + 1]) { ex = -ex; ey = -ey; }

    var along = (px - p.x) * ex + (py - p.y) * ey;
    along = Math.max(-SAMPLE_SPACING, Math.min(SAMPLE_SPACING, along));

    // Positive lateral = to the right of the direction of travel.
    var lateral = -(px - p.x) * ey + (py - p.y) * ex;

    return {
      index: bestIndex,
      s: Math.max(0, Math.min(track.length, p.s + along)),
      heading: p.h,
      lateral: lateral,
      x: p.x,
      y: p.y
    };
  }

  /* Point + heading at a given distance along the track. Used to place the car
   * on the grid and at the start of each new lap. */
  function at(track, s) {
    var pts = track.points;
    var i = Math.max(0, Math.min(pts.length - 1, Math.round(s / SAMPLE_SPACING)));
    return pts[i];
  }

  BR.track = { build: build, locate: locate, at: at, SAMPLE_SPACING: SAMPLE_SPACING };
})(window.BR);
