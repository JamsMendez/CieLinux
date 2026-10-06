"use strict";

// html-wallpaper-demo D6c: the idle scene's "see-through" hook for the shared alert overlay
// (CielWin.App/Wallpaper/Web/shared/js/alert-overlay.js) -- kept in its own small file, same
// pattern as processing's/explorer's/raphael's own D2/D6a/D6b hooks.
//
// Per the feature doc's D6 decision, idle's see-through layer is the constellations of the FIRST
// ring only (RING_ANIMATIONS[0] in js/animate.js, the "constellation" ring) -- already pre-rendered
// into its own offscreen cache canvas by buildRingCaches and stamped rotated onto the main canvas
// every frame by drawCachedRingContent(context, cache, cx, cy, angle) (js/animate.js).
// drawCachedRingContent IS context-parameterized (it draws into whatever `context` it is given,
// never a module-global one), so unlike raphael's own gold ring (which paints through pre-baked
// sprites stamped straight onto the module-global ctx, with no way to redirect that path), this
// scene's real ring paint function can simply be called again here, into `g`.
//
// The one thing that MUST NOT happen (D6b review lesson, see js/animate.js's own
// constellationRingStamp remarks): a second, independent copy of the ring's rotation/geometry math
// that could silently drift from the real paint path. Instead, this hook reads
// constellationRingStamp -- the EXACT {cache, cx, cy, angle} js/animate.js's own render loop just
// passed to drawCachedRingContent for the constellation ring THIS FRAME -- and stamps that same
// cache object with those same values again, into `g`. There is only one calculation, done once, by
// the scene itself; this hook never computes an angle or a center of its own.
//
// `g` is already translated so this scene's own (0,0) origin lands at this tile's own position (see
// the shared module's drawSeeThroughIntersections); W/H are ALREADY set to sceneW/sceneH by the
// caller, but this hook does not need them -- constellationRingStamp already carries the exact cx/cy
// the scene used, computed from the SAME W/H this same frame. Drawing the ring's unlit cache content
// (no lighting mask, no other ring) is intentional: the shared overlay only needs the ring's alpha
// shape to recolor (source-in) and clip to the letters (destination-in) afterward, not its on-screen
// brightness.
// Linux port begin (A4): CielWin declares constellationRingStamp in js/animate.js; this port keeps
// animate.js's pinned reference body unchanged, so the stamp lives here and the Linux loop section
// of js/animate.js records the exact {cache, cx, cy, angle} it just drew the constellation ring with.
var constellationRingStamp = null;
// Linux port end.

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

function sceneSeeThroughLayer(g, sceneW, sceneH, sceneTime) {
  // Guards the very first frame, if it happens to throw before the scene's own ring loop ever runs
  // (see js/animate.js's own remarks) -- nothing to stamp yet, so draw nothing rather than throw.
  if (!constellationRingStamp) return;
  drawCachedRingContent(g, constellationRingStamp.cache, constellationRingStamp.cx, constellationRingStamp.cy, constellationRingStamp.angle);
}
