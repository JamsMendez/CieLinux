"use strict";

// html-wallpaper-demo D6a: the processing scene's "see-through" hook for the shared alert overlay
// (CielWin.App/Wallpaper/Web/shared/js/alert-overlay.js) -- kept in its own small file so
// js/layers.js stays the verbatim port it has been since D2 (see that file's own header). Draws the
// scene's real folding bands (foldingBandParameters/foldingBandGeometry/fillFoldingBandGeometry,
// js/layers.js) into the offscreen letters-clip context the shared overlay passes in, for ONE tile:
// `g` is already translated so this scene's own (0,0) origin lands at that tile's own position (see
// the shared module's drawSeeThroughIntersections), and W/H are ALREADY set to sceneW/sceneH by the
// caller -- so the bands are drawn exactly as the scene's own drawAtomicOrbits(cx, cy, progress)
// would, at the exact SAME progress the scene used this frame (js/main.js's render() passes the same
// `p` its own drawAtomicOrbits call used). The shared overlay recolors this drawing to the alert's
// own color (blue failed / violet warning) and clips it to the letters afterward, so this hook only
// needs to draw an opaque shape -- it fills with plain white, same as the shared overlay's own
// 'source-in' recolor would replace anyway.
function sceneSeeThroughLayer(g, sceneW, sceneH, progress) {
  var cx = sceneW * 0.505;
  var cy = sceneH * 0.515;
  g.save();
  g.translate(cx, cy);
  g.scale(viewZoom, viewZoom);
  var bands = foldingBandParameters(progress);
  for (var i = 0; i < bands.length; i++) {
    var rx = bands[i][0], ry = bands[i][1], rot = bands[i][2], width = bands[i][3], foldPhase = bands[i][4];
    g.save();
    g.rotate(rot);
    fillFoldingBandGeometry(g, foldingBandGeometry(rx, ry, width, foldPhase), "rgb(255,255,255)");
    g.restore();
  }
  g.restore();
}
