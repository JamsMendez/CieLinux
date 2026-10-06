"use strict";

// html-wallpaper-demo D6a: the explorer scene's "see-through" hook for the shared alert overlay
// (CielWin.App/Wallpaper/Web/shared/js/alert-overlay.js) -- kept in its own small file so
// js/rising-sparks.js stays the verbatim port it has been since this scene was copied in (see that
// file's own header). Draws the scene's real rising sparks (drawRisingSparks, js/rising-sparks.js)
// into the offscreen letters-clip context the shared overlay passes in, for ONE tile: `g` is already
// translated so this scene's own (0,0) origin lands at that tile's own position (see the shared
// module's drawSeeThroughIntersections), and W/H are ALREADY set to sceneW/sceneH by the caller --
// drawRisingSparks reads those same W/H globals directly (js/rising-sparks.js draws in absolute
// scene coordinates, not centered on a scene "center" the way processing's own hook is), so it draws
// exactly as the scene's own js/animate.js renderFrame() call would, at the exact SAME timeSeconds
// the scene used this frame (renderFrame passes that same value through to renderAlertOverlay). The
// shared overlay recolors this drawing to the alert's own color (blue failed / violet warning) and
// clips it to the letters afterward, so this hook does not need to pick a color.
// Linux port begin (R1): odd/tasks/alert-title-reach.md. Alert title reach (shared/js/alert-overlay.js,
// failureTitleLayout): the WARNING/FAILED letters cross the Greek ring and stop a small margin short of the
// hieroglyph band (between the Greek and the constellation rings), using js/animate.js's ring center and
// activeSceneBasis.
function sceneAlertTitleLimits(sceneW, sceneH) {
  var minD = Math.min(sceneW, sceneH);
  var reach = HIEROGLYPH_BAND_OUTER_RADIUS_FRACTION * activeSceneBasis();
  var cy = isMiniVariant ? sceneH / 2 : sceneH * CENTER_Y_FRACTION;
  var margin = Math.max(3, minD * 0.012);
  return { top: cy - reach - margin, bottom: cy + reach + margin };
}
// Linux port end.

function sceneSeeThroughLayer(g, sceneW, sceneH, sceneTimeSeconds) {
  drawRisingSparks(g, sceneTimeSeconds);
}
