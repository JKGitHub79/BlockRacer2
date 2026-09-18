/* HUD: drawn on the canvas above the world. */
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

  function draw(ctx, canvas, state, cfg, track) {
    var pad = 14;
    var w = 210;
    var x = canvas.width - w - pad;
    var y = pad;

    var qualTotal = track.qualifyingTime * cfg.laps;
    var ahead = state.elapsed <= qualTotal;

    // --- Timer, top right (current time vs qualifying time) ---------------
    panel(ctx, x, y, w, 78);

    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '11px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('TIME', x + 12, y + 9);
    ctx.textAlign = 'right';
    ctx.fillText('QUALIFYING', x + w - 12, y + 9);

    ctx.font = 'bold 27px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = ahead ? '#7ef2a6' : '#ff7676';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(state.elapsed), x + 12, y + 24);

    ctx.font = 'bold 15px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(qualTotal), x + w - 12, y + 34);

    // Delta bar against the qualifying pace.
    var frac = Math.max(0, Math.min(1, state.elapsed / qualTotal));
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x + 12, y + 60, w - 24, 6);
    ctx.fillStyle = ahead ? '#7ef2a6' : '#ff7676';
    ctx.fillRect(x + 12, y + 60, (w - 24) * frac, 6);

    // --- Lap counter ------------------------------------------------------
    if (cfg.laps > 1) {
      panel(ctx, x, y + 86, w, 30);
      ctx.textAlign = 'left';
      ctx.font = '11px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText('LAP', x + 12, y + 95);
      ctx.textAlign = 'right';
      ctx.font = 'bold 15px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(Math.min(state.lap, cfg.laps) + ' / ' + cfg.laps, x + w - 12, y + 93);
    }

    // --- Speed, bottom left ----------------------------------------------
    var sw = 190, sh = 46;
    var sx = pad, sy = canvas.height - sh - pad;
    panel(ctx, sx, sy, sw, sh);
    ctx.textAlign = 'left';
    ctx.font = '11px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('SPEED', sx + 12, sy + 8);
    ctx.textAlign = 'right';
    ctx.font = 'bold 14px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = state.car.offRoad ? '#ffcf5c' : '#ffffff';
    ctx.fillText(Math.round((state.car.speed / cfg.fullSpeed) * 100) + '%', sx + sw - 12, sy + 6);

    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(sx + 12, sy + 28, sw - 24, 8);
    ctx.fillStyle = state.car.offRoad ? '#ffcf5c' : '#7ec8f2';
    ctx.fillRect(sx + 12, sy + 28, (sw - 24) * Math.min(1, state.car.speed / cfg.fullSpeed), 8);

    // --- Steering angle readout, bottom right -----------------------------
    var gw = 190, gh = 46;
    var gx = canvas.width - gw - pad, gy = canvas.height - gh - pad;
    panel(ctx, gx, gy, gw, gh);
    ctx.textAlign = 'left';
    ctx.font = '11px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('ANGLE TO ROAD', gx + 12, gy + 8);

    var deg = (state.car.steerOffset || 0) * 180 / Math.PI;
    ctx.textAlign = 'right';
    ctx.font = 'bold 14px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText((deg >= 0 ? '+' : '') + deg.toFixed(0) + '°', gx + gw - 12, gy + 6);

    var mid = gx + gw / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(gx + 12, gy + 28, gw - 24, 8);
    var half = (gw - 24) / 2;
    var norm = Math.max(-1, Math.min(1, deg / cfg.turningAngleDeg));
    ctx.fillStyle = '#c9a0ff';
    if (norm >= 0) ctx.fillRect(mid, gy + 28, half * norm, 8);
    else ctx.fillRect(mid + half * norm, gy + 28, -half * norm, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(mid - 1, gy + 25, 2, 14);

    // --- Off-road warning / recovery notice -------------------------------
    if (state.phase === 'racing') {
      ctx.textAlign = 'center';
      ctx.font = 'bold 20px "Segoe UI", Arial, sans-serif';
      if (state.car.recoverFlash > 0) {
        ctx.fillStyle = '#7ec8f2';
        ctx.fillText('BACK ON TRACK', canvas.width / 2, canvas.height - 96);
      } else if (state.car.offRoad) {
        ctx.fillStyle = '#ffcf5c';
        var secs = Math.max(0, cfg.offRoadResetSeconds - state.car.offRoadTimer);
        ctx.fillText(cfg.offRoadResetSeconds > 0
          ? 'OFF TRACK \u2014 ' + secs.toFixed(1) + 's'
          : 'OFF TRACK', canvas.width / 2, canvas.height - 96);
      }
    }

    // --- Countdown / finish banner ---------------------------------------
    if (state.phase === 'countdown') {
      var n = Math.ceil(state.countdown);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 96px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(n > 0 ? String(n) : 'GO!', canvas.width / 2 + 3, canvas.height / 2 + 3);
      ctx.fillStyle = n > 0 ? '#ffffff' : '#7ef2a6';
      ctx.fillText(n > 0 ? String(n) : 'GO!', canvas.width / 2, canvas.height / 2);
      ctx.textBaseline = 'top';
    }

    ctx.textAlign = 'left';
  }

  BR.hud = { draw: draw, formatTime: formatTime };
})(window.BR);
