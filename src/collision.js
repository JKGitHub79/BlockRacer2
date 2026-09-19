/* Player <-> AI car collisions.
 *
 * Cars are 56x32 and race in lanes 64px apart, so a circle test would be badly
 * wrong in both directions: it would miss a nose-to-tail shunt and it would
 * fire constantly between cars running safely side by side. This uses a proper
 * separating-axis test on the two oriented boxes, which is exact for
 * rectangles and cheap enough given only the player is tested against the
 * field.
 *
 * The response has two parts:
 *
 *   - A one-off speed drop when a contact BEGINS. The player is knocked back
 *     to roughly the speed of the car hit. A flag on the AI car marks the
 *     contact as counted, so a sustained shunt cannot re-trigger every frame;
 *     it clears when the cars separate, so hitting the same car again later
 *     counts again.
 *
 *   - A positional push plus a speed cap while the contact LASTS, so the
 *     player cannot drive through the car in front. Without the cap the player
 *     would accelerate into the car, penetrate, get shoved back, and jitter;
 *     with it they simply sit at the other car's pace until they steer clear.
 *
 * AI cars are not moved or slowed by the player. Their own behaviour is
 * untouched.
 */
(function (BR) {
  'use strict';

  // Two cars can only overlap if their centres are within the box diagonal.
  var BROAD_PHASE = 70;

  // Cap on how far a single step may push the player, so nothing can teleport
  // even if two cars somehow start deeply overlapped.
  var MAX_PUSH = 6;

  // Separation needed before a contact is considered over and can count again.
  var RELEASE_SLACK = 1.5;

  // Floor on the speed a contact may hold the player to, as a fraction of Full
  // Speed. Belt and braces against a hard lock: whatever it is touching, the
  // player can always creep and steer out rather than being frozen in place.
  var MIN_CONTACT_SPEED_FRACTION = 0.12;

  /* Separating-axis test between two oriented boxes of the same size.
   *
   * Returns a SIGNED depth along the best axis: positive means overlapping by
   * that much, negative means that far apart. Reporting the gap as well as the
   * penetration is what lets contact be held through a frame where the boxes
   * are merely touching, without inflating the penetration used to push the
   * player out — conflating the two made every sustained shunt shove the
   * player backwards a little more each frame until contact broke and
   * immediately re-triggered, eight times over for a single collision. */
  function overlap(a, b, halfLength, halfWidth) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;

    var ca = Math.cos(a.heading), sa = Math.sin(a.heading);
    var cb = Math.cos(b.heading), sb = Math.sin(b.heading);

    // A box's own forward and side axes; four in total for two boxes.
    var axes = [ca, sa, -sa, ca, cb, sb, -sb, cb];

    var bestDepth = Infinity, nx = 0, ny = 0;
    var widestGap = -Infinity;

    for (var i = 0; i < 8; i += 2) {
      var ax = axes[i], ay = axes[i + 1];

      // How far each box extends along this axis.
      var ra = halfLength * Math.abs(ax * ca + ay * sa) +
               halfWidth  * Math.abs(ax * -sa + ay * ca);
      var rb = halfLength * Math.abs(ax * cb + ay * sb) +
               halfWidth  * Math.abs(ax * -sb + ay * cb);

      var centreGap = dx * ax + dy * ay;
      var depth = ra + rb - Math.abs(centreGap);

      if (depth <= 0) {
        // A separating axis. They are apart; the widest gap is the honest
        // measure of by how much.
        if (depth > widestGap) widestGap = depth;
        continue;
      }
      if (depth < bestDepth) {
        bestDepth = depth;
        var sign = centreGap >= 0 ? 1 : -1;
        nx = ax * sign;
        ny = ay * sign;
      }
    }

    if (widestGap > -Infinity) return { depth: widestGap, nx: 0, ny: 0 };
    return { depth: bestDepth, nx: nx, ny: ny };
  }

  /* Run after the player has moved. Returns the number of NEW contacts this
   * step, which is what the HUD flashes on. */
  function resolve(player, field, cfg) {
    var halfLength = cfg.carLength / 2;
    var halfWidth = cfg.carWidth / 2;
    var newHits = 0;
    var limit = Infinity;

    for (var i = 0; i < field.length; i++) {
      var ai = field[i];

      // Cars that have taken the flag are out of the race and coast away; they
      // are not obstacles.
      if (ai.finished) { ai.playerContact = false; continue; }

      var dx = ai.x - player.x;
      var dy = ai.y - player.y;
      if (dx * dx + dy * dy > BROAD_PHASE * BROAD_PHASE) {
        ai.playerContact = false;
        continue;
      }

      var hit = overlap(player, ai, halfLength, halfWidth);

      // Cleanly apart: the contact is over and may count again later.
      if (hit.depth <= -RELEASE_SLACK) {
        ai.playerContact = false;
        continue;
      }

      if (hit.depth > 0) {
        // Push the player clear of the overlap. Only the player moves, and
        // only by the true penetration, so a resting contact is not shoved
        // further apart every frame.
        var push = Math.min(hit.depth, MAX_PUSH);
        player.x -= hit.nx * push;
        player.y -= hit.ny * push;

        if (!ai.playerContact) {
          // Contact begins: knock the player back to roughly this car's pace.
          player.speed = Math.min(player.speed, ai.speed);
          // Hitting something kills the drift; carrying a slide through a
          // collision would shove the player sideways out of the contact.
          player.slideVel = 0;
          player.bumpFlash = 0.7;
          newHits++;
          ai.playerContact = true;
        }
      } else if (!ai.playerContact) {
        // Within the release slack but never actually touched — not a contact.
        continue;
      }

      // Hold them there for as long as they are touching.
      if (ai.speed < limit) limit = ai.speed;
    }

    player.speedLimit = (limit === Infinity) ? undefined
      : Math.max(limit, cfg.fullSpeed * MIN_CONTACT_SPEED_FRACTION);
    return newHits;
  }

  /* Clears contact flags, for a restart or a new lap. */
  function reset(player, field) {
    player.speedLimit = undefined;
    player.bumpFlash = 0;
    for (var i = 0; i < field.length; i++) field[i].playerContact = false;
  }

  BR.collision = { resolve: resolve, reset: reset, overlap: overlap };
})(window.BR);
