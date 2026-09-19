/* HUD: drawn on the canvas above the world, in CSS pixels.
 *
 * Every size here is derived from view.ui (which tracks the shorter screen
 * axis) and every panel width is capped against the actual screen width, so
 * the layout holds from a narrow phone up to a desktop without overlapping. */
(function (BR) {
  'use strict';

  function formatTime(seconds) {
    if (seconds < 0) seconds = 0;
    var whole = Math.floor(seconds);
    var hundredths = Math.floor((seconds - whole) * 100);
    return whole + '.' + (hundredths < 10 ? '0' : '') + hundredths + 's';
  }

  function panel(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(12,14,20,0.62)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function font(size, bold) {
    return (bold ? 'bold ' : '') + Math.round(size) + 'px "Segoe UI", Arial, sans-serif';
  }

  /* Faint steering zones, shown only on touch screens so the player can see
   * that the left and right halves of the display are the controls. */
  function drawTouchZones(ctx, view) {
    var u = view.ui;
    var midY = view.h * 0.5;
    var inset = 16 * u;
    var size = 20 * u;

    ctx.save();
    ctx.globalAlpha = 0.20;
    ctx.fillStyle = '#ffffff';
    [-1, 1].forEach(function (dir) {
      var x = dir < 0 ? inset : view.w - inset;
      ctx.beginPath();
      ctx.moveTo(x + dir * -size * 0.5, midY);
      ctx.lineTo(x + dir * size * 0.5, midY - size * 0.7);
      ctx.lineTo(x + dir * size * 0.5, midY + size * 0.7);
      ctx.closePath();
      ctx.fill();
    });
    ctx.restore();
  }

  function draw(ctx, view, state, cfg, track) {
    var u = view.ui;
    var pad = Math.round(10 * u);

    ctx.textBaseline = 'top';

    if (view.touch && state.phase === 'racing') drawTouchZones(ctx, view);

    var qualTotal = track.qualifyingTime * cfg.laps;
    var ahead = state.elapsed <= qualTotal;

    // --- Timer, top right (current time vs qualifying time) ---------------
    var w = Math.min(Math.round(215 * u), view.w - pad * 2);
    var h = Math.round(74 * u);
    var x = view.w - w - pad;
    var y = pad;

    panel(ctx, x, y, w, h);

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = font(11 * u);
    ctx.textAlign = 'left';
    ctx.fillText('TIME', x + 11 * u, y + 8 * u);
    ctx.textAlign = 'right';
    ctx.fillText('QUALIFYING', x + w - 11 * u, y + 8 * u);

    ctx.font = font(26 * u, true);
    ctx.fillStyle = ahead ? '#7ef2a6' : '#ff7676';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(state.elapsed), x + 11 * u, y + 22 * u);

    ctx.font = font(15 * u, true);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(qualTotal), x + w - 11 * u, y + 32 * u);

    // Progress against the qualifying pace.
    var frac = Math.max(0, Math.min(1, state.elapsed / qualTotal));
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x + 11 * u, y + h - 15 * u, w - 22 * u, 6 * u);
    ctx.fillStyle = ahead ? '#7ef2a6' : '#ff7676';
    ctx.fillRect(x + 11 * u, y + h - 15 * u, (w - 22 * u) * frac, 6 * u);

    // --- Position, then lap counter --------------------------------------
    var stackY = y + h + 8 * u;
    var rowH = Math.round(28 * u);

    if (state.fieldSize > 0) {
      panel(ctx, x, stackY, w, rowH);
      ctx.textAlign = 'left';
      ctx.font = font(11 * u);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText('POSITION', x + 11 * u, stackY + 8 * u);
      ctx.textAlign = 'right';
      ctx.font = font(15 * u, true);
      // Leading is worth calling out; everything else is just a number.
      ctx.fillStyle = state.position === 1 ? '#7ef2a6' : '#ffffff';
      ctx.fillText(state.position + ' / ' + (state.fieldSize + 1),
                   x + w - 11 * u, stackY + 6 * u);
      stackY += rowH + 6 * u;
    }

    if (cfg.laps > 1) {
      panel(ctx, x, stackY, w, rowH);
      ctx.textAlign = 'left';
      ctx.font = font(11 * u);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText('LAP', x + 11 * u, stackY + 8 * u);
      ctx.textAlign = 'right';
      ctx.font = font(15 * u, true);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(Math.min(state.lap, cfg.laps) + ' / ' + cfg.laps,
                   x + w - 11 * u, stackY + 6 * u);
    }

    // --- Bottom panels: speed (left) and steering angle (right) -----------
    // Split the width between them so they can never overlap.
    var bw = Math.min(Math.round(190 * u), Math.floor((view.w - pad * 3) / 2));
    var bh = Math.round(44 * u);
    var by = view.h - bh - pad;

    panel(ctx, pad, by, bw, bh);
    ctx.textAlign = 'left';
    ctx.font = font(11 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('SPEED', pad + 11 * u, by + 7 * u);
    // An actual speed, not just a percentage of an abstract maximum.
    var kph = (state.car.speed / cfg.pixelsPerMetre) * 3.6;
    ctx.textAlign = 'right';
    ctx.font = font(16 * u, true);
    ctx.fillStyle = state.car.offRoad ? '#ffcf5c' : '#ffffff';
    ctx.fillText(Math.round(kph) + ' km/h', pad + bw - 11 * u, by + 3 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(pad + 11 * u, by + bh - 15 * u, bw - 22 * u, 7 * u);
    ctx.fillStyle = state.car.offRoad ? '#ffcf5c' : '#7ec8f2';
    ctx.fillRect(pad + 11 * u, by + bh - 15 * u,
                 (bw - 22 * u) * Math.min(1, state.car.speed / cfg.fullSpeed), 7 * u);

    var gx = view.w - bw - pad;
    panel(ctx, gx, by, bw, bh);
    ctx.textAlign = 'left';
    ctx.font = font(11 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(view.w < 420 ? 'ANGLE' : 'ANGLE TO ROAD', gx + 11 * u, by + 7 * u);

    var deg = (state.car.steerOffset || 0) * 180 / Math.PI;
    ctx.textAlign = 'right';
    ctx.font = font(14 * u, true);
    ctx.fillStyle = '#ffffff';
    ctx.fillText((deg >= 0 ? '+' : '') + deg.toFixed(0) + '°', gx + bw - 11 * u, by + 5 * u);

    var mid = gx + bw / 2;
    var half = (bw - 22 * u) / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(gx + 11 * u, by + bh - 15 * u, bw - 22 * u, 7 * u);
    var norm = Math.max(-1, Math.min(1, deg / cfg.turningAngleDeg));
    ctx.fillStyle = '#c9a0ff';
    if (norm >= 0) ctx.fillRect(mid, by + bh - 15 * u, half * norm, 7 * u);
    else ctx.fillRect(mid + half * norm, by + bh - 15 * u, -half * norm, 7 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(mid - 1, by + bh - 18 * u, 2, 13 * u);

    // --- Off-road warning / recovery notice -------------------------------
    if (state.phase === 'racing') {
      ctx.textAlign = 'center';
      ctx.font = font(19 * u, true);
      var noticeY = by - 30 * u;
      if (state.car.bumpFlash > 0) {
        ctx.fillStyle = '#ff8a6b';
        ctx.fillText('CONTACT', view.w / 2, noticeY);
      } else if (state.car.recoverFlash > 0) {
        ctx.fillStyle = '#7ec8f2';
        ctx.fillText('BACK ON TRACK', view.w / 2, noticeY);
      } else if (state.car.offRoad) {
        ctx.fillStyle = '#ffcf5c';
        var secs = Math.max(0, cfg.offRoadResetSeconds - state.car.offRoadTimer);
        ctx.fillText(cfg.offRoadResetSeconds > 0
          ? 'OFF TRACK — ' + secs.toFixed(1) + 's'
          : 'OFF TRACK', view.w / 2, noticeY);
      }
    }

    // --- Countdown --------------------------------------------------------
    if (state.phase === 'countdown') {
      var n = Math.ceil(state.countdown);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font(Math.min(view.w, view.h) * 0.17, true);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(n > 0 ? String(n) : 'GO!', view.w / 2 + 3, view.h / 2 + 3);
      ctx.fillStyle = n > 0 ? '#ffffff' : '#7ef2a6';
      ctx.fillText(n > 0 ? String(n) : 'GO!', view.w / 2, view.h / 2);
      ctx.textBaseline = 'top';
    }

    ctx.textAlign = 'left';
  }

  BR.hud = { draw: draw, formatTime: formatTime };
})(window.BR);
