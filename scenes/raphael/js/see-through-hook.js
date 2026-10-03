"use strict";

// html-wallpaper-demo D6b: the raphael scene's "see-through" hook for the shared alert overlay
// (CielWin.App/Wallpaper/Web/shared/js/alert-overlay.js) -- kept in its own small file, same
// pattern as processing's/explorer's own D2/D6a hooks, so js/layers.js stays (almost) the verbatim
// port it has been since this scene was copied in. layers.js's ONE addition for D6b is
// goldGlyphRingDrawParams, a small pure seam placed right before drawGlyphRings (see that function's
// own header remarks for why it exists and what it reuses).
//
// Per the feature doc's D6 decision, raphael's see-through layer is the GOLDEN GLYPH RING ONLY --
// this scene's fake folding bands (unlike processing's) are not even painted into the scene itself
// (js/layers.js's own header remarks), so there is nothing to "drop" here beyond simply never
// drawing them.
//
// The real gold ring (js/layers.js's drawGlyphRings/drawOutlineGlyphRing) draws through pre-baked
// sprite bitmaps stamped straight onto the module-global `ctx` (js/sprites.js's stampSprite) -- there
// is no way to redirect that path into the offscreen context `g` the shared overlay hands this hook.
// This hook instead redraws the SAME ring -- same radius, same rotation, same glyph pool, same count
// (goldGlyphRingDrawParams, js/layers.js) -- through glyphs.js's own drawGlyphRing(context, ...),
// which IS context-parameterized (draws into whatever `context` it is given, never the module-global
// `ctx`), unlike drawOutlineGlyphRing.
//
// `g` is already translated so this scene's own (0,0) origin lands at this tile's own position (see
// the shared module's drawSeeThroughIntersections), and W/H are ALREADY set to sceneW/sceneH by the
// caller -- cx/cy below use the SAME 0.505/0.515 scene-center fractions js/main.js's render() uses
// for every other layer (drawGlyphRings included). The shared overlay recolors this drawing to the
// alert's own color (blue failed / violet warning) via a 'source-in' composite and clips it to the
// letters afterward, so this hook only needs to draw an opaque shape -- it fills with plain white,
// same as processing's/explorer's own hooks already do.
function sceneSeeThroughLayer(g, sceneW, sceneH, progress) {
  var cx = sceneW * 0.505;
  var cy = sceneH * 0.515;
  var gold = goldGlyphRingDrawParams(progress);
  // mini-scene-window T2: the mini scene is magnified about its center (main.js), so the letters'
  // see-through ring must be too or it would sit inside the drawn ring instead of on it.
  var zoom = isMiniVariant ? MINI_SCENE_ZOOM : 1;
  g.save();
  g.translate(cx, cy);
  g.scale(zoom, zoom);
  g.translate(-cx, -cy);
  drawGlyphRing(g, gold.pool, cx, cy, gold.radius, gold.count, gold.glyphSize, 0, gold.rotation, "rgb(255,255,255)", gold.lineWidth);
  g.restore();
}
