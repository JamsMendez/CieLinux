// html-wallpaper-demo D6b: copied verbatim from docs/great-sage/background-raphael/js/glyphs.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged. drawGlyphRing
// below is CONTEXT-PARAMETERIZED (takes `context` as its own argument, never the module-global
// `ctx`) -- js/see-through-hook.js reuses it directly to redraw the gold ring into the shared alert
// overlay's own offscreen context; see that file's own header remarks and js/layers.js's
// goldGlyphRingDrawParams (the one small seam D6b adds there).

// glyphs.js — deterministic procedural glyph generation: a "hieroglyph" stroke generator for the
// fine glyph-text rows, the Greek alphabet used by the alphabet ring, and helpers that lay a
// seeded run of glyphs evenly around an arc. Loads after config.js and math.js. All content here
// is generated once from a seeded RNG and cached; nothing here reads Date.now() or rnd() at draw time.

const GREEK_UPPERCASE = ['Α', 'Β', 'Γ', 'Δ', 'Ε', 'Ζ', 'Η', 'Θ', 'Ι', 'Κ', 'Λ', 'Μ', 'Ν', 'Ξ', 'Ο', 'Π', 'Ρ', 'Σ', 'Τ', 'Υ', 'Φ', 'Χ', 'Ψ', 'Ω'];
const GREEK_LOWERCASE = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ξ', 'ο', 'π', 'ρ', 'σ', 'τ', 'υ', 'φ', 'χ', 'ψ', 'ω'];

// GLYPH_LOCAL_HALF_EXTENT (config.js): the documented per-axis half-extent every glyph stroke is
// meant to stay inside ([-0.45, 0.45], i.e. a small margin inside the nominal [-0.5, 0.5] unit box
// mentioned above). IDL-16: the 'curve' stroke type below could generate an arc whose *circle*
// (cx/cy up to 0.25, radius up to 0.4) reached a half-extent of up to 0.65 — a real, if rare,
// violation of this invariant that downstream consumers (in particular the outer glyph ring's
// tight radial margin, see OUTER_GLYPH_SIZE_FRACTION_OF_THICKNESS in config.js) rely on, and the
// true root cause of a handful of glyphs visibly touching that ring's boundary line. Fixed at the
// source: the radius is now clamped so the full circle (not just the drawn arc, a safe
// over-approximation) never exceeds this half-extent on either axis, regardless of where cx/cy
// landed. Defined in config.js (not here) since config.js loads first and OUTER_GLYPH_* also reads it.

// Computes a glyph's true local-space bounding box from its strokes. Curve strokes are measured as
// their full circle (cx +/- radius), not just the swept [start, end) arc — a simple, always-safe
// over-approximation (the arc never draws outside its own circle) that avoids reasoning about
// which cardinal angles the sweep does or doesn't cross. Ignores stroke width, which pads both
// sides of a stroke equally and so does not shift the box's center (only its size).
function strokesBounds(strokes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const extend = (x, y) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const stroke of strokes) {
    if (stroke.type === 'line') {
      for (const [x, y] of stroke.points) extend(x, y);
    } else if (stroke.type === 'curve') {
      extend(stroke.cx - stroke.radius, stroke.cy - stroke.radius);
      extend(stroke.cx + stroke.radius, stroke.cy + stroke.radius);
    } else {
      // 'dot': fixed draw radius, see drawHieroglyph/drawStrokesOnly — GLYPH_STROKE_HALF_WIDTH_LOCAL
      // (config.js) is the single source of truth for this value; do not hand-copy it here.
      extend(stroke.x - GLYPH_STROKE_HALF_WIDTH_LOCAL, stroke.y - GLYPH_STROKE_HALF_WIDTH_LOCAL);
      extend(stroke.x + GLYPH_STROKE_HALF_WIDTH_LOCAL, stroke.y + GLYPH_STROKE_HALF_WIDTH_LOCAL);
    }
  }
  return { minX, maxX, minY, maxY };
}

// IDL-16: recenters a glyph's strokes so its own true bounding box (strokesBounds above) is
// centered at local (0,0). Every ring draws a glyph's strokes around that local origin assuming it
// IS the glyph's visual center (e.g. the outer glyph ring places it at its band's exact mid-radius
// expecting equal margin both sides) — but each glyph's 2-4 strokes are independently randomized,
// so an individual glyph's actual ink was not guaranteed to be centered on that origin before this
// fix. A translate-only shift (no rescale): every stroke type shifts by the same (dx, dy), so shape
// is preserved exactly, only position. Provably never *increases* the glyph's worst-case half-extent
// on either axis beyond GLYPH_LOCAL_HALF_EXTENT (the recentered half-extent is (max-min)/2, which is
// <= max(|min|, |max|) whenever the box already sits within [-GLYPH_LOCAL_HALF_EXTENT,
// GLYPH_LOCAL_HALF_EXTENT]), so it stays compatible with every consumer's existing margin math.
function recenterStrokes(strokes) {
  const { minX, maxX, minY, maxY } = strokesBounds(strokes);
  const dx = (minX + maxX) / 2;
  const dy = (minY + maxY) / 2;
  if (dx === 0 && dy === 0) return strokes;
  return strokes.map((stroke) => {
    if (stroke.type === 'line') return { ...stroke, points: stroke.points.map(([x, y]) => [x - dx, y - dy]) };
    if (stroke.type === 'curve') return { ...stroke, cx: stroke.cx - dx, cy: stroke.cy - dy };
    return { ...stroke, x: stroke.x - dx, y: stroke.y - dy };
  });
}

// Builds one deterministic "hieroglyph" glyph as a small set of strokes inside a unit box
// ([-0.5, 0.5] on both axes). A local per-index RNG keeps this independent of shared rnd() draw
// order, so changing one ring's glyph count never reshuffles another ring's glyphs.
// Each stroke is either a polyline ('line'), a small arc ('curve'), or a single point ('dot').
function makeHieroglyph(index, seedBase) {
  const random = mulberry32((seedBase + index * 0x9e3779b9) >>> 0);
  const strokeCount = 2 + Math.floor(random() * 3); // 2..4 strokes per glyph
  const strokes = [];
  for (let i = 0; i < strokeCount; i++) {
    const kind = random();
    if (kind < 0.4) {
      // Straight or bent polyline of 2-3 points.
      const pointCount = random() < 0.5 ? 2 : 3;
      const points = Array.from({ length: pointCount }, () => [
        (random() - 0.5) * 0.9,
        (random() - 0.5) * 0.9,
      ]);
      strokes.push({ type: 'line', points });
    } else if (kind < 0.8) {
      // Small arc. IDL-16: radius is clamped so the full circle (cx +/- radius on each axis) never
      // exceeds GLYPH_LOCAL_HALF_EXTENT, even though cx/cy is drawn from a range (+/-0.25) that
      // would otherwise let the pre-clamp radius range (0.15-0.4) push the circle out to 0.65 — see
      // GLYPH_LOCAL_HALF_EXTENT above. Clamped only (not redrawn), so the RNG call count/order — and
      // therefore every other glyph's shape — is unchanged.
      const cx = (random() - 0.5) * 0.5;
      const cy = (random() - 0.5) * 0.5;
      const maxRadius = GLYPH_LOCAL_HALF_EXTENT - Math.max(Math.abs(cx), Math.abs(cy));
      const radius = Math.min(0.15 + random() * 0.25, maxRadius);
      strokes.push({ type: 'curve', cx, cy, radius, start: random() * TAU, end: random() * TAU });
    } else {
      strokes.push({ type: 'dot', x: (random() - 0.5) * 0.7, y: (random() - 0.5) * 0.7 });
    }
  }
  // IDL-16: recenter so this glyph's own true bounding box sits on its local origin — see
  // recenterStrokes above.
  return recenterStrokes(strokes);
}

// Draws one hieroglyph centered at (x, y), scaled to `size` (full box width) times `aspectY` along
// the local Y axis (full box height = size * aspectY), rotated by `angle` (radians) so it can be
// oriented tangentially to a ring. `aspectY` defaults to 1 (the original isotropic glyph) so every
// existing caller (background-idle's own usage pattern, the digit counters) is unaffected.
// RAP-20 (user feedback): Raphael's ring glyphs use aspectY > 1 to read "elongated: tall along the
// radial direction, narrow tangentially", matching the reference frame. Local Y maps to the ring's
// RADIAL direction and local X to TANGENTIAL once the caller passes the ring's own tangential
// `angle` (see js/layers.js's drawGlyphRings/drawOutlineGlyphRing).
function drawHieroglyph(context, strokes, x, y, size, angle, color, lineWidth, aspectY = 1) {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.scale(size, size * aspectY);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = lineWidth / size;
  context.lineCap = 'round';
  // RAP-21 (user feedback): rounded corners, not straight/sharp joins, on every glyph stroke.
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    if (stroke.type === 'line') {
      context.beginPath();
      context.moveTo(stroke.points[0][0], stroke.points[0][1]);
      for (let i = 1; i < stroke.points.length; i++) context.lineTo(stroke.points[i][0], stroke.points[i][1]);
      context.stroke();
    } else if (stroke.type === 'curve') {
      context.beginPath();
      context.arc(stroke.cx, stroke.cy, stroke.radius, stroke.start, stroke.end);
      context.stroke();
    } else if (stroke.type === 'dot') {
      context.beginPath();
      context.arc(stroke.x, stroke.y, GLYPH_STROKE_HALF_WIDTH_LOCAL, 0, TAU);
      context.fill();
    }
  }
  context.restore();
}

// RAP-26 (user feedback): ring glyphs are now normalized to an identical width and stretched
// radially to fill their ring's own thickness, via a per-point PATH transform (never ctx.scale, so
// stroke width painted afterward is never distorted by the anisotropic stretch — see
// js/glyph-rings.js's glyphRingFitScale for the scaleX/scaleY this consumes). 'curve' strokes are
// sampled into a polyline first, since a non-uniform transform of a circular arc is not itself a
// circular arc.
const GLYPH_RING_CURVE_SAMPLE_SEGMENTS = 12;

function transformStrokesForRing(strokes, scaleX, scaleY) {
  const out = [];
  for (const stroke of strokes) {
    if (stroke.type === 'line') {
      out.push({ type: 'line', points: stroke.points.map(([x, y]) => [x * scaleX, y * scaleY]) });
    } else if (stroke.type === 'curve') {
      const points = [];
      for (let i = 0; i <= GLYPH_RING_CURVE_SAMPLE_SEGMENTS; i++) {
        const t = stroke.start + ((stroke.end - stroke.start) * i) / GLYPH_RING_CURVE_SAMPLE_SEGMENTS;
        const x = stroke.cx + Math.cos(t) * stroke.radius;
        const y = stroke.cy + Math.sin(t) * stroke.radius;
        points.push([x * scaleX, y * scaleY]);
      }
      out.push({ type: 'line', points });
    } else {
      out.push({ type: 'dot', x: stroke.x * scaleX, y: stroke.y * scaleY });
    }
  }
  return out;
}

// RAP-26b: an accent dot's CENTER is included in ringGlyphRenderedBounds (so the fit-scale doesn't
// let it drift outside the box), but its RENDERED circle (radius dotRadiusPx, never scaled) still
// pokes out past a center sitting exactly at the fit boundary. This clamps each dot's (already
// scaled, real-px) center so its full rendered circle stays within the target half-width/height —
// an accent must decorate the glyph, never make it overshoot its target size.
function clampRingDotPositions(strokes, halfWidth, halfHeight, dotRadiusPx) {
  const safeHalfWidth = Math.max(0, halfWidth - dotRadiusPx);
  const safeHalfHeight = Math.max(0, halfHeight - dotRadiusPx);
  return strokes.map((stroke) => {
    if (stroke.type !== 'dot') return stroke;
    return {
      type: 'dot',
      x: Math.max(-safeHalfWidth, Math.min(safeHalfWidth, stroke.x)),
      y: Math.max(-safeHalfHeight, Math.min(safeHalfHeight, stroke.y)),
    };
  });
}

// Draws pre-transformed ring-glyph strokes (already in final real-px local units — see
// transformStrokesForRing) at (x, y) rotated by `angle`, with a REAL, unscaled `lineWidth` — no
// ctx.scale anywhere in this path, so the outline-font 3-pass stroke/border widths config declares
// are painted exactly as configured, never distorted by the glyph's own per-instance stretch.
function drawTransformedGlyph(context, strokes, x, y, angle, color, lineWidth, dotRadiusPx) {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = lineWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    if (stroke.type === 'line') {
      context.beginPath();
      context.moveTo(stroke.points[0][0], stroke.points[0][1]);
      for (let i = 1; i < stroke.points.length; i++) context.lineTo(stroke.points[i][0], stroke.points[i][1]);
      context.stroke();
    } else {
      context.beginPath();
      context.arc(stroke.x, stroke.y, dotRadiusPx, 0, TAU);
      context.fill();
    }
  }
  context.restore();
}

// Pre-generates `count` distinct hieroglyphs once; callers index into this pool (with wraparound)
// so every ring reuses the same deterministic shapes without regenerating them per draw call.
function makeHieroglyphPool(count, seedBase) {
  return Array.from({ length: count }, (_, i) => makeHieroglyph(i, seedBase));
}

// RAP-26b (regression fix — parent headless check with PIL measurement): a glyph whose only real
// content is a dot (or several dots close together) recenters to sit essentially AT the local
// origin (recenterStrokes centers the bounding box, and a dot-only box's center IS the dot's own
// position) — so however large the ring's fit-scale factor is, that near-zero coordinate stays
// near zero, while the dot's RENDERED radius is a fixed px value, never scaled. The result: a tiny
// fixed-radius dot pinned at the center of an otherwise-empty, correctly-SIZED box. Ring glyphs
// need real, spread-out content so the fit-scale actually has something to stretch.

// A single stroke's own Y-extent in local units — 'dot' contributes 0 (dots never count toward the
// "has real spread" requirement below; their bounding-box padding, GLYPH_STROKE_HALF_WIDTH_LOCAL,
// is deliberately excluded here even though strokesBounds includes it, precisely because that
// padding is what let a dot-only glyph masquerade as having nonzero extent).
function ringGlyphStrokeSpanY(stroke) {
  if (stroke.type === 'line') {
    const ys = stroke.points.map(([, y]) => y);
    return Math.max(...ys) - Math.min(...ys);
  }
  if (stroke.type === 'curve') {
    // Sampled the same way transformStrokesForRing will actually render it, so this span matches
    // the real drawn shape, not the full-circle over-approximation strokesBounds uses.
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i <= GLYPH_RING_CURVE_SAMPLE_SEGMENTS; i++) {
      const t = stroke.start + ((stroke.end - stroke.start) * i) / GLYPH_RING_CURVE_SAMPLE_SEGMENTS;
      const y = stroke.cy + Math.sin(t) * stroke.radius;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return maxY - minY;
  }
  return 0; // 'dot'
}

// A ring glyph is "worthy" when it has real, legible content: at least one line/curve stroke
// spanning >= GLYPH_RING_MIN_SPAN_FRACTION of the local box's full height, AND at most
// GLYPH_RING_MAX_DOT_STROKES dot strokes (dots are accents, never the glyph's main content —
// "dots only as accents" from the coordinator's report).
function isRingWorthyGlyph(strokes) {
  const localHeight = 2 * GLYPH_LOCAL_HALF_EXTENT;
  const maxSpan = Math.max(0, ...strokes.map(ringGlyphStrokeSpanY));
  const dotCount = strokes.filter((stroke) => stroke.type === 'dot').length;
  return maxSpan >= GLYPH_RING_MIN_SPAN_FRACTION * localHeight && dotCount <= GLYPH_RING_MAX_DOT_STROKES;
}

// The bounding box of what transformStrokesForRing will ACTUALLY draw for `strokes` — unlike
// strokesBounds (which measures a 'curve' as its full circle, a safe conservative
// over-approximation the OTHER non-ring consumers of strokesBounds rely on for overflow-safety
// margins), this samples the SWEPT ARC the same way transformStrokesForRing/drawTransformedGlyph
// actually render it. Using the conservative full-circle bounds to compute the ring's own fit-scale
// would make a curve-dominated glyph's fit-scale OVERESTIMATE how far the actual (smaller, partial-
// arc) ink reaches, undershooting the ±1px target the coordinator's recording-mock test checks.
// 'dot' strokes are excluded entirely (never define a ring glyph's fit bounds — see
// makeRingHieroglyph's comment for why a dot's fixed, unscaled render radius makes it unsuitable).
function ringGlyphRenderedBounds(strokes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const extend = (x, y) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const stroke of strokes) {
    if (stroke.type === 'line') {
      for (const [x, y] of stroke.points) extend(x, y);
    } else if (stroke.type === 'curve') {
      for (let i = 0; i <= GLYPH_RING_CURVE_SAMPLE_SEGMENTS; i++) {
        const t = stroke.start + ((stroke.end - stroke.start) * i) / GLYPH_RING_CURVE_SAMPLE_SEGMENTS;
        extend(stroke.cx + Math.cos(t) * stroke.radius, stroke.cy + Math.sin(t) * stroke.radius);
      }
    }
    // 'dot': excluded from the fit-scale bounds entirely — its rendered radius is a fixed px
    // value, never scaled, so it must never drive (or shrink) the scale meant for the glyph's real
    // spanning ink. clampRingDotPositions (below) independently keeps an accent dot's rendered
    // circle inside the target box regardless of where its raw position lands.
  }
  // Defensive only: isRingWorthyGlyph guarantees at least one qualifying line/curve stroke for
  // every glyph RING_GLYPH_POOL actually contains, so this never triggers in production.
  if (minX === Infinity) return strokesBounds(strokes);
  return { minX, maxX, minY, maxY };
}

// Generates ring glyph `slot`'s shape: tries makeHieroglyph's own deterministic generator under a
// sequence of distinct seeds (derived from `slot` and an attempt counter, so every attempt is a
// genuinely different candidate, not a re-read of the same one) until isRingWorthyGlyph accepts
// one, up to GLYPH_RING_GENERATOR_MAX_ATTEMPTS. Falls back to the last attempt if none qualify
// (deterministic either way; in practice a qualifying candidate is found within a few attempts).
// RAP-29 (regression fix — the "no ink pixel falls outside its own sprite canvas" test caught this):
// makeHieroglyph's own recenterStrokes centers the glyph on strokesBounds (the WHOLE glyph,
// including dot padding); ringGlyphRenderedBounds (what glyphRingFitScale actually fits) EXCLUDES
// dots, so the line/curve content wasn't necessarily centered within ITS OWN bounds — the fit-scale
// silently assumed symmetry around the origin that didn't hold, letting the far edge of an
// off-center glyph's ink scale past the target box. Re-centers on ringGlyphRenderedBounds's own
// midpoint instead, once, so every downstream consumer (bounds, scale, transform) sees an
// already-centered glyph and the symmetry assumption actually holds.
function recenterRingStrokes(strokes) {
  const bounds = ringGlyphRenderedBounds(strokes);
  const dx = (bounds.minX + bounds.maxX) / 2;
  const dy = (bounds.minY + bounds.maxY) / 2;
  if (dx === 0 && dy === 0) return strokes;
  return strokes.map((stroke) => {
    if (stroke.type === 'line') return { ...stroke, points: stroke.points.map(([x, y]) => [x - dx, y - dy]) };
    if (stroke.type === 'curve') return { ...stroke, cx: stroke.cx - dx, cy: stroke.cy - dy };
    return { ...stroke, x: stroke.x - dx, y: stroke.y - dy };
  });
}

function makeRingHieroglyph(slot, seedBase) {
  let candidate = null;
  for (let attempt = 0; attempt < GLYPH_RING_GENERATOR_MAX_ATTEMPTS; attempt++) {
    candidate = makeHieroglyph(slot * 97 + attempt, seedBase);
    if (isRingWorthyGlyph(candidate)) return recenterRingStrokes(candidate);
  }
  return recenterRingStrokes(candidate);
}

// A separate pool from GLYPH_TEXT_POOL (which backs every OTHER fine glyph-text row and must stay
// exactly as procedurally-random as before) — only the glyph rings need the "real spread" guarantee
// above. 96 matches GLYPH_TEXT_POOL's own size for a comparably varied script (kept as its own
// literal, not a forward-reference to GLYPH_TEXT_POOL_SIZE, which is declared later in this file).
const RING_GLYPH_POOL_SIZE = 96;
const RING_GLYPH_POOL = Array.from({ length: RING_GLYPH_POOL_SIZE }, (_, i) => makeRingHieroglyph(i, 0x5ee1e967));

// Draws `count` glyphs evenly spaced around a circle of `radius` centered at (cx, cy), each
// glyph sized `glyphSize` and oriented tangentially (rotated to follow the circle), starting at
// `startAngle` and offset by the ring's own `rotation`. `pool` is a pre-generated glyph array;
// glyphs are picked from it in order with wraparound.
function drawGlyphRing(context, pool, cx, cy, radius, count, glyphSize, startAngle, rotation, color, lineWidth, lightFn) {
  for (let i = 0; i < count; i++) {
    const angle = startAngle + rotation + (i / count) * TAU;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    const tangential = angle + Math.PI / 2;
    const brightness = lightFn ? lightFn(angle) : 1;
    const finalColor = applyBrightness(color, brightness);
    drawHieroglyph(context, pool[i % pool.length], x, y, glyphSize, tangential, finalColor, lineWidth);
  }
}

// Scales an `rgba(r,g,b,a)` string's alpha by `brightness` (0..1); leaves other color formats
// (already-opaque or unrecognized) unchanged since the lighting mask is meant for glyph strokes.
function applyBrightness(color, brightness) {
  const match = /rgba?\(([^)]+)\)/.exec(color);
  if (!match) return color;
  const parts = match[1].split(',').map((s) => s.trim());
  const [r, g, b] = parts;
  const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
  return `rgba(${r},${g},${b},${(a * brightness).toFixed(3)})`;
}

// Draws a single Greek letter glyph, oriented tangentially, centered at (x, y). `weight` is an
// optional CSS font-weight (e.g. '700') for a bold, thick-stroke look.
function drawLetterGlyph(context, letter, x, y, size, angle, color, font, weight) {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.fillStyle = color;
  context.font = `${weight ? weight + ' ' : ''}${size}px ${font}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(letter, 0, 0);
  context.restore();
}

// One shared pool covers every fine glyph-text row (hieroglyph band, alphabet borders, paragraph
// ring, fisheye field) so they read as the same script at different scales.
const GLYPH_TEXT_POOL_SIZE = 96;
const GLYPH_TEXT_POOL = makeHieroglyphPool(GLYPH_TEXT_POOL_SIZE, 0x1a2b3c4d);

// Deterministically picks a run of glyphs for a text row of `count` glyphs starting at `offset`
// (kept distinct per ring so rows do not repeat identical sequences).
function glyphTextRun(count, offset) {
  return Array.from({ length: count }, (_, i) => GLYPH_TEXT_POOL[(i + offset) % GLYPH_TEXT_POOL.length]);
}
