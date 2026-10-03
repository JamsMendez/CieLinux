// html-wallpaper-demo D6b: copied verbatim from docs/great-sage/background-raphael/js/hexadecagon.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged.

// hexadecagon.js — pure geometry and pulse timing for the golden hexadecagon core: Raphael's
// 16-sided evolution of the inherited octagon. Loads after config.js and math.js; touches no
// DOM/ctx, so every function here is directly testable through test/support/load-scene.mjs.
// js/layers.js (drawGoldenHexadecagon) consumes hexadecagonVertices()/hexadecagonPulse() to
// actually paint the gold/white-hot glowing ring.

// RAP-15 (user feedback): "Aumenta el tamaño del círculo en general, casi debe tocar el top y
// bottom, déjale un margin de unos 50px." The hexadecagon's own radius, worked out backward from
// the outermost glyph ring's target outer edge (minD/2 - GLYPH_SYSTEM_OUTER_MARGIN_PX) through
// that ring's own GLYPH_RING_BLUE_OUTER_FACTOR (js/glyph-rings.js's glyphRingAnnuli multiplies
// every ring radius, including the blue ring's outer edge, by a factor of THIS r) — so the whole
// concentric system scales together and the outer edge lands exactly at the target, not just
// proportionally with the viewport (a fixed pixel margin cannot be a pure proportion of minD).
function coreRadius(minD) {
  const outerTarget = minD / 2 - GLYPH_SYSTEM_OUTER_MARGIN_PX;
  const marginBased = outerTarget / GLYPH_RING_BLUE_OUTER_FACTOR;
  // RAP-19c: a tiny viewport (min(W,H) <= 2 * GLYPH_SYSTEM_OUTER_MARGIN_PX) makes the margin-based
  // radius non-positive; fall back to a plain proportional radius so the composition stays sane.
  if (marginBased > 0) return marginBased;
  return minD * HEXADECAGON_FALLBACK_RADIUS_FACTOR;
}

// Same interval/duration sine-hump shape as the inherited octagon pulse (js/main.js's former
// octagonPulse), just shorter and sharper per HEXADECAGON_PULSE_* in config.js: the light
// "breathes" more often and more intensely.
function hexadecagonPulse(ms) {
  const duration = HEXADECAGON_PULSE_DURATION * 1000;
  const elapsed = ms % (HEXADECAGON_PULSE_INTERVAL * 1000);
  if (elapsed <= 0 || elapsed >= duration) return 0;
  return Math.sin(Math.PI * elapsed / duration);
}

function hexadecagonVertexAngle(index) {
  return -Math.PI / 2 + index * TAU / HEXADECAGON_SIDES;
}

// RAP-9 (user feedback): the pulse expresses only as a uniform radius scale — every vertex shares
// this exact same radius, so the polygon stays a true regular 16-gon (straight sides, equal edges)
// at every pulse sample. Drawing-time intensity (stroke width, glow/shadow blur, chromatic offset
// copies) lives in js/layers.js's drawGoldenHexadecagon and never touches vertex geometry.
function hexadecagonPulseRadius(r, pulse) {
  return r * (1 + pulse * HEXADECAGON_PULSE_RADIUS_SCALE);
}

function hexadecagonVertices(r, pulse) {
  const radius = hexadecagonPulseRadius(r, pulse);
  return Array.from({ length: HEXADECAGON_SIDES }, (_, index) => {
    const angle = hexadecagonVertexAngle(index);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, angle, radius };
  });
}

// RAP-9 follow-up (user feedback): "la figura crece mucho, no debe salirse de su propio anillo".
// The worst-case radial reach of everything drawGoldenHexadecagon paints as a *solid* stroke (not
// counting shadowBlur/glow bleed, which is allowed to soften past this): the outer vertex radius,
// plus half the thicker main-ring stroke width, or — whichever is larger — the chromatic offset
// copies' own reach (their offset plus half their own, thinner, stroke width). Mirrors
// drawGoldenHexadecagon's exact formulas (js/layers.js) so this is a faithful bound, not an
// independently-guessed one; callers compare it against the *independently defined* glyph-ring
// geometry (js/glyph-rings.js) to prove the two never overlap — see test/hexadecagon.test.mjs and
// assertGlyphRingInvariants (js/invariants.js).
function hexadecagonDrawnExtent(r, pulse) {
  const vertexRadius = hexadecagonPulseRadius(r, pulse);
  const pulseStroke = 1 + pulse * HEXADECAGON_PULSE_STROKE_FACTOR;
  const chromaticStrokeWidth = r * HEXADECAGON_STROKE_WIDTH_FACTOR * pulseStroke;
  const mainStrokeWidth = chromaticStrokeWidth * 1.3;
  const chromaticOffset = r * HEXADECAGON_CHROMATIC_OFFSET_FACTOR;
  const mainRingExtent = vertexRadius + mainStrokeWidth / 2;
  const chromaticExtent = vertexRadius + chromaticOffset + chromaticStrokeWidth / 2;
  return Math.max(mainRingExtent, chromaticExtent);
}
