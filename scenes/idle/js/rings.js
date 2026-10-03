// html-wallpaper-demo D6c: copied verbatim from docs/great-sage/background-idle/js/rings.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged.

// rings.js — one draw function per ring (2 through 8) plus the shared reusable drawSpark, the
// bottom chromatic glow, and the vignette. Every ring function takes its own rotation angle (read
// from config.js, defaulting to 0) so a later animation can spin rings independently by changing
// only those angle values over time. All glyph content is generated once from seeded pools in
// glyphs.js; nothing here calls rnd() at draw time. Loads after config.js, math.js, glyphs.js,
// and earth.js.

// --- Ring 2: thin circle hugging the Earth --------------------------------------
function drawInnerRing(context, cx, cy, radius) {
  context.save();
  context.strokeStyle = INNER_RING_COLOR;
  context.lineWidth = INNER_RING_WIDTH;
  context.beginPath();
  context.arc(cx, cy, radius, 0, TAU);
  context.stroke();
  context.restore();
}

// --- Ring 3: constellation ring (dedicated ring with its own boundary lines) -----------------
// Real constellations, reduced to their main (brightest) stars. Each figure is a star list in an
// arbitrary x-right / y-down space plus the edges joining them by index — a graph, not a polyline,
// because figures such as Orion, Leo or the Sagittarius teapot branch and close loops. If the ring
// holds more figures than this table, the table repeats.
const CONSTELLATION_FIGURES = [
  { name: 'Ursa Major', // Big Dipper: Alkaid, Mizar, Alioth, Megrez, Phecda, Merak, Dubhe
    stars: [[0, 0], [1, 0.3], [2, 0.4], [3, 0.6], [3.2, 1.4], [4.4, 1.5], [4.5, 0.6]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]] },
  { name: 'Cassiopeia',
    stars: [[0, 0], [1, 1], [2, 0.4], [3, 1.1], [4, 0.1]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]] },
  { name: 'Orion', // Betelgeuse, Bellatrix, belt, Saiph, Rigel, Meissa
    stars: [[0, 0], [2, 0.2], [0.8, 1.6], [1.05, 1.5], [1.3, 1.4], [0.3, 3], [2.2, 2.8], [1, -0.6]],
    edges: [[0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6], [0, 7], [7, 1]] },
  { name: 'Cygnus', // Deneb, Sadr, Albireo, wings
    stars: [[0, 0], [0, 1], [0, 2.6], [-1.2, 0.7], [1.2, 1.2]],
    edges: [[0, 1], [1, 2], [3, 1], [1, 4]] },
  { name: 'Leo', // sickle from Regulus, triangle to Denebola
    stars: [[0, 2], [0, 1.2], [0.3, 0.5], [0, -0.2], [-0.5, -0.4], [-0.8, 0], [3.5, 1.6], [2.3, 0.8], [2.4, 1.7]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [2, 7], [7, 6], [6, 8], [8, 0]] },
  { name: 'Lyra', // Vega and its parallelogram
    stars: [[0, 0], [0.4, 0.8], [1.2, 0.9], [1.4, 2], [0.6, 1.9]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 1]] },
  { name: 'Scorpius', // claws fanning from Antares, curled tail down to Shaula
    stars: [[-1.2, -1], [-1.4, -0.3], [-1.3, 0.3], [0, 0], [0.4, 0.5], [0.8, 1.3], [0.9, 2.1], [0.8, 2.8], [1.2, 3.4], [1.9, 3.6], [2.5, 3], [2, 2.6]],
    edges: [[0, 1], [1, 2], [1, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11]] },
  { name: 'Gemini', // Castor and Pollux heading two parallel twins
    stars: [[0, 0], [1, 0.1], [0.2, 1.2], [1.3, 1.3], [0.5, 2.4], [1.5, 2.3], [0.7, 3.3], [1.9, 3.3]],
    edges: [[0, 1], [0, 2], [2, 4], [4, 6], [1, 3], [3, 5], [5, 7], [2, 3]] },
  { name: 'Pegasus', // Great Square plus Enif's neck and a foreleg
    stars: [[0, 1], [0, 0], [1.4, -0.1], [1.4, 1.1], [-0.8, 1.5], [-1.9, 1.7], [-1, -0.3], [-1.8, 0]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [4, 5], [1, 6], [6, 7]] },
  { name: 'Taurus', // Hyades V with Aldebaran, horns out to Elnath and zeta
    stars: [[0, 0], [-0.9, -0.4], [-2.5, -1.2], [-0.6, -0.9], [-1.8, -2.2], [1, 0.6], [1.8, 0.3]],
    edges: [[0, 1], [1, 2], [0, 3], [3, 4], [0, 5], [5, 6]] },
  { name: 'Ursa Minor', // Little Dipper from Polaris to Kochab and Pherkad
    stars: [[0, 0], [0.7, 0.2], [1.3, 0.5], [1.7, 1], [2.6, 0.9], [2.5, 1.6], [1.6, 1.6]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]] },
  { name: 'Perseus', // Mirfak's arc and Algol
    stars: [[0, 0], [0.4, 0.6], [0.6, 1.4], [0.3, 2.2], [-0.3, -0.5], [-0.6, -1.1], [-0.9, 0.6], [-1.1, 1.2]],
    edges: [[1, 0], [0, 4], [4, 5], [1, 2], [2, 3], [0, 6], [6, 7]] },
  { name: 'Sagittarius', // the teapot: lid, body, handle, spout
    stars: [[0, 1.4], [0.1, 0.6], [0.8, 0.2], [1.3, 0.7], [2, 0.5], [2, 1.2], [1.2, 1.4], [-0.7, 0.9]],
    edges: [[1, 2], [2, 3], [1, 3], [3, 6], [6, 0], [0, 1], [3, 4], [4, 5], [5, 6], [0, 7], [7, 1]] },
  { name: 'Andromeda', // Alpheratz, Mirach, Almach and the mu-nu branch
    stars: [[0, 0], [0.9, 0.3], [1.9, 0.5], [3.1, 0.5], [1.8, -0.3], [1.7, -0.9]],
    edges: [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5]] },
  { name: 'Draco', // head quadrilateral, body winding past Thuban
    stars: [[0, 0], [0.5, -0.3], [0.8, 0.2], [0.4, 0.5], [0.2, 1.4], [1.2, 2], [2.2, 1.6], [2.8, 0.8], [3.4, 0.2], [3.6, 1.3], [4.4, 1.8], [5.2, 1.4]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11]] },
  { name: 'Aries', // Hamal, Sheratan, Mesarthim, 41 Arietis
    stars: [[-0.6, -0.9], [0, 0], [0.9, 0.4], [1.05, 0.7]],
    edges: [[0, 1], [1, 2], [2, 3]] },
];

// Each figure's stars are normalized here (once, at module load) so its actual bounding box is
// centered at the origin and scaled to fill exactly CONSTELLATION_FIGURE_MARGIN of a unit box —
// guaranteeing that once it is placed at the ring's mid-radius and scaled by the ring's own
// thickness, it can never cross either boundary, including at the left/right sides where earlier
// passes let it touch the neighboring band.
function makeConstellations(count, seedBase) {
  return Array.from({ length: count }, (_, index) => {
    const random = mulberry32((seedBase + index * 0x85ebca6b) >>> 0);
    const figure = CONSTELLATION_FIGURES[index % CONSTELLATION_FIGURES.length];
    const rawPoints = figure.stars;

    const xs = rawPoints.map((p) => p[0]);
    const ys = rawPoints.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const boxCenterX = (minX + maxX) / 2;
    const boxCenterY = (minY + maxY) / 2;
    const boxSpan = Math.max(maxX - minX, maxY - minY, 1e-6); // avoid divide-by-zero for degenerate figures
    const scale = CONSTELLATION_FIGURE_MARGIN / boxSpan;
    const points = rawPoints.map(([x, y]) => [(x - boxCenterX) * scale, (y - boxCenterY) * scale]);

    // IDL-16: per-edge hand-drawn "brush" stroke parameters, drawn from the figure's own seeded
    // RNG stream, so the brush look stays deterministic from one seed with no live Math.random anywhere. One entry per figure edge —
    // see drawBrushStroke below for how each field is used.
    const segments = figure.edges.map(([from, to]) => ({
      from,
      to,
      wobbleAmp: (random() - 0.5) * 2 * CONSTELLATION_BRUSH_WOBBLE_AMPLITUDE,
      wobblePhaseWeight: random() * CONSTELLATION_BRUSH_WOBBLE_HARMONIC_WEIGHT,
      widthJitter: CONSTELLATION_BRUSH_WIDTH_JITTER_MIN + random() * (CONSTELLATION_BRUSH_WIDTH_JITTER_MAX - CONSTELLATION_BRUSH_WIDTH_JITTER_MIN),
      bristles: Array.from({ length: CONSTELLATION_BRUSH_BRISTLE_COUNT }, (_, b) => ({
        sign: b % 2 === 0 ? 1 : -1, // alternate sides deterministically; no extra RNG call needed for this
        wobblePhaseWeight: random() * CONSTELLATION_BRUSH_WOBBLE_HARMONIC_WEIGHT,
        widthJitter: CONSTELLATION_BRUSH_WIDTH_JITTER_MIN + random() * (CONSTELLATION_BRUSH_WIDTH_JITTER_MAX - CONSTELLATION_BRUSH_WIDTH_JITTER_MIN),
      })),
    }));

    return { points, segments };
  });
}
const CONSTELLATION_POOL = makeConstellations(CONSTELLATION_COUNT, 0x2c3e50a1);

// Fills one tapered, gently-wobbling "brush" stroke between two points (used for every
// constellation edge: the main stroke and its faint offset "bristle" copies). Coordinates are in
// the caller's already-scaled local space (see drawConstellationRing: translate/rotate/scale(boxSize)
// is already applied), so `peakHalfWidth` etc. are all in that same local-unit space.
// `lateralOffset` shifts the whole curve sideways by a fixed local-unit amount, used to place
// bristle strokes alongside the main one; like the wobble itself, it fades to 0 at both ends via
// the same single "hump" (sin(u*PI)), so a bristle still converges on the shared star point at
// each end instead of floating free of the figure — 0 for the main stroke.
function drawBrushStroke(context, x0, y0, x1, y1, peakHalfWidth, wobbleAmp, wobblePhaseWeight, lateralOffset, color) {
  const dx = x1 - x0, dy = y1 - y0;
  const length = Math.hypot(dx, dy) || 1e-6;
  const ux = dx / length, uy = dy / length;
  const nx = -uy, ny = ux; // left-hand perpendicular unit vector
  const segments = CONSTELLATION_BRUSH_SEGMENTS;
  const left = [];
  const right = [];
  for (let s = 0; s <= segments; s++) {
    const u = s / segments;
    // Single-hump wobble/offset (0 at both ends, peak at the middle) so every edge still meets its
    // neighbors exactly at the shared star point — the figure stays connected — while the body of
    // the stroke bows organically instead of running dead straight. The lighter second harmonic
    // (wobblePhaseWeight) breaks the hump's left/right symmetry for a less mechanical curve.
    const hump = Math.sin(u * Math.PI);
    const lateral = (wobbleAmp * length + lateralOffset) * hump * (1 + wobblePhaseWeight * Math.sin(u * TAU));
    const px = x0 + ux * length * u + nx * lateral;
    const py = y0 + uy * length * u + ny * lateral;
    // Ink-brush taper: thin at both tips (never fully to zero, so the stroke stays visible right up
    // to the star it connects to), thick through the middle.
    const taper = CONSTELLATION_BRUSH_TAPER_MIN_FRACTION + (1 - CONSTELLATION_BRUSH_TAPER_MIN_FRACTION) * hump;
    const halfWidth = peakHalfWidth * taper;
    left.push([px + nx * halfWidth, py + ny * halfWidth]);
    right.push([px - nx * halfWidth, py - ny * halfWidth]);
  }
  context.beginPath();
  context.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < left.length; i++) context.lineTo(left[i][0], left[i][1]);
  for (let i = right.length - 1; i >= 0; i--) context.lineTo(right[i][0], right[i][1]);
  context.closePath();
  context.fillStyle = color;
  context.fill();
}

// mini-scene-window T2g/T2h: absolute px sizes (CONSTELLATION_DOT_RADIUS, CONSTELLATION_LINE_WIDTH, and the
// hieroglyph band's HIEROGLYPH_STROKE_PX) are tuned on the real screen (3440x1440: the maintainer's monitor;
// sceneBasis is ~877 there and at any 1440-tall screen), where the constellation ring is ~63px thick. The
// ?variant=mini window draws the same rings about 6x smaller (ratio ~0.17 at 288px), so the same px made the
// dots blobs and the glyph strokes dense hatching. In mini each is scaled by (that ring's thickness) / (its
// thickness in the full scene at that reference screen), never below MINI_CONSTELLATION_MIN_PX. The full
// variant returns the tunables untouched. These rings are baked into the ring cache (buildRingCaches), so the
// cache picks the mini sizes up automatically. isMiniVariant comes from shared/js/render-loop.js (resolved
// at call time).
const MINI_CONSTELLATION_REFERENCE_SCREEN = { width: 3440, height: 1440 };
const MINI_CONSTELLATION_MIN_PX = 0.5;

// `box` is the ring's thickness in px; `thicknessFraction` is that ring's thickness as a fraction of the basis.
function miniDetailRatio(box, thicknessFraction) {
  const referenceBox = thicknessFraction *
    sceneBasis(MINI_CONSTELLATION_REFERENCE_SCREEN.width, MINI_CONSTELLATION_REFERENCE_SCREEN.height);
  return box / referenceBox;
}

// `px` unchanged in the full variant; scaled by the mini ratio (with the floor) in mini.
function miniDetailPx(px, box, thicknessFraction) {
  if (!isMiniVariant) return px;
  return Math.max(MINI_CONSTELLATION_MIN_PX, px * miniDetailRatio(box, thicknessFraction));
}

function constellationDetailSizes(boxSize) {
  const fraction = CONSTELLATION_RING_OUTER_RADIUS_FRACTION - CONSTELLATION_RING_INNER_RADIUS_FRACTION;
  return {
    dotRadius: miniDetailPx(CONSTELLATION_DOT_RADIUS, boxSize, fraction),
    lineWidth: miniDetailPx(CONSTELLATION_LINE_WIDTH, boxSize, fraction),
  };
}

function drawConstellationRing(context, cx, cy, innerRadius, outerRadius, rotation) {
  const midRadius = (innerRadius + outerRadius) / 2;
  const boxSize = outerRadius - innerRadius; // each normalized figure fills exactly this thickness at most
  const detail = constellationDetailSizes(boxSize);
  for (let i = 0; i < CONSTELLATION_COUNT; i++) {
    const angle = rotation + (i / CONSTELLATION_COUNT) * TAU;
    const x = cx + Math.cos(angle) * midRadius;
    const y = cy + Math.sin(angle) * midRadius;
    const tangential = angle + Math.PI / 2;
    const brightness = verticalLightBrightness(angle);
    const lineColor = applyBrightness(CONSTELLATION_LINE_COLOR, brightness);
    const dotColor = applyBrightness(CONSTELLATION_DOT_COLOR, brightness);
    const bristleColor = applyBrightness(CONSTELLATION_LINE_COLOR, brightness * CONSTELLATION_BRUSH_BRISTLE_ALPHA);
    const { points, segments } = CONSTELLATION_POOL[i];

    context.save();
    context.translate(x, y);
    context.rotate(tangential);
    context.scale(boxSize, boxSize);
    const peakHalfWidth = (detail.lineWidth / boxSize) / 2;
    for (const seg of segments) {
      const [x0, y0] = points[seg.from];
      const [x1, y1] = points[seg.to];
      drawBrushStroke(context, x0, y0, x1, y1, peakHalfWidth * seg.widthJitter, seg.wobbleAmp, seg.wobblePhaseWeight, 0, lineColor);
      for (const bristle of seg.bristles) {
        const bristleOffset = bristle.sign * CONSTELLATION_BRUSH_BRISTLE_OFFSET_FRACTION * peakHalfWidth * 2;
        drawBrushStroke(
          context, x0, y0, x1, y1,
          peakHalfWidth * bristle.widthJitter * CONSTELLATION_BRUSH_BRISTLE_WIDTH_SCALE,
          seg.wobbleAmp, bristle.wobblePhaseWeight, bristleOffset, bristleColor
        );
      }
    }
    context.fillStyle = dotColor;
    for (const [px, py] of points) {
      context.beginPath();
      context.arc(px, py, detail.dotRadius / boxSize, 0, TAU);
      context.fill();
    }
    context.restore();
  }

  // Thin circular boundary lines enclosing the dedicated constellation ring, brightness-shaded
  // like the hieroglyph band's enclosing lines.
  const segmentCount = 96;
  context.save();
  context.lineWidth = 1;
  for (const outlineRadius of [innerRadius, outerRadius]) {
    for (let s = 0; s < segmentCount; s++) {
      const a0 = rotation + (s / segmentCount) * TAU;
      const a1 = rotation + ((s + 1) / segmentCount) * TAU;
      const segmentBrightness = verticalLightBrightness((a0 + a1) / 2);
      if (segmentBrightness <= 0.001) continue;
      context.strokeStyle = applyBrightness(CONSTELLATION_BOUNDARY_COLOR, segmentBrightness);
      context.beginPath();
      context.arc(cx, cy, outlineRadius, a0, a1);
      context.stroke();
    }
  }
  context.restore();
}

// --- Ring 4: hieroglyph band (two rows of bold small glyphs, enclosed by thin circular lines,
// with short radial dividers boxing small groups) -------------------------------------------
// The hieroglyph band's glyph stroke width in px (full: 1.6; mini: scaled with the band, see miniDetailPx above).
const HIEROGLYPH_STROKE_PX = 1.6;

function drawHieroglyphBand(context, cx, cy, innerRadius, outerRadius, rotation) {
  const bandThickness = outerRadius - innerRadius;
  // Rows sit evenly inside the band, each with margin to the inner/outer enclosing lines.
  const rowGap = bandThickness / (HIEROGLYPH_BAND_ROW_COUNT + 1);
  const glyphSize = rowGap * 0.72; // bold, small glyphs sized to fill most of their row
  const glyphStrokePx = miniDetailPx(HIEROGLYPH_STROKE_PX, bandThickness,
    HIEROGLYPH_BAND_OUTER_RADIUS_FRACTION - HIEROGLYPH_BAND_INNER_RADIUS_FRACTION);
  for (let row = 0; row < HIEROGLYPH_BAND_ROW_COUNT; row++) {
    const radius = innerRadius + rowGap * (row + 1);
    const pool = glyphTextRun(HIEROGLYPH_GLYPH_COUNT, row * 37);
    for (let i = 0; i < HIEROGLYPH_GLYPH_COUNT; i++) {
      const angle = rotation + (i / HIEROGLYPH_GLYPH_COUNT) * TAU;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const tangential = angle + Math.PI / 2;
      const brightness = verticalLightBrightness(angle);
      const color = applyBrightness(HIEROGLYPH_GLYPH_COLOR, brightness);
      drawHieroglyph(context, pool[i], x, y, glyphSize, tangential, color, glyphStrokePx);
    }
  }

  // Short radial dividers spanning the full band thickness, boxing small groups of glyphs.
  for (let i = 0; i < HIEROGLYPH_GLYPH_COUNT; i += HIEROGLYPH_DIVIDER_EVERY) {
    const angle = rotation + (i / HIEROGLYPH_GLYPH_COUNT) * TAU - (Math.PI / HIEROGLYPH_GLYPH_COUNT);
    const brightness = verticalLightBrightness(angle);
    if (brightness <= 0.001) continue;
    const dividerColor = applyBrightness(HIEROGLYPH_DIVIDER_COLOR, brightness);
    const x1 = cx + Math.cos(angle) * innerRadius;
    const y1 = cy + Math.sin(angle) * innerRadius;
    const x2 = cx + Math.cos(angle) * outerRadius;
    const y2 = cy + Math.sin(angle) * outerRadius;
    context.save();
    context.strokeStyle = dividerColor;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
    context.restore();
  }

  // Thin circular lines enclosing the band on both the inner and outer edge, drawn as many short
  // arc segments so each segment carries its own top-lit brightness like the glyphs.
  const segmentCount = 96;
  context.save();
  context.lineWidth = 1;
  for (const outlineRadius of [innerRadius, outerRadius]) {
    for (let s = 0; s < segmentCount; s++) {
      const a0 = rotation + (s / segmentCount) * TAU;
      const a1 = rotation + ((s + 1) / segmentCount) * TAU;
      const brightness = verticalLightBrightness((a0 + a1) / 2);
      if (brightness <= 0.001) continue;
      context.strokeStyle = applyBrightness(HIEROGLYPH_DIVIDER_COLOR, brightness);
      context.beginPath();
      context.arc(cx, cy, outlineRadius, a0, a1);
      context.stroke();
    }
  }
  context.restore();
}

// --- Ring 5: alphabet ring --------------------------------------------------------
const ALPHABET_LETTER_POOL = Array.from({ length: ALPHABET_CELL_COUNT }, (_, i) => {
  const useLowercase = i % 3 === 2; // mix in some lowercase, deterministically
  const letters = useLowercase ? GREEK_LOWERCASE : GREEK_UPPERCASE;
  return letters[i % letters.length];
});
// Irregular (not strictly alternating) white/black pattern, seeded once so it stays fixed.
const ALPHABET_CELL_IS_WHITE = (() => {
  const random = mulberry32(0x77aa11cc);
  let previous = null;
  return Array.from({ length: ALPHABET_CELL_COUNT }, () => {
    // Bias against repeating the same color 3+ times in a row, while still reading as irregular.
    const forceFlip = previous !== null && random() < 0.15;
    const isWhite = forceFlip ? !previous : random() < 0.5;
    previous = isWhite;
    return isWhite;
  });
})();

function drawAlphabetRing(context, cx, cy, innerRadius, outerRadius, rotation) {
  const midRadius = (innerRadius + outerRadius) / 2;
  const thickness = outerRadius - innerRadius;
  const cellAngle = TAU / ALPHABET_CELL_COUNT;

  for (let i = 0; i < ALPHABET_CELL_COUNT; i++) {
    const startAngle = rotation + i * cellAngle + ALPHABET_CELL_GAP_RADIANS / 2;
    const endAngle = rotation + (i + 1) * cellAngle - ALPHABET_CELL_GAP_RADIANS / 2;
    const midAngle = (startAngle + endAngle) / 2;
    const isWhite = ALPHABET_CELL_IS_WHITE[i];
    const brightness = verticalLightBrightness(midAngle);

    context.save();
    context.beginPath();
    context.arc(cx, cy, outerRadius, startAngle, endAngle);
    context.arc(cx, cy, innerRadius, endAngle, startAngle, true);
    context.closePath();
    context.fillStyle = applyBrightness(isWhite ? ALPHABET_WHITE_CELL_COLOR : ALPHABET_BLACK_CELL_COLOR, brightness);
    context.fill();
    context.restore();

    const letterColor = applyBrightness(isWhite ? ALPHABET_LETTER_ON_WHITE_COLOR : ALPHABET_LETTER_ON_BLACK_COLOR, brightness);
    const x = cx + Math.cos(midAngle) * midRadius;
    const y = cy + Math.sin(midAngle) * midRadius;
    const tangential = midAngle + Math.PI / 2;
    drawLetterGlyph(context, ALPHABET_LETTER_POOL[i], x, y, thickness * ALPHABET_LETTER_SIZE_FRACTION, tangential, letterColor, ALPHABET_LETTER_FONT, ALPHABET_LETTER_WEIGHT);
  }
  // IDL-6: the inner/outer border glyph-text rows are intentionally removed — each cell shows
  // only its letter now.
}

// --- Ring 6: ruler ring: measuring-ruler pattern (major ticks with numeral labels, 4 minors
// between each pair of majors) -----------------------------------------------------------------
// One deterministic "numeral" glyph per major-tick index (0, 1, 2, ... one per RULER_LONG_TICK_EVERY
// step around the ring), reusing the hieroglyph stroke generator so each value reads as a
// distinct, consistent symbol without needing real digits.
const RULER_MAJOR_TICK_COUNT = Math.ceil(RULER_TICK_COUNT / RULER_LONG_TICK_EVERY);
const RULER_NUMERAL_POOL = makeHieroglyphPool(RULER_MAJOR_TICK_COUNT, 0x00c0ffee);

function drawRulerRing(context, cx, cy, radius, rotation) {
  const basis = sceneBasis(W, H);
  const shortLength = RULER_TICK_LENGTH_SHORT_FRACTION * basis;
  const longLength = RULER_TICK_LENGTH_LONG_FRACTION * basis;
  const labelSize = RULER_LABEL_SIZE_FRACTION * basis;
  const labelGap = RULER_LABEL_GAP_FRACTION * basis;

  for (let i = 0; i < RULER_TICK_COUNT; i++) {
    const angle = rotation + (i / RULER_TICK_COUNT) * TAU;
    const isMajor = i % RULER_LONG_TICK_EVERY === 0;
    const length = isMajor ? longLength : shortLength;
    const brightness = verticalLightBrightness(angle);
    const tickColor = applyBrightness(RULER_TICK_COLOR, brightness);
    const x1 = cx + Math.cos(angle) * radius;
    const y1 = cy + Math.sin(angle) * radius;
    const x2 = cx + Math.cos(angle) * (radius + length);
    const y2 = cy + Math.sin(angle) * (radius + length);
    context.save();
    context.strokeStyle = tickColor;
    context.lineWidth = RULER_TICK_WIDTH;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
    context.restore();

    if (isMajor && brightness > 0.001) {
      const labelColor = applyBrightness(RULER_LABEL_COLOR, brightness);
      const labelRadius = radius + length + labelGap;
      const lx = cx + Math.cos(angle) * labelRadius;
      const ly = cy + Math.sin(angle) * labelRadius;
      const tangential = angle + Math.PI / 2;
      const numeral = RULER_NUMERAL_POOL[(i / RULER_LONG_TICK_EVERY) % RULER_NUMERAL_POOL.length];
      drawHieroglyph(context, numeral, lx, ly, labelSize, tangential, labelColor, 2.2);
    }
  }
}

// --- Ring 7: paragraph ring ----------------------------------------------------------
function drawParagraphRing(context, cx, cy, innerRadius, rotation) {
  const rowGap = PARAGRAPH_ROW_GAP_FRACTION * sceneBasis(W, H);
  // IDL-11: glyphSize shrunk slightly (0.72 -> PARAGRAPH_GLYPH_SIZE_FRACTION_OF_ROW_GAP, see
  // config.js) so each glyph keeps a clearer margin inside its row slot, and the band now draws
  // explicit thin boundary lines (below) so it reads as clearly delimited like the other rings.
  const glyphSize = rowGap * PARAGRAPH_GLYPH_SIZE_FRACTION_OF_ROW_GAP;
  for (let row = 0; row < PARAGRAPH_RING_ROW_COUNT; row++) {
    const radius = innerRadius + row * rowGap;
    const pool = glyphTextRun(PARAGRAPH_GLYPH_COUNT, row * 71 + 5);
    for (let i = 0; i < PARAGRAPH_GLYPH_COUNT; i++) {
      const angle = rotation + (i / PARAGRAPH_GLYPH_COUNT) * TAU;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const tangential = angle + Math.PI / 2;
      const brightness = verticalLightBrightness(angle);
      const color = applyBrightness(PARAGRAPH_GLYPH_COLOR, brightness);
      drawHieroglyph(context, pool[i], x, y, glyphSize, tangential, color, 1);
    }
  }

  // Thin circular boundary lines enclosing the band at its true inner/outer edge (matches
  // PARAGRAPH_CACHE_INNER/OUTER_RADIUS_FRACTION in config.js), same technique as the other rings.
  const bandInnerRadius = innerRadius - rowGap * PARAGRAPH_BAND_MARGIN_FRACTION_OF_ROW_GAP;
  const bandOuterRadius = innerRadius + rowGap * (PARAGRAPH_RING_ROW_COUNT - 1) + rowGap * PARAGRAPH_BAND_MARGIN_FRACTION_OF_ROW_GAP;
  const segmentCount = 128;
  context.save();
  context.lineWidth = 1;
  for (const outlineRadius of [bandInnerRadius, bandOuterRadius]) {
    for (let s = 0; s < segmentCount; s++) {
      const a0 = rotation + (s / segmentCount) * TAU;
      const a1 = rotation + ((s + 1) / segmentCount) * TAU;
      const segmentBrightness = verticalLightBrightness((a0 + a1) / 2);
      if (segmentBrightness <= 0.001) continue;
      context.strokeStyle = applyBrightness(PARAGRAPH_GLYPH_COLOR, segmentBrightness);
      context.beginPath();
      context.arc(cx, cy, outlineRadius, a0, a1);
      context.stroke();
    }
  }
  context.restore();
}

// --- Ring 8a: outer glyph ring -----------------------------------------------------------------
// One normal ring of glyph text just outside the paragraph ring, only mildly stretched radially
// (OUTER_GLYPH_RADIAL_STRETCH, far below the old per-ring fisheye growth) — reads as a plain
// glyph band, not a fisheye/tunnel effect. Fixed size regardless of viewport aspect ratio, so it
// stays proportionate on ultrawide screens instead of ballooning to fill unused width/height.
function drawOuterGlyphRing(context, cx, cy, innerRadius, rotation) {
  const basis = sceneBasis(W, H);
  const thickness = OUTER_GLYPH_RING_THICKNESS_FRACTION * basis;
  const outerRadius = innerRadius + thickness;
  const radius = innerRadius + thickness / 2;
  // IDL-11: glyphSize is now derived so the glyph's true (stretch-scaled) radial extent fits
  // inside the band with margin (see config.js OUTER_GLYPH_SIZE_FRACTION_OF_THICKNESS) — this
  // replaces the old thickness*0.85 constant, which overflowed the band by ~22% radially.
  const glyphSize = thickness * OUTER_GLYPH_SIZE_FRACTION_OF_THICKNESS;
  const pool = glyphTextRun(OUTER_GLYPH_COUNT, 17);

  for (let i = 0; i < OUTER_GLYPH_COUNT; i++) {
    const angle = rotation + (i / OUTER_GLYPH_COUNT) * TAU;
    const brightness = verticalLightBrightness(angle);
    if (brightness <= 0.001) continue;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    const tangential = angle + Math.PI / 2;
    const color = applyBrightness(OUTER_GLYPH_COLOR, brightness);

    context.save();
    context.translate(x, y);
    context.rotate(tangential);
    context.scale(glyphSize, glyphSize * OUTER_GLYPH_RADIAL_STRETCH);
    drawStrokesOnly(context, pool[i], 0, 0, color);
    context.restore();
  }

  // Thin circular boundary lines enclosing the band, same brightness-shaded-segment technique as
  // the constellation ring and hieroglyph band, so the band reads as clearly delimited.
  const segmentCount = 128;
  context.save();
  context.lineWidth = 1;
  for (const outlineRadius of [innerRadius, outerRadius]) {
    for (let s = 0; s < segmentCount; s++) {
      const a0 = rotation + (s / segmentCount) * TAU;
      const a1 = rotation + ((s + 1) / segmentCount) * TAU;
      const segmentBrightness = verticalLightBrightness((a0 + a1) / 2);
      if (segmentBrightness <= 0.001) continue;
      context.strokeStyle = applyBrightness(OUTER_GLYPH_BOUNDARY_COLOR, segmentBrightness);
      context.beginPath();
      context.arc(cx, cy, outlineRadius, a0, a1);
      context.stroke();
    }
  }
  context.restore();
}

// Draws a hieroglyph's strokes directly in the current (already transformed) context space,
// offset by (ox, oy) in local units.
function drawStrokesOnly(context, strokes, ox, oy, color) {
  context.save();
  context.translate(ox, oy);
  context.strokeStyle = color;
  context.fillStyle = color;
  // GLYPH_STROKE_HALF_WIDTH_LOCAL (config.js) is the single source of truth for this local stroke
  // width and the dot draw radius below; do not hand-copy either value here.
  context.lineWidth = 2 * GLYPH_STROKE_HALF_WIDTH_LOCAL;
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

// --- Stone disc border: solid edge line + a slightly lighter rim band, just outside the outer
// glyph ring, so the whole ring system reads as one circular stone disc. Top-lit like every
// other ring; drawn as many brightness-shaded arc segments, same technique as the other
// enclosing boundary lines.
// Linux mini optimization begin (O1): the border is screen-fixed, so on the scene canvas it is painted
// once per geometry into a device-aligned static layer (drawStaticLayer below) and stamped with one
// drawImage per frame, instead of 128 fill+stroke segments every frame. paintDiscBorder is the reference
// drawDiscBorder body, unchanged.
const discBorderLayer = createStaticLayer();

function drawDiscBorder(context, cx, cy, innerRadius, outerRadius) {
  const extent = outerRadius + 2; // the 1.5px edge stroke reaches 0.75px past outerRadius, plus anti-aliasing
  drawStaticLayer(context, discBorderLayer, `${cx},${cy},${innerRadius},${outerRadius}`,
    cx - extent, cy - extent, cx + extent, cy + extent,
    (layerContext) => paintDiscBorder(layerContext, cx, cy, innerRadius, outerRadius));
}
// Linux mini optimization end.

function paintDiscBorder(context, cx, cy, innerRadius, outerRadius) {
  const segmentCount = 128;
  context.save();
  for (let s = 0; s < segmentCount; s++) {
    const a0 = (s / segmentCount) * TAU;
    const a1 = ((s + 1) / segmentCount) * TAU;
    const brightness = verticalLightBrightness((a0 + a1) / 2);
    if (brightness <= 0.001) continue;

    // The slightly lighter rim band fill.
    context.beginPath();
    context.arc(cx, cy, outerRadius, a0, a1);
    context.arc(cx, cy, innerRadius, a1, a0, true);
    context.closePath();
    context.fillStyle = applyBrightness(DISC_BORDER_RIM_COLOR, brightness);
    context.fill();

    // The solid edge line at the outermost radius.
    context.strokeStyle = applyBrightness(DISC_BORDER_EDGE_COLOR, brightness);
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(cx, cy, outerRadius, a0, a1);
    context.stroke();
  }
  context.restore();
}

// Linux mini optimization begin (O1): device-aligned static layers for screen-fixed vector art.
// The layer's backing store covers [left, right] x [top, bottom] in whole device pixels and paints
// with the scene canvas's own base transform shifted by that whole-pixel origin, so every path lands
// on the same device coordinates (same rasterization); it is then drawn 1:1 under the identity
// transform. Over a transparent destination (the mini canvas under the disc border) this is
// pixel-identical; over already-drawn pixels source-over is associative, so only 8-bit rounding
// (<= 1/255 per channel) can differ. Only the scene canvas at its base transform (canvasScaleX/Y,
// set by resize() and resetCanvasStateForFrame) is eligible; any other context paints directly.
function createStaticLayer() {
  return { key: null, canvas: null, x: 0, y: 0 };
}

function drawStaticLayer(context, layer, key, left, top, right, bottom, paint) {
  if (context !== ctx) {
    paint(context);
    return;
  }
  const sx = canvasScaleX, sy = canvasScaleY;
  const fullKey = `${key}|${sx}|${sy}`;
  if (layer.key !== fullKey) {
    const x0 = Math.floor(left * sx), y0 = Math.floor(top * sy);
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = Math.max(1, Math.ceil(right * sx) - x0);
    layerCanvas.height = Math.max(1, Math.ceil(bottom * sy) - y0);
    const layerContext = layerCanvas.getContext('2d');
    layerContext.setTransform(sx, 0, 0, sy, -x0, -y0);
    paint(layerContext);
    layer.key = fullKey;
    layer.canvas = layerCanvas;
    layer.x = x0;
    layer.y = y0;
  }
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.drawImage(layer.canvas, layer.x, layer.y);
  context.restore();
}
// Linux mini optimization end.

// --- Ring 8b: deep-space starfield --------------------------------------------------------------
// Sparse, deterministic distant stars filling the rest of the screen beyond the outer glyph ring,
// out to the corners on any aspect ratio (including ultrawide). Positions are generated once in
// normalized angle space; the same seeded field covers 16:9 and ultrawide viewports alike without
// visibly thinning out at the sides.
// IDL-11: each star now also drifts radially outward over time ("travelling through space"),
// deterministically and periodically — see STARFIELD_DRIFT_* in config.js. `phase` and
// `speedJitter` are fixed per star at generation time (seeded), never re-randomized per frame.
function makeStarfield(count, seedBase) {
  const random = mulberry32(seedBase);
  return Array.from({ length: count }, () => ({
    angle: random() * TAU,
    // Starting point in the travel cycle, uniform in [0, 1) so stars are already spread across
    // every depth at t=0 instead of all emerging from the disc border together.
    phase: random(),
    speedJitter: STARFIELD_DRIFT_SPEED_JITTER_MIN + random() * (STARFIELD_DRIFT_SPEED_JITTER_MAX - STARFIELD_DRIFT_SPEED_JITTER_MIN),
    baseAlpha: STARFIELD_MIN_ALPHA + random() * (STARFIELD_MAX_ALPHA - STARFIELD_MIN_ALPHA),
    twinklePhase: random() * TAU, // per-star offset so twinkle (if enabled) does not pulse in lockstep
  }));
}
const STARFIELD_POOL = makeStarfield(STARFIELD_COUNT, 0x57a2f1e1d);

// `timeSeconds` defaults to 0 (all stars at their seeded starting phase) when omitted, so a static
// single-frame render (no animation loop) still draws a full, reasonable-looking field.
function drawStarfield(context, cx, cy, innerRadius, timeSeconds) {
  const t = typeof timeSeconds === 'number' ? timeSeconds : 0;
  const maxRadius = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
  const travelSpan = Math.max(1, maxRadius - innerRadius);
  const twinkle = STARFIELD_TWINKLE_AMPLITUDE > 0;
  for (const star of STARFIELD_POOL) {
    // Deterministic periodic depth position: f((t*speed + phase) mod 1) as requested — each star's
    // own speedJitter is fixed (seeded), not re-rolled per frame, so this is fully reproducible
    // from `t` alone. radialT=0 is just beyond the disc border (far, dim, small); radialT=1 is at
    // the screen's far corner (near, bright, large); a star wraps back to radialT=0 the instant it
    // would go past 1, so it never draws inside the disc border and a new one keeps emerging.
    const cycles = t / STARFIELD_DRIFT_PERIOD_SECONDS * star.speedJitter + star.phase;
    const radialT = cycles - Math.floor(cycles); // fract(); always in [0, 1)
    const radius = innerRadius + radialT * travelSpan;
    const x = cx + Math.cos(star.angle) * radius;
    const y = cy + Math.sin(star.angle) * radius;
    if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
    const brightness = verticalLightBrightness(star.angle);
    // Grows slightly brighter/larger as it approaches (radialT -> 1), same easing for both.
    const depthGrowth = smoothstep(0, 1, radialT);
    const size = mix(STARFIELD_MIN_SIZE, STARFIELD_MAX_SIZE, depthGrowth);
    let starAlpha = star.baseAlpha * mix(0.6, 1, depthGrowth);
    // Fade in from radialT=0 (just past the border) and fade out approaching radialT=1 (screen
    // edge) so stars emerge/leave softly instead of popping in/out at the travel boundaries.
    const edgeFade = Math.min(smoothstep(0, 0.06, radialT), 1 - smoothstep(0.92, 1, radialT));
    starAlpha *= edgeFade;
    if (twinkle) {
      const phase = (t / STARFIELD_TWINKLE_PERIOD_SECONDS) * TAU + star.twinklePhase;
      starAlpha *= 1 + STARFIELD_TWINKLE_AMPLITUDE * Math.sin(phase);
    }
    // IDL-13: raised from 0.35 on user request ("stars should read brighter") — this was the
    // biggest remaining dimming factor on the dark lower half of the scene (the same top-lit
    // brightness curve the rings use), pulling star alpha down to ~35% of its already-computed
    // value there; 0.6 keeps the top/bottom brightness relationship (top still clearly brighter)
    // while no longer crushing stars near the bottom almost to invisibility.
    const alpha = clamp01(starAlpha) * mix(0.6, 1, brightness); // stars stay clearly visible even low down, unlike the rings
    if (alpha <= 0.002) continue;
    // IDL-13: a cheap soft glow (one extra low-alpha, larger, solid-fill circle drawn under the
    // star's own core — no gradient allocation, so this stays cheap for all 420 stars every
    // frame) on the near/bright half of the depth cycle, so the brighter/larger stars now also
    // read with a subtle bloom instead of just a bigger flat dot.
    if (depthGrowth > 0.55) {
      const haloAlpha = alpha * 0.35 * smoothstep(0.55, 1, depthGrowth);
      if (haloAlpha > 0.01) {
        context.beginPath();
        context.arc(x, y, size * 2.2, 0, TAU);
        context.fillStyle = `rgba(${STARFIELD_COLOR},${haloAlpha.toFixed(3)})`;
        context.fill();
      }
    }
    context.beginPath();
    context.arc(x, y, size, 0, TAU);
    context.fillStyle = `rgba(${STARFIELD_COLOR},${alpha.toFixed(3)})`;
    context.fill();
  }
}

// --- Bottom spark, chromatic glow, vignette -----------------------------------------------

// Reusable bright point-light glint: a soft radial core plus four thin fading rays. `intensity`
// (0..1+) scales both the core and ray brightness/alpha so a future animation can fade a spark in
// and out (or drive several at once, e.g. light points rising out of the chromatic glow) just by
// varying this one argument every frame, with no other change to this function. `rayLength`
// defaults to 2x size for a short-rayed spark (the below-Earth star); the Earth's own limb flare
// passes a much longer explicit rayLength.
function drawSpark(context, x, y, size, intensity, color, rayLength) {
  if (intensity <= 0) return;
  const rays = rayLength || size * 2;
  context.save();
  context.translate(x, y);
  context.globalCompositeOperation = 'lighter';
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, size);
  gradient.addColorStop(0, applyBrightness(color, intensity));
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, size, 0, TAU);
  context.fill();

  // Long thin rays fade out along their length via a linear gradient per axis.
  const drawRay = (x1, y1, x2, y2) => {
    const rayGradient = context.createLinearGradient(x1, y1, x2, y2);
    rayGradient.addColorStop(0, applyBrightness(color, intensity));
    rayGradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.strokeStyle = rayGradient;
    context.lineWidth = Math.max(1, size * 0.12);
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  };
  context.lineCap = 'round';
  drawRay(0, 0, -rays, 0);
  drawRay(0, 0, rays, 0);
  drawRay(0, 0, 0, -rays);
  drawRay(0, 0, 0, rays);
  context.restore();
}

function drawVignette(context) {
  const cx = W / 2;
  const cy = H / 2;
  const maxRadius = Math.hypot(cx, cy);
  const gradient = context.createRadialGradient(cx, cy, maxRadius * VIGNETTE_INNER_STOP, cx, cy, maxRadius);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, `rgba(0,0,0,${VIGNETTE_OUTER_ALPHA})`);
  context.save();
  context.fillStyle = gradient;
  context.fillRect(0, 0, W, H);
  context.restore();
}
