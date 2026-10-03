// html-wallpaper-demo D6b: copied verbatim from docs/great-sage/background-raphael/js/glyph-rings.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged. glyphRingAnnuli/
// glyphRingCountForRing/glyphRingGlyphBounds below are the SAME pure geometry functions
// js/layers.js's goldGlyphRingDrawParams (the one small D6b seam added there) reuses to feed the gold
// ring's real radius/count into js/see-through-hook.js -- see that file's own header remarks.

// glyph-rings.js — pure annulus geometry for the four glyph rings outward from the hexadecagon
// core: (a) clear/transparent, (b) thick bold gold glyphs, (c) clear again (the green/gold nebula
// shows through), (d) the same glyphs, larger and translucent blue. Loads after config.js and
// math.js; touches no DOM/ctx, so every function here is directly testable through the vm harness.
// js/layers.js's drawGlyphRings consumes these, plus glyphs.js's drawGlyphRing, to paint the layer.

// `r` is the hexadecagon's own on-screen radius (coreRadius(Math.min(W, H)), js/hexadecagon.js —
// RAP-15); every annulus radius is a GLYPH_RING_*_FACTOR of it, so the whole ring system scales
// with the core.
function glyphRingAnnuli(r) {
  const inner = r * GLYPH_RING_CLEAR_INNER_FACTOR;
  const goldInner = r * GLYPH_RING_CLEAR_OUTER_FACTOR;
  const goldOuter = r * GLYPH_RING_GOLD_OUTER_FACTOR;
  const nebulaOuter = r * GLYPH_RING_NEBULA_OUTER_FACTOR;
  const blueOuter = r * GLYPH_RING_BLUE_OUTER_FACTOR;
  return [
    { name: 'clear-inner', innerRadius: inner, outerRadius: goldInner, hasGlyphs: false },
    { name: 'gold', innerRadius: goldInner, outerRadius: goldOuter, hasGlyphs: true },
    { name: 'clear-outer', innerRadius: goldOuter, outerRadius: nebulaOuter, hasGlyphs: false },
    { name: 'blue', innerRadius: nebulaOuter, outerRadius: blueOuter, hasGlyphs: true },
  ];
}

// The uniform-scale glyph size (full local-box width) that fills exactly `fraction` of the
// annulus's radial thickness, and the actual min/max radius that size's worst-case ink reaches at
// the annulus's mid-radius. GLYPH_MAX_LOCAL_FULL_EXTENT (config.js) is glyphs.js's own proven
// worst-case full extent of a unit-size glyph (see its IDL-16 comment), so this is exact, not an
// approximation: a `fraction` below 1 is what leaves margin before the ring's delimiter lines.
function glyphRingGlyphBounds(annulus, fraction) {
  const thickness = annulus.outerRadius - annulus.innerRadius;
  const size = thickness * fraction / GLYPH_MAX_LOCAL_FULL_EXTENT;
  const midRadius = (annulus.innerRadius + annulus.outerRadius) / 2;
  const halfReach = (size * GLYPH_MAX_LOCAL_FULL_EXTENT) / 2;
  return { size, minRadius: midRadius - halfReach, maxRadius: midRadius + halfReach };
}

const GLYPH_RING_ANNULI = glyphRingAnnuli(1); // reference (r=1) shape, scaled per-frame by layers.js

// RAP-13 (user feedback: "outline font" blue glyphs, thick heavy strokes) + review advisory ("the
// glyph-bounds test is tautological and ignores real stroke ink"). Unlike glyphRingGlyphBounds
// above (which assumes GLYPH_MAX_LOCAL_FULL_EXTENT — the OLD thin default stroke's margin already
// baked in), these use the glyph's raw path half-extent (GLYPH_LOCAL_HALF_EXTENT, config.js) plus
// HALF the *actual* stroke width in pixels this frame draws with — a real, not assumed, ink bound
// that stays correct for any stroke thickness, thin or (as the outline-font blue ring needs) thick.
function glyphRingGlyphExtent(glyphSize, strokeWidthPx) {
  return glyphSize * GLYPH_LOCAL_HALF_EXTENT + strokeWidthPx / 2;
}

// The uniform glyph size whose real extent (above) exactly fills `fraction` of the annulus's
// radial thickness for a glyph stroked at `strokeWidthPx` — the sizing counterpart of
// glyphRingGlyphExtent, so a heavy fixed-pixel stroke (unlike the old size-proportional default)
// still leaves the requested margin.
function glyphRingGlyphSizeForStroke(annulus, fraction, strokeWidthPx) {
  const thickness = annulus.outerRadius - annulus.innerRadius;
  const budget = (thickness * fraction) / 2 - strokeWidthPx / 2;
  return Math.max(0, budget / GLYPH_LOCAL_HALF_EXTENT);
}

// The actual min/max radius a glyph of `glyphSize` stroked at `strokeWidthPx` reaches at the
// annulus's mid-radius — the verification counterpart, used by tests/invariants (not a tautology:
// it recomputes the bound from the real stroke width, independent of how glyphSize was chosen).
function glyphRingGlyphBoundsForStroke(annulus, glyphSize, strokeWidthPx) {
  const midRadius = (annulus.innerRadius + annulus.outerRadius) / 2;
  const extent = glyphRingGlyphExtent(glyphSize, strokeWidthPx);
  return { minRadius: midRadius - extent, maxRadius: midRadius + extent, extent };
}

// RAP-19a (parent-confirmed review defect): the outline font's interior pass was painted
// source-over directly on the opaque border, so the whole stroke stayed ~opaque instead of
// reading as a translucent center. The real fix is a three-pass compositing sequence: paint the
// opaque border at the full body width, PUNCH a hole the interior's width using
// 'destination-out' at full alpha (erasing that much of the border down to nothing), then refill
// that hole with the translucent interior color under normal 'source-over'. Returned as a plain
// ops list (not performed here) so it is provably correct — order and modes — independent of any
// canvas/DOM; js/sprites.js's paintOutlineGlyph applies each op in order.
// RAP-26 (user feedback, verbatim — "como un objeto manipulado por mis manos"): "hacer que los
// caracteres tengan la mitad del tamaño que el grueso de su anillo. Luego tomar cada carácter de su
// base inferior y superior y alargarlos hasta que casi toquen el borde de su respectivo anillo,
// unos 10px de margin; visualmente todos los caracteres van a tener el mismo ancho al estar
// estirados y los puedes ir acomodando uno al lado del otro hasta llenar el anillo, dejando su
// espacio entre ellos, unos 20px tal vez." Replaces the RAP-20/20b aspect+fill-fraction sizing
// entirely: size (and stroke width) is a fixed px target derived from the annulus thickness once;
// every glyph is independently fit to that SAME target (glyphRingFitScale), regardless of its own
// natural shape; count is derived from how many (glyph + gap) fit the circumference
// (glyphRingCountForRing) — never the other way round.

// The per-axis scale factors — applied directly to a glyph's RAW, recentered local coordinates by
// glyphs.js's transformStrokesForRing (a path transform, never ctx.scale, so the stroke width
// painted afterward is exact, not distorted) — that make ITS OWN real (stroke-inclusive) ink width
// come out to EXACTLY `targetWidth` and its real ink height to EXACTLY `targetHeight`, regardless of
// this glyph's own natural rawHalfWidth/rawHalfHeight (glyphs.js's strokesBounds on its recentered
// strokes). Solving 2*scaleX*rawHalfWidth + strokeWidthPx = targetWidth (and the same for Y) for
// scaleX/scaleY gives the two independent per-axis expressions below — independent because a
// uniform "normalize to width" pass followed by a Y-only "stretch to height" pass is algebraically
// identical to fitting each axis directly (the intermediate uniform factor cancels out).
function glyphRingFitScale(rawHalfWidth, rawHalfHeight, targetWidth, targetHeight, strokeWidthPx) {
  const scaleX = rawHalfWidth > 0 ? Math.max(0, (targetWidth - strokeWidthPx) / (2 * rawHalfWidth)) : 0;
  const scaleY = rawHalfHeight > 0 ? Math.max(0, (targetHeight - strokeWidthPx) / (2 * rawHalfHeight)) : 0;
  return { scaleX, scaleY };
}

// The actual real (stroke-inclusive) half-width/half-height a glyph reaches after
// transformStrokesForRing applies (scaleX, scaleY) to its raw half-extents — the verification
// counterpart of glyphRingFitScale, used by tests/invariants (never a tautology: it recomputes the
// bound from the real scale factors, independent of how they were chosen).
function glyphRingFitExtent(rawHalfWidth, rawHalfHeight, scaleX, scaleY, strokeWidthPx) {
  return {
    halfWidth: rawHalfWidth * scaleX + strokeWidthPx / 2,
    halfHeight: rawHalfHeight * scaleY + strokeWidthPx / 2,
  };
}

// The linear (px) gap left between two adjacent glyphs' ink at a given radius, for `count` evenly
// spaced glyphs each `glyphWidthPx` wide: the arc length available per glyph (angularStep * radius)
// minus the glyph's own width. Used both to derive count (below) and to verify non-overlap
// (tests/invariants) — the SAME formula, so neither can silently drift out of sync.
function glyphRingLinearGapAtRadius(radius, count, glyphWidthPx) {
  return (TAU / count) * radius - glyphWidthPx;
}

// The largest glyph count that fits `gapPx` (or more) between neighbours at the annulus's own MID
// radius (circumference / (glyphWidthPx + gapPx), floored), then reduced — one at a time — until
// the gap at the annulus's INNER radius (tighter than mid: less circumference for the same angular
// step) is also non-negative, so ink never touches there either, exactly as the coordinator asked:
// "asegura que la tinta nunca se toque en el radio interior también."
function glyphRingCountForRing(annulus, glyphWidthPx, gapPx) {
  const midRadius = (annulus.innerRadius + annulus.outerRadius) / 2;
  const circumference = TAU * midRadius;
  let count = Math.max(1, Math.floor(circumference / (glyphWidthPx + gapPx)));
  while (count > 1 && glyphRingLinearGapAtRadius(annulus.innerRadius, count, glyphWidthPx) < 0) {
    count -= 1;
  }
  return count;
}

// RAP-35: glyphRingCountForRing's count plus `extra` more glyphs, packed into the spare space the
// gapPx spacing leaves between neighbours (the even angular layout just tightens the gap). Extras
// are dropped one at a time while ink would touch at the annulus's INNER radius, so the same
// "ink never touches" rule still holds; it never goes below the base count.
function glyphRingCountWithExtra(annulus, glyphWidthPx, gapPx, extra) {
  const base = glyphRingCountForRing(annulus, glyphWidthPx, gapPx);
  let count = base + Math.max(0, extra);
  while (count > base && glyphRingLinearGapAtRadius(annulus.innerRadius, count, glyphWidthPx) < 0) {
    count -= 1;
  }
  return count;
}

// RAP-26b (coordinator item 3 — parent headless check): "each glyph's local up axis must equal the
// outward radial direction." A ring glyph's local +Y is the axis transformStrokesForRing stretches
// to fill the ring's thickness (glyphRingFitScale's scaleY); this returns the ctx.rotate() angle
// that makes that same local +Y map to the ring position's own outward unit vector
// (cos(ringAngle), sin(ringAngle)) — never a hand-picked "angle + Math.PI/2" guess, since canvas
// rotate(theta) maps local (0,1) to (-sin(theta), cos(theta)) (screen space: X right, Y down), and
// solving -sin(theta)=cos(ringAngle), cos(theta)=sin(ringAngle) gives theta = ringAngle - Math.PI/2
// exactly (verified directly by test/ring-glyph-fidelity.test.mjs against that same rotation
// matrix, not by eyeballing a render).
function glyphRingOrientationAngle(ringAngle) {
  return ringAngle - Math.PI / 2;
}

function outlineGlyphOps(bodyWidth, borderWidth, borderColor, interiorColor) {
  const interiorWidth = Math.max(0.4, bodyWidth - 2 * borderWidth);
  return [
    { compositeOperation: 'source-over', color: borderColor, width: bodyWidth },
    { compositeOperation: 'destination-out', color: 'rgba(0,0,0,1)', width: interiorWidth },
    { compositeOperation: 'source-over', color: interiorColor, width: interiorWidth },
  ];
}

// --- mini-scene-window T2d: mini-only glyph ring metrics (see the MINI_GOLD_* notes in config.js) ------
// isMiniVariant comes from shared/js/render-loop.js and is resolved at CALL time (this file loads first).

// The composition's scale relative to the 1920x1080 wallpaper the px constants were tuned for (~0.19 at 288px).
function glyphRingMiniScale() {
  return coreRadius(Math.min(W, H)) / coreRadius(1080);
}

function glyphRingEdgeMarginPx() {
  return isMiniVariant ? GLYPH_RING_EDGE_MARGIN_PX * glyphRingMiniScale() : GLYPH_RING_EDGE_MARGIN_PX;
}

function glyphRingGapPx() {
  return isMiniVariant ? GLYPH_RING_GAP_PX * glyphRingMiniScale() : GLYPH_RING_GAP_PX;
}

// The gold ring's glyph count for glyphs `targetWidth` wide (the same in every variant, see config.js's
// GLYPH_RING_GOLD_* notes): GLYPH_RING_GOLD_COUNT_FACTOR x what the standard rule (0.5-wide glyphs, the ring's
// gap) gives, capped at the most that fit without overlapping at the tighter inner radius.
function goldGlyphRingCount(annulus, targetWidth) {
  const thickness = annulus.outerRadius - annulus.innerRadius;
  const standard = glyphRingCountForRing(annulus, thickness * GLYPH_RING_GOLD_BASE_SIZE_FRACTION, glyphRingGapPx());
  const fits = glyphRingCountForRing(annulus, targetWidth, GLYPH_RING_GOLD_MIN_GAP_FRACTION * targetWidth);
  return Math.min(GLYPH_RING_GOLD_COUNT_FACTOR * standard, fits);
}
