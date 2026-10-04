// html-wallpaper-demo D6b: copied from docs/great-sage/background-raphael/js/sprites.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled: apart
// from this header, the only change is the gold ring's lost glow (mini-scene-window T11); the source's
// own header/body follow. The gold ring's
// PRE-BAKED sprites this file builds (outlineGlyphsGold/outlineGlyphs) stamp straight onto the
// module-global `ctx` (stampSprite below) -- see js/see-through-hook.js's own header remarks for why
// the shared alert overlay's hook cannot reuse this path, and reuses js/glyphs.js's
// context-parameterized drawGlyphRing instead.

// sprites.js — offscreen sprite/glow baking and caching (halos, rainbow rings, flare
// bodies, soft ovals, glow rectangles, glow lines) plus buildSprites()/ensureSprites().
// Loads after config.js, math.js, and scene-data.js (reads RAINBOW_STOPS, SOFT_OVAL_*,
// CHROMATIC_LOOP_GROUPS, SPECTRAL_FLARES from scene-data.js).
//
// Blur-heavy layers are painted once per canvas size into small offscreen sprites and
// stamped every frame. Filtering full-size shapes with ctx.filter each frame made the
// frame cost grow with the window area.
// SPRITE_MAX_DIM, RING_SPRITE_MAX_DIM, HALO_SPRITE_RADIUS, HALO_REFERENCE_WIDTH_FACTOR,
// CHROMATIC_RING_DIFFUSION, FLARE_BODY_BLUR, FLARE_RING_DIFFUSION, FLARE_RING_WIDTH
// moved to js/config.js (SPL-2 consolidation).

function bakeSprite(halfWidth, halfHeight, paint, maxDim = SPRITE_MAX_DIM) {
  const k = Math.min(DPR, maxDim / (2 * Math.max(halfWidth, halfHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(halfWidth * 2 * k));
  canvas.height = Math.max(1, Math.ceil(halfHeight * 2 * k));
  const g = canvas.getContext('2d');
  g.translate(canvas.width / 2, canvas.height / 2);
  paint(g, k);
  return { canvas, hw: canvas.width / (2 * k), hh: canvas.height / (2 * k) };
}

// Draws the sprite centered on the current origin; `unit` scales it relative to its baked size.
function stampSprite(sprite, unit, alpha) {
  const w = sprite.hw * 2 * unit;
  const h = sprite.hh * 2 * unit;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite.canvas, -w / 2, -h / 2, w, h);
}

function paintHalo(g, k, radius, blur) {
  const r = radius * k;
  const halo = g.createRadialGradient(0, 0, 0, 0, 0, r);
  halo.addColorStop(0.00, 'rgba(220,250,255,1)');
  halo.addColorStop(0.30, 'rgba(70,210,255,0.72)');
  halo.addColorStop(0.62, 'rgba(255,70,170,0.46)');
  halo.addColorStop(1.00, 'rgba(0,0,0,0)');
  g.filter = `blur(${blur * k}px)`;
  g.fillStyle = halo;
  g.fillRect(-r, -r, r * 2, r * 2);
}

function paintRainbowPass(g, k, rx, ry, width, blur) {
  const rainbow = g.createConicGradient(-Math.PI / 2, 0, 0);
  for (const [stop, color] of RAINBOW_STOPS) {
    rainbow.addColorStop(stop, `rgba(${color},1)`);
  }
  g.strokeStyle = rainbow;
  g.lineWidth = width * k;
  g.filter = `blur(${blur * k}px)`;
  g.beginPath();
  g.ellipse(0, 0, rx * k, ry * k, 0, 0, TAU);
  g.stroke();
}

// Both bounded passes share one path and radius. Their blur-only rendering
// makes a broad chromatic atmosphere instead of a readable contour.
function bakeRainbowRing(rx, ry, width, diffusion) {
  const pad = diffusion * 1.8 * 3 + width * 2.6;
  return [[width * 3.8, diffusion], [width * 5.2, diffusion * 1.8]].map(([lineWidth, blur]) =>
    bakeSprite(rx + pad, ry + pad, (g, k) => paintRainbowPass(g, k, rx, ry, lineWidth, blur), RING_SPRITE_MAX_DIM)
  );
}

function stampRainbowRing(ring, unit, alpha) {
  for (const pass of ring) stampSprite(pass, unit, alpha);
}

function paintFlareBody(g, k, radius) {
  const r = radius * k;
  const flare = g.createRadialGradient(0, 0, 0, 0, 0, r);
  flare.addColorStop(0.00, 'rgba(255,255,255,0.48)');
  flare.addColorStop(0.14, 'rgba(255,238,60,0.36)');
  flare.addColorStop(0.32, 'rgba(80,255,170,0.28)');
  flare.addColorStop(0.52, 'rgba(55,225,255,0.24)');
  flare.addColorStop(0.70, 'rgba(255,50,120,0.18)');
  flare.addColorStop(1.00, 'rgba(0,0,0,0)');
  g.filter = `blur(${FLARE_BODY_BLUR * k}px)`;
  g.fillStyle = flare;
  g.fillRect(-r, -r, r * 2, r * 2);
}

function paintSoftOval(g, k, field) {
  const viewportAxes = softOvalViewportAxes();
  const rx = viewportAxes.x * field.rx * SOFT_OVAL_SIZE_FACTOR * k;
  const ry = viewportAxes.y * field.ry * SOFT_OVAL_SIZE_FACTOR * k;
  const glow = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(rx, ry));
  glow.addColorStop(0.00, `rgba(${field.color},1)`);
  glow.addColorStop(0.42, `rgba(${field.color},0.78)`);
  glow.addColorStop(0.78, `rgba(${field.color},0.24)`);
  glow.addColorStop(1.00, `rgba(${field.color},0)`);
  g.fillStyle = glow;
  g.filter = `blur(${field.blur * SOFT_OVAL_BLUR_FACTOR * k}px)`;
  g.beginPath();
  g.ellipse(0, 0, rx, ry, 0, 0, TAU);
  g.fill();
}

// RAP-4: the additional circular-oval field (smaller, more circular, more numerous) reuses this
// exact baking approach with its own independent size/blur factors, so it never shifts the
// original soft ovals' established look.
function paintCircularOval(g, k, field) {
  const viewportAxes = softOvalViewportAxes();
  const rx = viewportAxes.x * field.rx * k;
  const ry = viewportAxes.y * field.ry * k;
  const glow = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(rx, ry));
  glow.addColorStop(0.00, `rgba(${field.color},1)`);
  glow.addColorStop(0.42, `rgba(${field.color},0.78)`);
  glow.addColorStop(0.78, `rgba(${field.color},0.24)`);
  glow.addColorStop(1.00, `rgba(${field.color},0)`);
  g.fillStyle = glow;
  g.filter = `blur(${field.blur * CIRCULAR_OVAL_BLUR_FACTOR * k}px)`;
  g.beginPath();
  g.ellipse(0, 0, rx, ry, 0, 0, TAU);
  g.fill();
}

// RAP-8: the line-glow apparatus (glowCache/GLOW_LINE_STYLES/glowLineSprite/stampGlowLine) only
// ever backed the center prism's edges (js/layers.js's former drawTriangularPrism); the prism was
// removed — user: "hay que quitar el prisma del centro" — so this apparatus was removed with it.
// The earlier rect-glow apparatus (GLOW_STYLES/paintGlowRect/glowSprite/stampGlow) was already
// removed in RAP-2b with the segmented sphere and orbit blocks it backed.

// RAP-13 (user feedback): the blue glyph ring is an "outline font" — each glyph is stroked twice at
// the same path: a wide opaque border pass, then a narrower translucent interior pass on top, so
// only the width difference between the two reads as a solid border rim. Baked once per glyph
// (cached, like every other sprite here) so the per-frame cost stays a plain stampSprite. RAP-19a
// fix: applies glyph-rings.js's outlineGlyphOps in order — opaque border, destination-out punch,
// translucent interior refill — so the interior actually reads translucent instead of staying
// ~opaque under the border's own pass. RAP-21: gold uses the exact same technique. RAP-26 (user
// feedback) replaced the RAP-20/21 aspectY-elongated single-function bake (paintOutlineGlyph, using
// glyphs.js's ctx.scale-based drawHieroglyph) below with paintTransformedOutlineGlyph, which uses
// glyphs.js's drawTransformedGlyph on PRE-TRANSFORMED path coordinates instead — see its own
// comment for why.

// RAP-26 (user feedback): ring glyphs are now normalized to an identical width and stretched —
// along the PATH COORDINATES (transformStrokesForRing, glyphs.js), never ctx.scale — to fill their
// ring's own thickness minus its edge margins (js/glyph-rings.js's glyphRingFitScale). `strokes` are
// ALREADY transformed into final real-px local units by the caller; `k` here is only bakeSprite's
// own resolution multiplier (sharpness, e.g. for DPR), applied via the SAME generic linear-scale
// helper so nothing in this path ever calls ctx.scale.
function paintTransformedOutlineGlyph(g, k, strokes, bodyWidth, borderWidth, borderColor, interiorColor, dotRadiusPx) {
  const scaled = transformStrokesForRing(strokes, k, k);
  const ops = outlineGlyphOps(bodyWidth * k, borderWidth * k, borderColor, interiorColor);
  for (const op of ops) {
    g.globalCompositeOperation = op.compositeOperation;
    drawTransformedGlyph(g, scaled, 0, 0, 0, op.color, op.width, dotRadiusPx * k);
  }
  g.globalCompositeOperation = 'source-over';
}

// Builds one ring's outline-font glyph sprites: every glyph independently fit (glyphRingFitScale)
// to the SAME target width/height derived from the annulus thickness (via that RING's OWN
// baseSizeFraction — RAP-29 made this per-ring so blue can go slimmer/denser while gold stays put),
// then baked once and cached — no per-frame path building or scaling. `extraCount` (RAP-35, blue
// only) adds glyphs beyond the ring's derived count; see glyphRingCountWithExtra.
function buildOutlineRingSprites(annulus, baseSizeFraction, strokeWidthFraction, borderColor, interiorColor, extraCount = 0) {
  const thickness = annulus.outerRadius - annulus.innerRadius;
  const targetWidth = thickness * baseSizeFraction;
  const targetHeight = thickness - 2 * glyphRingEdgeMarginPx();
  // RAP-29 ("sin truncarlos... necesita un piso legible"): a slimmer ring (lower baseSizeFraction)
  // can shrink bodyWidth/borderWidth below a legible size — these floors keep a visible outline
  // (opaque border + real positive translucent interior) even then. Floors are applied BEFORE
  // computing extent/canvas size below, so the sprite canvas padding always matches what's actually
  // painted (never under-padded, never clipped).
  const bodyWidth = Math.max(targetWidth * strokeWidthFraction, GLYPH_RING_BODY_WIDTH_FLOOR_PX);
  const borderWidth = Math.max(bodyWidth * GLYPH_RING_BORDER_FRACTION, GLYPH_RING_BORDER_WIDTH_FLOOR_PX);
  const dotRadiusPx = bodyWidth * 0.55;
  const count = annulus.name === 'gold'
    ? goldGlyphRingCount(annulus, targetWidth)
    : glyphRingCountWithExtra(annulus, targetWidth, glyphRingGapPx(), extraCount);
  return Array.from({ length: count }, (_, i) => {
    const strokes = RING_GLYPH_POOL[i % RING_GLYPH_POOL.length];
    // RAP-26b: ringGlyphRenderedBounds (not strokesBounds' conservative full-circle curve measure)
    // so the fit-scale matches what transformStrokesForRing/drawTransformedGlyph actually paint.
    const bounds = ringGlyphRenderedBounds(strokes);
    const rawHalfWidth = (bounds.maxX - bounds.minX) / 2;
    const rawHalfHeight = (bounds.maxY - bounds.minY) / 2;
    const { scaleX, scaleY } = glyphRingFitScale(rawHalfWidth, rawHalfHeight, targetWidth, targetHeight, bodyWidth);
    const scaled = transformStrokesForRing(strokes, scaleX, scaleY);
    // Clamps any accent dot's rendered circle to stay within the target box (its fixed radius,
    // unlike stroke ink, is never itself scaled — see clampRingDotPositions' own comment).
    const transformed = clampRingDotPositions(scaled, targetWidth / 2, targetHeight / 2, dotRadiusPx);
    const extent = glyphRingFitExtent(rawHalfWidth, rawHalfHeight, scaleX, scaleY, bodyWidth);
    return bakeSprite(extent.halfWidth, extent.halfHeight,
      (g, k) => paintTransformedOutlineGlyph(g, k, transformed, bodyWidth, borderWidth, borderColor, interiorColor, dotRadiusPx),
      RING_SPRITE_MAX_DIM);
  });
}

// RAP-12 follow-up (user reference: plumas.avif — "quiero unos diseños así"). Feather-shape
// geometry: an elongated, slightly asymmetric leaf/blade silhouette with a curved central shaft
// (rachis) that extends past the base as a short bare quill, fine diagonal barb lines, small edge
// notches, and downy wisps near the base. All randomness (variant.notchPositions/barbAngles/
// wispAngles) is pre-seeded in js/feathers.js's createFeatherVariant — these functions only draw.
function featherCurveOffset(t, variant, length) {
  return Math.sin(t * Math.PI) * variant.curve * length;
}

// Peaks partway along the vane, tapers to nothing at the tip (t=1) and at the bare-quill base
// (t=0), and dips at each seeded notch position for a small "split" in the edge.
function featherVaneWidth(t, peakWidth, bias, notchPositions) {
  let shape = Math.max(0, Math.sin(Math.PI * Math.pow(t, 0.7))) * (1 - t * 0.15);
  for (const notchT of notchPositions) {
    const distance = Math.abs(t - notchT);
    if (distance < 0.05) shape *= 0.35 + 0.65 * (distance / 0.05);
  }
  return Math.max(0, peakWidth * bias * shape);
}

function pathFeatherSilhouette(g, variant, length, peakWidth) {
  const segments = 16;
  g.beginPath();
  g.moveTo(0, 0);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const width = featherVaneWidth(t, peakWidth, variant.vaneBias, variant.notchPositions);
    g.lineTo(t * length, -width + featherCurveOffset(t, variant, length));
  }
  for (let i = segments; i >= 0; i--) {
    const t = i / segments;
    const width = featherVaneWidth(t, peakWidth, 2 - variant.vaneBias, variant.notchPositions);
    g.lineTo(t * length, width + featherCurveOffset(t, variant, length));
  }
  g.closePath();
}

// The white/grey feather sprite: filled silhouette (brighter along the shaft, greyer toward the
// edges via a perpendicular gradient), the rachis, barbs, and downy wisps. `blurred` bakes a
// soft out-of-focus depth-cue variant (blur is baked in, never applied per frame — see
// assertImplementationInvariants' "never ctx.filter per frame" rule elsewhere in this codebase).
function paintFeatherVariant(g, k, variant, referenceLength, blurred) {
  const length = referenceLength * k;
  const peakWidth = (length / variant.aspect) * 0.5;
  const quillStub = length * 0.06;
  if (blurred) g.filter = `blur(${length * FEATHER_BLUR_RADIUS_FACTOR}px)`;

  pathFeatherSilhouette(g, variant, length, peakWidth);
  const gradient = g.createLinearGradient(0, -peakWidth, 0, peakWidth);
  gradient.addColorStop(0.00, `rgb(${FEATHER_EDGE_COLOR})`);
  gradient.addColorStop(0.50, `rgb(${FEATHER_COLOR})`);
  gradient.addColorStop(1.00, `rgb(${FEATHER_EDGE_COLOR})`);
  g.fillStyle = gradient;
  g.fill();

  g.strokeStyle = `rgba(${FEATHER_COLOR},0.9)`;
  g.lineWidth = Math.max(0.6, length * 0.006);
  g.beginPath();
  g.moveTo(-quillStub, 0);
  const shaftSegments = 10;
  for (let i = 0; i <= shaftSegments; i++) {
    const t = i / shaftSegments;
    g.lineTo(t * length, featherCurveOffset(t, variant, length));
  }
  g.stroke();

  g.strokeStyle = `rgba(${FEATHER_EDGE_COLOR},0.35)`;
  g.lineWidth = Math.max(0.4, length * 0.003);
  for (let i = 0; i < variant.barbAngles.length; i++) {
    const t = 0.15 + (i / variant.barbAngles.length) * 0.75;
    const shaftX = t * length;
    const shaftY = featherCurveOffset(t, variant, length);
    const side = i % 2 === 0 ? -1 : 1;
    const width = featherVaneWidth(t, peakWidth, side < 0 ? variant.vaneBias : 2 - variant.vaneBias, variant.notchPositions);
    const jitter = variant.barbAngles[i];
    g.beginPath();
    g.moveTo(shaftX, shaftY);
    g.lineTo(shaftX + length * 0.06 + jitter * length * 0.04, shaftY + side * width * 0.85);
    g.stroke();
  }

  g.strokeStyle = `rgba(${FEATHER_COLOR},0.28)`;
  g.lineWidth = Math.max(0.35, length * 0.0025);
  for (let i = 0; i < variant.wispAngles.length; i++) {
    const baseX = -quillStub * 0.6 + (i / variant.wispAngles.length) * length * 0.12;
    const angle = variant.wispAngles[i];
    const wispLength = length * (0.05 + 0.03 * (i % 3));
    g.beginPath();
    g.moveTo(baseX, 0);
    g.lineTo(baseX + Math.cos(angle) * wispLength, Math.sin(angle) * wispLength);
    g.stroke();
  }
  g.filter = 'none';
}

// A plain, solid gold silhouette of the same shape, stamped as a second pass over the white sprite
// (scaled by the feather's current gold-tint amount) so lit feathers warm up without any per-frame
// recoloring of the cached white bake.
function paintFeatherGoldMask(g, k, variant, referenceLength) {
  const length = referenceLength * k;
  const peakWidth = (length / variant.aspect) * 0.5;
  pathFeatherSilhouette(g, variant, length, peakWidth);
  g.fillStyle = `rgb(${FEATHER_GOLD_COLOR})`;
  g.fill();
}

// Linux mini optimization begin (O3): mini draws only the two glyph rings from these sprites. Halos,
// rainbow rings, flare bodies/rings, soft/circular ovals and feathers are read only by drawFeathers,
// drawSoftOvalFields, drawCircularOvalFields, drawLensFlares and drawChromaticSideLoops, which main.js
// never calls in mini, so mini bakes the glyph-ring sprites alone (same calls, same arguments).
function buildMiniSprites() {
  const ringAnnuli = glyphRingAnnuli(coreRadius(Math.min(W, H)));
  sprites = {
    outlineGlyphsGold: buildOutlineRingSprites(ringAnnuli[1], GLYPH_RING_GOLD_SLIM_SIZE_FRACTION, GLYPH_RING_STROKE_WIDTH_FRACTION_GOLD, GLYPH_RING_GOLD_BORDER_COLOR, GLYPH_RING_GOLD_INTERIOR_COLOR),
    outlineGlyphs: buildOutlineRingSprites(ringAnnuli[3], GLYPH_RING_BLUE_BASE_SIZE_FRACTION, GLYPH_RING_STROKE_WIDTH_FRACTION_BLUE, GLYPH_RING_BLUE_BORDER_COLOR, GLYPH_RING_BLUE_INTERIOR_COLOR, GLYPH_RING_BLUE_EXTRA_COUNT),
  };
  if (sprites.outlineGlyphsGold.length < 1 || sprites.outlineGlyphs.length < 1) {
    throw new Error('Outline-glyph sprite baking must produce at least one sprite per ring.');
  }
  spritesStale = false;
}

// Linux mini optimization end.
function buildSprites() {
  // Linux mini optimization begin (O3): see buildMiniSprites.
  if (isMiniVariant) {
    buildMiniSprites();
    return;
  }
  // Linux mini optimization end.
  const haloReference = W * HALO_REFERENCE_WIDTH_FACTOR;
  const softOvalViewportSize = softOvalViewportAxes();
  // RAP-26: every ring glyph is fit (glyphRingFitScale) to the SAME target width/height derived
  // from the annulus thickness alone; count is derived SECOND, from how many (glyph + gap) fit the
  // ring's own circumference (glyphRingCountForRing) — never the other way round (see
  // js/glyph-rings.js's RAP-26 comment for the full derivation).
  const ringAnnuli = glyphRingAnnuli(coreRadius(Math.min(W, H)));
  sprites = {
    halo: WET_HALO_LAYERS.map((layer) =>
      bakeSprite(HALO_SPRITE_RADIUS, HALO_SPRITE_RADIUS, (g, k) =>
        paintHalo(g, k, HALO_SPRITE_RADIUS, layer.blur * HALO_SPRITE_RADIUS / (haloReference * layer.scale)))
    ),
    softOvals: SOFT_OVAL_FIELDS.map((field) =>
      bakeSprite(softOvalViewportSize.x * field.rx * SOFT_OVAL_SIZE_FACTOR + field.blur * SOFT_OVAL_BLUR_FACTOR * 3, softOvalViewportSize.y * field.ry * SOFT_OVAL_SIZE_FACTOR + field.blur * SOFT_OVAL_BLUR_FACTOR * 3, (g, k) => paintSoftOval(g, k, field))
    ),
    circularOvals: CIRCULAR_OVAL_FIELDS.map((field) =>
      bakeSprite(softOvalViewportSize.x * field.rx + field.blur * CIRCULAR_OVAL_BLUR_FACTOR * 3, softOvalViewportSize.y * field.ry + field.blur * CIRCULAR_OVAL_BLUR_FACTOR * 3, (g, k) => paintCircularOval(g, k, field))
    ),
    chromaRings: CHROMATIC_LOOP_GROUPS.map((loop) =>
      bakeRainbowRing(W * loop.rx, H * loop.ry, loop.width, CHROMATIC_RING_DIFFUSION)
    ),
    flareBodies: SPECTRAL_FLARES.map((flare) => {
      const radius = W * flare.radius;
      const pad = FLARE_BODY_BLUR * 3;
      return bakeSprite(radius + pad, radius + pad, (g, k) => paintFlareBody(g, k, radius));
    }),
    flareRings: SPECTRAL_FLARES.map((flare) => {
      const radius = W * flare.radius;
      return bakeRainbowRing(radius, radius * 0.56, FLARE_RING_WIDTH, FLARE_RING_DIFFUSION);
    }),
    outlineGlyphsGold: buildOutlineRingSprites(ringAnnuli[1], GLYPH_RING_GOLD_SLIM_SIZE_FRACTION, GLYPH_RING_STROKE_WIDTH_FRACTION_GOLD, GLYPH_RING_GOLD_BORDER_COLOR, GLYPH_RING_GOLD_INTERIOR_COLOR),
    outlineGlyphs: buildOutlineRingSprites(ringAnnuli[3], GLYPH_RING_BLUE_BASE_SIZE_FRACTION, GLYPH_RING_STROKE_WIDTH_FRACTION_BLUE, GLYPH_RING_BLUE_BORDER_COLOR, GLYPH_RING_BLUE_INTERIOR_COLOR, GLYPH_RING_BLUE_EXTRA_COUNT),
    featherSharp: FEATHER_VARIANTS.map((variant) =>
      bakeSprite(FEATHER_SPRITE_REFERENCE_LENGTH * 1.05, FEATHER_SPRITE_REFERENCE_LENGTH * 0.5,
        (g, k) => paintFeatherVariant(g, k, variant, FEATHER_SPRITE_REFERENCE_LENGTH, false))
    ),
    featherBlurred: FEATHER_VARIANTS.map((variant) =>
      bakeSprite(FEATHER_SPRITE_REFERENCE_LENGTH * 1.05, FEATHER_SPRITE_REFERENCE_LENGTH * 0.5,
        (g, k) => paintFeatherVariant(g, k, variant, FEATHER_SPRITE_REFERENCE_LENGTH, true))
    ),
    featherGoldMask: FEATHER_VARIANTS.map((variant) =>
      bakeSprite(FEATHER_SPRITE_REFERENCE_LENGTH * 1.05, FEATHER_SPRITE_REFERENCE_LENGTH * 0.5,
        (g, k) => paintFeatherGoldMask(g, k, variant, FEATHER_SPRITE_REFERENCE_LENGTH))
    ),
  };
  if (sprites.softOvals.length !== SOFT_OVAL_FIELDS.length) {
    throw new Error('Soft oval sprite baking must produce one sprite per configured field.');
  }
  if (sprites.circularOvals.length !== CIRCULAR_OVAL_FIELDS.length) {
    throw new Error('Circular oval sprite baking must produce one sprite per configured field.');
  }
  if (sprites.outlineGlyphsGold.length < 1 || sprites.outlineGlyphs.length < 1) {
    throw new Error('Outline-glyph sprite baking must produce at least one sprite per ring.');
  }
  if (sprites.featherSharp.length !== FEATHER_VARIANT_COUNT || sprites.featherBlurred.length !== FEATHER_VARIANT_COUNT ||
      sprites.featherGoldMask.length !== FEATHER_VARIANT_COUNT) {
    throw new Error('Feather sprite baking must produce one sprite per configured variant, sharp/blurred/gold-mask.');
  }
  spritesStale = false;
}

function ensureSprites() {
  if (spritesStale) buildSprites();
}
// Linux mini optimization begin (PERF-5): wallpaper blur-free glows (odd/tasks/wallpaper-microstutters.md).
// ctx.shadowBlur makes Chromium blur a coverage mask on every draw; on the full-size wallpaper those
// per-frame blurs cost more than half of every frame. The wallpaper paints each glow from a shadow-only
// bitmap instead, baked once per geometry with the very canvas shadow the reference draws (same colour,
// blur, stroke or fill), then paints the shape itself without a shadow: shadow first and shape second,
// under the same composite operation, as the canvas does. Bitmaps are device-scale (shadowBlur is in
// device pixels) and are all dropped when the canvas size or backing scale changes. Not pixel-identical:
// bitmaps are resampled when drawn rotated or stretched, separate segment stamps add up where the
// reference blurs one union, and pulsing glows blend the two nearest of a few baked pulse levels.
// The mini variant keeps its shadowBlur paths unchanged.
const wallpaperGlowCache = { key: null, entries: new Map() };
const WALLPAPER_PULSE_GLOW_LEVELS = 8;
// Shadow blur / disc radius is baked in 3% steps; the stamped blur stays within 1.5% of the reference.
const WALLPAPER_DISC_GLOW_STEP = 1.03;
const WALLPAPER_DISC_GLOW_RADIUS = 64;
let wallpaperSegmentCoords = new Float64Array(4 * 64);

// Device pixels per user unit of the scene layers (render() draws them under scale(viewZoom)), or 0 when
// the backing scale is not uniform (a rotated bitmap needs one scale); callers then keep shadowBlur.
function wallpaperGlowScale() {
  return canvasScaleX === canvasScaleY ? canvasScaleX * viewZoom : 0;
}

function wallpaperGlowEntry(key, bake) {
  const cache = wallpaperGlowCache;
  const geometry = `${W}x${H}@${canvasScaleX},${canvasScaleY}`;
  if (cache.key !== geometry) {
    cache.key = geometry;
    cache.entries.clear();
  }
  let entry = cache.entries.get(key);
  if (entry === undefined) {
    entry = bake();
    cache.entries.set(key, entry);
  }
  return entry;
}

function wallpaperSegmentBuffer(count) {
  if (wallpaperSegmentCoords.length < 4 * count) wallpaperSegmentCoords = new Float64Array(4 * count);
  return wallpaperSegmentCoords;
}

// Bakes only the canvas shadow of paintShape(g), a shape painted in user units around the origin: the
// shape is drawn one bitmap width left of the bitmap and shadowOffsetX (device pixels, like shadowBlur)
// brings its shadow back, so the bitmap holds exactly the shadow the canvas paints under that shape.
function bakeShadowLayer(halfWidth, halfHeight, scale, shadowColor, shadowBlur, paintShape) {
  const pad = 2 * shadowBlur + 2;
  const width = 2 * Math.ceil(halfWidth * scale + pad);
  const height = 2 * Math.ceil(halfHeight * scale + pad);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  g.setTransform(scale, 0, 0, scale, width / 2 - width, height / 2);
  g.shadowColor = shadowColor;
  g.shadowBlur = shadowBlur;
  g.shadowOffsetX = width;
  paintShape(g);
  return { canvas, hw: width / 2 / scale, hh: height / 2 / scale };
}

// Draws a baked shadow centred on the current origin, `unit` times its baked size, at alpha times the
// current globalAlpha (which it leaves unchanged).
function stampShadowLayer(layer, unit, alpha) {
  const globalAlpha = ctx.globalAlpha;
  ctx.globalAlpha = globalAlpha * alpha;
  ctx.drawImage(layer.canvas, -layer.hw * unit, -layer.hh * unit, 2 * layer.hw * unit, 2 * layer.hh * unit);
  ctx.globalAlpha = globalAlpha;
}

// The shadow of a stroked segment, for segments of any length: one horizontal segment, `reach` longer
// than the shadow's own falloff at each end, is baked once; a segment's glow is its two end slices plus
// the uniform middle slice stretched in between (the stampGlowLine layout). The end slices are the
// shadow of a half-line, so with butt caps consecutive segments of a polyline tile into its shadow.
function wallpaperLineGlow(lineWidth, strokeStyle, lineCap, shadowColor, shadowBlur) {
  const scale = wallpaperGlowScale();
  if (!(scale > 0)) return null;
  return wallpaperGlowEntry(`line|${lineWidth}|${strokeStyle}|${lineCap}|${shadowColor}|${shadowBlur}`, () => {
    const reach = lineWidth / 2 + (2 * shadowBlur + 2) / scale;
    const length = 2 * reach + 8 / scale;
    const layer = bakeShadowLayer(length / 2, lineWidth / 2, scale, shadowColor, shadowBlur, (g) => {
      g.strokeStyle = strokeStyle;
      g.lineWidth = lineWidth;
      g.lineCap = lineCap;
      g.beginPath();
      g.moveTo(-length / 2, 0);
      g.lineTo(length / 2, 0);
      g.stroke();
    });
    return { layer, reach, length };
  });
}

// Stamps the glow of segments [start, end) of coords ([x1, y1, x2, y2] per segment, user units). Each
// stamp gets one setTransform from the current matrix when getTransform is available (else
// translate/rotate inside save/restore); the current transform is restored afterwards.
function stampWallpaperLineGlows(glow, coords, start, end) {
  const { layer, reach, length } = glow;
  const { canvas, hw, hh } = layer;
  const k = canvas.width / (2 * hw);
  const edge = hw - length / 2;
  const height = canvas.height;
  const middleX = (edge + reach) * k;
  const middleWidth = (length - 2 * reach) * k;
  const base = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const direct = !!base && Number.isFinite(base.a);
  ctx.save();
  for (let i = start; i < end; i++) {
    const o = i * 4;
    const x1 = coords[o];
    const y1 = coords[o + 1];
    const dx = coords[o + 2] - x1;
    const dy = coords[o + 3] - y1;
    const span = Math.hypot(dx, dy);
    const cos = span > 0 ? dx / span : 1;
    const sin = span > 0 ? dy / span : 0;
    if (direct) {
      ctx.setTransform(base.a * cos + base.c * sin, base.b * cos + base.d * sin,
        base.c * cos - base.a * sin, base.d * cos - base.b * sin,
        base.a * x1 + base.c * y1 + base.e, base.b * x1 + base.d * y1 + base.f);
    } else {
      ctx.restore();
      ctx.save();
      ctx.translate(x1, y1);
      ctx.rotate(Math.atan2(sin, cos));
    }
    const a = Math.min(reach, span / 2);
    const cap = (edge + a) * k;
    ctx.drawImage(canvas, 0, 0, cap, height, -edge, -hh, edge + a, 2 * hh);
    if (span > 2 * a) ctx.drawImage(canvas, middleX, 0, middleWidth, height, a, -hh, span - 2 * a, 2 * hh);
    ctx.drawImage(canvas, canvas.width - cap, 0, cap, height, span - a, -hh, edge + a, 2 * hh);
  }
  ctx.restore();
}

// A pulsing closed shape's glow: bakeLevel(p, scale) bakes its shadow at pulse p for the
// WALLPAPER_PULSE_GLOW_LEVELS + 1 levels p = i / LEVELS (all at once, so later frames never bake).
function wallpaperPulseGlows(key, bakeLevel) {
  const scale = wallpaperGlowScale();
  if (!(scale > 0)) return null;
  return wallpaperGlowEntry(`pulse|${key}`, () =>
    Array.from({ length: WALLPAPER_PULSE_GLOW_LEVELS + 1 }, (_, i) => bakeLevel(i / WALLPAPER_PULSE_GLOW_LEVELS, scale)));
}

// Stamps the glow at `pulse` (0..1) centred on the current origin: level 0 alone between pulses, else the
// two nearest levels blended by the pulse's position between them.
function stampWallpaperPulseGlow(levels, pulse) {
  const t = Math.min(1, Math.max(0, pulse)) * WALLPAPER_PULSE_GLOW_LEVELS;
  const i = Math.min(WALLPAPER_PULSE_GLOW_LEVELS - 1, Math.floor(t));
  const f = t - i;
  if (f < 1) stampShadowLayer(levels[i], 1, 1 - f);
  if (f > 0) stampShadowLayer(levels[i + 1], 1, f);
}

// The shadow of a filled disc of `radius` (user units) centred on the current origin. A disc's shadow
// scales with the disc when its blur scales too, so one bake at WALLPAPER_DISC_GLOW_RADIUS per 3% step of
// shadowBlur / radius serves every radius. paintDisc(g, radius) fills the disc on the bake context.
function stampWallpaperDiscGlow(fillKey, paintDisc, shadowColor, shadowBlur, radius) {
  const scale = wallpaperGlowScale();
  if (!(scale > 0) || !(radius > 0) || !(shadowBlur > 0)) return false;
  const step = Math.round(Math.log(shadowBlur / (radius * scale)) / Math.log(WALLPAPER_DISC_GLOW_STEP));
  const bakeRadius = WALLPAPER_DISC_GLOW_RADIUS;
  const layer = wallpaperGlowEntry(`disc|${fillKey}|${shadowColor}|${step}`, () =>
    bakeShadowLayer(bakeRadius, bakeRadius, scale, shadowColor, bakeRadius * scale * WALLPAPER_DISC_GLOW_STEP ** step,
      (g) => paintDisc(g, bakeRadius)));
  stampShadowLayer(layer, radius / bakeRadius, 1);
  return true;
}

// Linux mini optimization end.
