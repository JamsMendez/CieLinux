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
function sceneSeeThroughLayer(g, sceneW, sceneH, sceneTimeSeconds) {
  drawRisingSparks(g, sceneTimeSeconds);
}
