// html-wallpaper-demo D6c: copied verbatim from docs/great-sage/background-idle/js/glyphs.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged.

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

// Draws one hieroglyph centered at (x, y), scaled to `size` (full box width/height), rotated by
// `angle` (radians) so it can be oriented tangentially to a ring.
function drawHieroglyph(context, strokes, x, y, size, angle, color, lineWidth) {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.scale(size, size);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = lineWidth / size;
  context.lineCap = 'round';
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

// Pre-generates `count` distinct hieroglyphs once; callers index into this pool (with wraparound)
// so every ring reuses the same deterministic shapes without regenerating them per draw call.
function makeHieroglyphPool(count, seedBase) {
  return Array.from({ length: count }, (_, i) => makeHieroglyph(i, seedBase));
}

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
