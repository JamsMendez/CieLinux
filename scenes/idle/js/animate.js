// html-wallpaper-demo D6c: copied verbatim from docs/great-sage/background-idle/js/animate.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged, EXCEPT the
// "Main animation loop" section at the bottom of this file (fault isolation + the constellation-ring
// stamp seam, see that section's own D6c remarks) and CONSTELLATION_RING_INDEX just below
// RING_ANIMATIONS.

// animate.js — the requestAnimationFrame loop, per-ring content caches, the single combined
// lighting mask, and the chromatic-glow/spark particle system. Loads after rings.js (needs
// drawSpark, every drawXxxRing function, and applyBrightness) and before main.js (which just wires
// up resize + the initial call into startAnimation()).
//
// Ring rotation strategy: each rotating ring's raw content is pre-rendered ONCE (at full
// brightness — see bakingRingContent in math.js) into its own offscreen canvas covering its full
// bounding circle. Per frame, that content is drawn rotated by the ring's current angle. IDL-12:
// lighting used to be applied per ring, via one additional offscreen "mask" canvas per ring
// (screen-fixed top-lit brightness by angle) composited with 'multiply' right after that ring's
// content — profiling showed these per-ring mask draws (12 drawImage + save/restore pairs per
// frame, content + mask x 6 rings) were the dominant per-frame cost. Since every ring's annulus is
// disjoint (assertRingAnnuliDisjoint(), unchanged) and all share the same screen center, one
// combined mask covering the union of every ring's annulus is composited ONCE, after every ring's
// (still individually rotated) content has been drawn — see buildCombinedLightingMask and
// drawCombinedLightingMask below. All caches (content, per-ring; mask, single/combined) rebuild
// only when the canvas resizes (ring radii are fractions of min(W,H), so any resize invalidates
// every cached bitmap's pixel size).

// IDL-9: every ring's cache annulus (cacheInnerFrac/cacheOuterFrac) is now derived from the exact
// same config constants each ring's own draw function uses (see config.js, next to each ring's
// section) instead of separate ad-hoc padding guesses — the earlier guesses for the ruler,
// paragraph, and outer glyph ring caches overshot their rings' true content extent, and the outer
// glyph ring's guess in particular reached past the disc border into the starfield, causing the
// disc border and starfield to get double-lit by that ring's multiply mask. `innerFrac`/
// `outerFrac` (passed into each ring's own draw call) stay the ring's true drawn geometry;
// `cacheInnerFrac`/`cacheOuterFrac` (used only for sizing/clipping this ring's own cache/mask) can
// differ when a ring draws content outside its own inner/outer boundary lines (e.g. the ruler's
// labels, or the paragraph ring's multi-row glyphs) — see assertRingAnnuliDisjoint() below, which
// checks these same cache extents never overlap each other or the disc border at load time.
const RING_ANIMATIONS = [
  { name: 'constellation', speed: CONSTELLATION_ROTATION_SPEED, draw: drawConstellationRing,
    innerFrac: CONSTELLATION_RING_INNER_RADIUS_FRACTION, outerFrac: CONSTELLATION_RING_OUTER_RADIUS_FRACTION,
    cacheInnerFrac: CONSTELLATION_RING_INNER_RADIUS_FRACTION, cacheOuterFrac: CONSTELLATION_RING_OUTER_RADIUS_FRACTION },
  { name: 'hieroglyph', speed: HIEROGLYPH_ROTATION_SPEED, draw: drawHieroglyphBand,
    innerFrac: HIEROGLYPH_BAND_INNER_RADIUS_FRACTION, outerFrac: HIEROGLYPH_BAND_OUTER_RADIUS_FRACTION,
    cacheInnerFrac: HIEROGLYPH_BAND_INNER_RADIUS_FRACTION, cacheOuterFrac: HIEROGLYPH_BAND_OUTER_RADIUS_FRACTION },
  { name: 'alphabet', speed: ALPHABET_ROTATION_SPEED, draw: drawAlphabetRing,
    innerFrac: ALPHABET_RING_INNER_RADIUS_FRACTION, outerFrac: ALPHABET_RING_OUTER_RADIUS_FRACTION,
    cacheInnerFrac: ALPHABET_RING_INNER_RADIUS_FRACTION, cacheOuterFrac: ALPHABET_RING_OUTER_RADIUS_FRACTION },
  { name: 'ruler', speed: RULER_ROTATION_SPEED, draw: (ctx, cx, cy, inner, outer, rot) => drawRulerRing(ctx, cx, cy, inner, rot),
    innerFrac: RULER_RING_RADIUS_FRACTION, outerFrac: RULER_RING_RADIUS_FRACTION,
    cacheInnerFrac: RULER_CACHE_INNER_RADIUS_FRACTION, cacheOuterFrac: RULER_CACHE_OUTER_RADIUS_FRACTION },
  { name: 'paragraph', speed: PARAGRAPH_ROTATION_SPEED, draw: (ctx, cx, cy, inner, outer, rot) => drawParagraphRing(ctx, cx, cy, inner, rot),
    innerFrac: PARAGRAPH_RING_INNER_RADIUS_FRACTION, outerFrac: PARAGRAPH_RING_INNER_RADIUS_FRACTION,
    cacheInnerFrac: PARAGRAPH_CACHE_INNER_RADIUS_FRACTION, cacheOuterFrac: PARAGRAPH_CACHE_OUTER_RADIUS_FRACTION },
  { name: 'outerGlyph', speed: OUTER_GLYPH_ROTATION_SPEED, draw: (ctx, cx, cy, inner, outer, rot) => drawOuterGlyphRing(ctx, cx, cy, inner, rot),
    innerFrac: OUTER_GLYPH_RING_INNER_RADIUS_FRACTION, outerFrac: OUTER_GLYPH_RING_INNER_RADIUS_FRACTION,
    cacheInnerFrac: OUTER_GLYPH_CACHE_INNER_RADIUS_FRACTION,
    // Hard-clipped to stay strictly inside the disc border regardless of the computed true
    // extent, since that extent alone left very little margin (see config.js comment).
    cacheOuterFrac: Math.min(OUTER_GLYPH_CACHE_OUTER_RADIUS_FRACTION, DISC_BORDER_INNER_RADIUS_FRACTION) },
];

// Linux port begin: CONSTELLATION_RING_INDEX and its load-time throw are removed. They only fed
// see-through-hook.js (the alert overlay's see-through seam), which this port does not package.
// Linux port end.

// Startup assertion: every rotating ring's cache annulus must be disjoint from every other ring's
// (no two overlap) and must sit entirely inside the disc border's inner edge — otherwise one
// ring's lighting mask could multiply onto another ring's (or the border/starfield's) pixels a
// second time, as happened before this annulus was tightened. Runs once at load; throws (loud
// failure, not a silent visual bug) if the geometry ever regresses.
function assertRingAnnuliDisjoint() {
  const sorted = RING_ANIMATIONS.slice().sort((a, b) => a.cacheInnerFrac - b.cacheInnerFrac);
  for (let i = 0; i < sorted.length; i++) {
    const ring = sorted[i];
    if (ring.cacheOuterFrac <= ring.cacheInnerFrac) {
      throw new Error(`Ring cache annulus degenerate for "${ring.name}": inner=${ring.cacheInnerFrac} outer=${ring.cacheOuterFrac}`);
    }
    if (ring.cacheOuterFrac > DISC_BORDER_INNER_RADIUS_FRACTION) {
      throw new Error(`Ring cache annulus for "${ring.name}" (outer=${ring.cacheOuterFrac}) extends past the disc border inner edge (${DISC_BORDER_INNER_RADIUS_FRACTION})`);
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      if (ring.cacheInnerFrac < prev.cacheOuterFrac) {
        throw new Error(`Ring cache annuli overlap: "${prev.name}" outer=${prev.cacheOuterFrac} vs "${ring.name}" inner=${ring.cacheInnerFrac}`);
      }
    }
  }
}
assertRingAnnuliDisjoint();

// Populated by buildRingCaches(); each entry gets { content, size, radius } where `size` is
// the cache canvas's pixel width/height and `radius` is half of it (the bounding circle radius,
// oversampled slightly per RING_CACHE_OVERSAMPLE for crisper rotated output).
// IDL-12 perf: each ring no longer carries its own per-ring lighting-mask canvas (see
// combinedLightingMask below) — profiling (CDP Profiler, 20 driven frames, see feature doc) showed
// drawCachedRing's per-ring save/restore/drawImage pairs (12 per frame: content + mask x 6 rings)
// were the dominant per-frame cost (~75-80% of total frame time at both tested resolutions). Since
// every rotating ring's annulus is disjoint (assertRingAnnuliDisjoint(), unchanged) and all share
// the same screen center, one shared, screen-fixed mask covering the union of all 6 annuli is
// mathematically identical to compositing 6 separate per-ring masks (each ring's mask only ever
// covered its own annulus and was transparent everywhere else, so overlapping them was already a
// no-op outside each ring's own slice) — replacing 6 mask drawImage calls with 1.
let ringCaches = null;
let ringCacheBasis = -1; // the min(W,H) value the current caches were built for; rebuild when it changes
let ringCacheDpr = -1; // the DPR the current caches were built for; rebuild when it changes (IDL-9)
let combinedLightingMask = null; // { canvas, size, radius } — one mask covering every ring's annulus, screen-fixed

// `size` is the cache's logical (CSS-pixel-equivalent) width/height; the actual backing store is
// `size*dpr` physical pixels so ring content/mask bitmaps are as crisp on a HiDPI/scaled display
// as the rest of the scene (which already draws at device-pixel resolution via the main canvas's
// own DPR transform). The returned canvas's 2D context is pre-scaled by `dpr` so every caller can
// keep drawing in logical/CSS-pixel-equivalent coordinates, matching every other size/radius
// computed in buildRingCaches.
function makeOffscreen(size, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(size * dpr));
  c.height = Math.max(1, Math.round(size * dpr));
  const context = c.getContext('2d');
  context.scale(dpr, dpr);
  return c;
}

// Builds (or rebuilds) every rotating ring's content cache, then the single combined lighting
// mask (see buildCombinedLightingMask below), for the current canvas size. Called once on load and
// again on every resize; never per frame.
//
// Bugfix (post-IDL-8), two compounding issues found while restoring correct lighting:
// 1) The lighting mask must cover exactly this ring's own annulus (innerRadius to outerRadius)
//    and nothing more. It was previously painted as a disc out to radius*1.5 (with
//    RING_CACHE_OVERSAMPLE=1.25, that is 1.875x the ring's own outer radius) — since every ring's
//    mask is composited at the same shared screen center with globalCompositeOperation='multiply',
//    each oversized mask also multiplied over every ring further inside it, compounding across
//    all 6 rotating rings and crushing brightness far more than the static render.
// 2) The first fix attempt then mis-scaled the clip itself: `ring.draw` is always called with the
//    ring's true, UNSCALED innerRadius/outerRadius (in cache-local pixel units centered on
//    (radius, radius) — see below), so the ring's content radius range is exactly
//    [innerRadius, outerRadius], not [innerRadius, outerRadius] scaled up to fill the oversampled
//    canvas. RING_CACHE_OVERSAMPLE only adds pixel-density margin around the content for cleaner
//    rotation; it does not scale the content's own coordinates. Using the wrong (scaled) radii to
//    clip the mask put the clip annulus almost entirely outside the ring's actual content,
//    leaving the content effectively unmasked (full brightness everywhere) — the opposite symptom
//    from bug (1), but from the same root confusion about the oversampled canvas's coordinate space.
function buildRingCaches(cx, cy, basis, dpr) {
  ringCaches = RING_ANIMATIONS.map((ring) => {
    const innerRadius = basis * ring.innerFrac;
    const outerRadius = basis * ring.outerFrac;
    // The cache annulus is sized from cacheInnerFrac/cacheOuterFrac — this ring's true drawn
    // extent (see config.js), which can be wider than innerFrac/outerFrac (the boundary-line
    // radii passed into ring.draw itself) for rings whose content reaches past their own
    // boundary lines, e.g. the ruler's labels or the paragraph ring's multiple rows.
    const cacheOuterRadius = basis * ring.cacheOuterFrac;
    const size = Math.max(2, Math.round(cacheOuterRadius * 2 * RING_CACHE_OVERSAMPLE));
    const radius = size / 2; // half of the (oversampled) canvas, in logical/CSS-equivalent units;
    // also where ring.draw's own cx/cy sits and what drawCachedRing uses for its destination size.
    const localCx = radius, localCy = radius;

    // Content: baked at full brightness (bakingRingContent=true short-circuits
    // verticalLightBrightness to 1 for every applyBrightness() call the ring's draw function
    // makes), so the cached bitmap carries the ring's true colors with no top-lit falloff yet.
    // Drawn with its true, unscaled innerRadius/outerRadius — the oversampled canvas just gives
    // it margin, it does not stretch the ring's own geometry. Backing store is size*dpr physical
    // pixels (see makeOffscreen) so this stays crisp on a HiDPI/scaled display.
    const content = makeOffscreen(size, dpr);
    const contentCtx = content.getContext('2d');
    bakingRingContent = true;
    try {
      ring.draw(contentCtx, localCx, localCy, innerRadius, outerRadius, 0);
    } finally {
      bakingRingContent = false;
    }

    return { content, size, radius };
  });
  ringCacheBasis = basis;
  ringCacheDpr = dpr;
  // Linux mini optimization begin (O1): mini never draws the combined lighting mask (see renderFrame), so
  // it is not built there either.
  if (isMiniVariant) {
    combinedLightingMask = null;
    return;
  }
  // Linux mini optimization end.
  buildCombinedLightingMask(basis, dpr);
}

// IDL-12 perf: ONE screen-fixed lighting mask covering every rotating ring's annulus, replacing
// the earlier per-ring mask canvases. Built once per resize/DPR change (never per frame), same as
// the old per-ring masks were. Mathematically identical output: each ring's own annulus is
// disjoint from every other ring's (assertRingAnnuliDisjoint(), unchanged, still runs at load and
// still checks these same cacheInnerFrac/cacheOuterFrac pairs), and every old per-ring mask was
// already fully transparent outside its own annulus — so drawing N separate masks, each opaque
// only on its own disjoint slice, is pixel-identical to drawing one mask that is opaque on the
// union of those N disjoint slices. Verified by an offline pixel comparison against the old
// per-ring-mask output (see feature doc).
function buildCombinedLightingMask(basis, dpr) {
  // Sized to cover the outermost ring's own cache extent (the widest of all 6), centered at the
  // shared ring-system center — every inner ring's annulus fits within this same canvas since
  // they all share that center and have smaller radii.
  const maxCacheOuterRadius = Math.max(...RING_ANIMATIONS.map((r) => basis * r.cacheOuterFrac));
  const size = Math.max(2, Math.round(maxCacheOuterRadius * 2 * RING_CACHE_OVERSAMPLE));
  const radius = size / 2;
  const localCx = radius, localCy = radius;

  const canvas = makeOffscreen(size, dpr);
  const maskCtx = canvas.getContext('2d');
  const gradient = maskCtx.createConicGradient(0, localCx, localCy);
  const stopCount = LIGHTING_MASK_GRADIENT_STOPS;
  for (let s = 0; s <= stopCount; s++) {
    const t = s / stopCount; // 0..1 all the way around, matching createConicGradient's own 0..1 stop domain
    const brightness = verticalLightBrightness(t * TAU);
    const v = Math.round(clamp01(brightness) * 255);
    gradient.addColorStop(t, `rgb(${v},${v},${v})`);
  }

  // Same bugfix as the old per-ring masks: a discrete-wedge fill produced visible brightness-step
  // seams; createConicGradient interpolates continuously, so there are none. Clip to the union of
  // every ring's own true annulus (each ring's own inner/outer radius, -1px on the inner edge so
  // its anti-aliased content edge stays lit, exactly as before) via one evenodd multi-subpath
  // path, then fill with the single gradient once.
  maskCtx.save();
  maskCtx.beginPath();
  for (const ring of RING_ANIMATIONS) {
    const cacheInnerRadius = basis * ring.cacheInnerFrac;
    const cacheOuterRadius = basis * ring.cacheOuterFrac;
    maskCtx.moveTo(localCx + cacheOuterRadius, localCy);
    maskCtx.arc(localCx, localCy, cacheOuterRadius, 0, TAU);
    maskCtx.moveTo(localCx + Math.max(0, cacheInnerRadius - 1), localCy);
    maskCtx.arc(localCx, localCy, Math.max(0, cacheInnerRadius - 1), 0, TAU, true);
  }
  maskCtx.clip('evenodd');
  maskCtx.fillStyle = gradient;
  maskCtx.fillRect(0, 0, size, size);
  maskCtx.restore();

  combinedLightingMask = { canvas, size, radius };
}

// mini-scene-window T2i: the mini window is topmost and see-through, so text from windows behind it reads
// through the ring bands (only the alphabet cells and the planet are opaque). In mini every ring band gets an
// occluding dark base (MINI_RING_BASE_COLOR, the scene's own #01040a at alpha 0.9) so no band sits "under"
// the text. It covers exactly each band's own annulus (its cache extent, plus the disc border), so the gaps
// between rings and everything outside the disc stay see-through. It is drawn LAST with destination-over,
// i.e. beneath everything already drawn: it never lightens, tints or dims the ring content, the planet or the
// fan, and needs no cache or rotation handling (the bands are circles).
function drawMiniRingBases(context, cx, cy, basis) {
  const annuli = RING_ANIMATIONS.map((ring) => [basis * ring.cacheInnerFrac, basis * ring.cacheOuterFrac]);
  annuli.push([basis * DISC_BORDER_INNER_RADIUS_FRACTION, basis * DISC_BORDER_OUTER_RADIUS_FRACTION]);
  // The hollow around the planet, from the center out to the first ring, is part of the disc too: text must
  // not read there either (the planet itself is opaque and sits on top).
  annuli.unshift([0, Math.min(...annuli.map((band) => band[0]))]);
  context.save();
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = MINI_RING_BASE_COLOR;
  context.beginPath();
  for (const [innerRadius, outerRadius] of annuli) {
    context.moveTo(cx + outerRadius, cy);
    context.arc(cx, cy, outerRadius, 0, TAU);
    context.moveTo(cx + innerRadius, cy);
    context.arc(cx, cy, innerRadius, 0, TAU, true);
  }
  context.fill();
  context.restore();
}

// Draws one cached ring's content, rotated by `angle`. The screen-fixed combined lighting mask
// (see buildCombinedLightingMask) is applied separately, once, after every ring's content has
// been drawn (see renderFrame) — not per ring. `cache.content` is centered at (cache.radius,
// cache.radius) in its own local (logical/CSS-equivalent) space; on screen that local center sits
// at (cx, cy) — the same ring-system center used everywhere else. The explicit (cache.size,
// cache.size) destination size is required: the cache canvas's backing store is size*DPR physical
// pixels (see makeOffscreen), so drawing it at its natural pixel dimensions would render DPR times
// too large — the explicit size keeps the on-screen result at the intended logical size regardless
// of the backing store's actual pixel density.
function drawCachedRingContent(context, cache, cx, cy, angle) {
  const half = cache.radius;
  context.save();
  context.translate(cx, cy);
  context.rotate(angle);
  context.drawImage(cache.content, -half, -half, cache.size, cache.size);
  context.restore();
}

// Applies the single combined lighting mask on top of every ring's just-drawn (unlit) content in
// one multiply-blend drawImage call, replacing what used to be one such call per ring.
function drawCombinedLightingMask(context, cx, cy) {
  const half = combinedLightingMask.radius;
  context.save();
  context.translate(cx, cy);
  context.globalCompositeOperation = 'multiply';
  context.drawImage(combinedLightingMask.canvas, -half, -half, combinedLightingMask.size, combinedLightingMask.size);
  context.restore();
  // 'multiply' also darkens fully-transparent areas' eventual alpha compositing target if drawn
  // over opaque content; since the destination here is the main canvas (which already has the
  // dark background AND every ring's content painted this frame) and the mask itself is fully
  // transparent everywhere outside the union of ring annuli, restoring normal blending immediately
  // after keeps later draws (Earth, glow, vignette) unaffected.
}

// --- Chromatic glow flow + rising spark particles ------------------------------------------

// Deterministic seeded spark schedule: precomputes ONE PERIOD of (spawnTime, lifetime, horizontal
// offset, peak intensity) tuples once, then repeats that period forever by wrapping elapsed time
// modulo the period's span. A wallpaper runs for hours or days, so a finite (non-repeating) list
// would eventually run out and sparks would stop spawning — periodic repetition instead means
// sparks keep spawning indefinitely, at the cost of the sequence repeating every
// GLOW_SPARK_SCHEDULE_SPAN_SECONDS (kept long enough, via GLOW_SPARK_SCHEDULE_ENTRIES, that the
// repetition is not obviously noticeable). Nothing here calls Math.random() per frame; the table
// is fixed at load time.
// Lifetimes are GLOW_SPARK_LIFETIME_SECONDS * (0.8 .. 0.8 + jitter); the upper bound lets the
// alive-spark scans stop early without missing a long-lived spark behind a short-lived one.
const GLOW_SPARK_LIFETIME_JITTER = 0.4;
const GLOW_SPARK_MAX_LIFETIME_SECONDS = GLOW_SPARK_LIFETIME_SECONDS * (0.8 + GLOW_SPARK_LIFETIME_JITTER);

const GLOW_SPARK_SCHEDULE = (() => {
  const random = mulberry32(GLOW_SPARK_SEED);
  const schedule = [];
  let t = 0;
  for (let i = 0; i < GLOW_SPARK_SCHEDULE_ENTRIES; i++) {
    t += GLOW_SPARK_SPAWN_INTERVAL_SECONDS * (0.5 + random()); // jittered spawn gap, still deterministic
    schedule.push({
      spawnTime: t,
      lifetime: GLOW_SPARK_LIFETIME_SECONDS * (0.8 + random() * GLOW_SPARK_LIFETIME_JITTER),
      offsetT: (random() - 0.5) * 2, // -1..1, scaled by GLOW_SPARK_HORIZONTAL_JITTER_FRACTION at draw time
      peakIntensity: GLOW_SPARK_MAX_INTENSITY * (0.6 + random() * 0.4),
      sizeJitter: 0.75 + random() * 0.5,
    });
  }
  return schedule;
})();
// The period's span: one spawn-interval gap past the last entry's spawnTime, so consecutive
// periods do not spawn two sparks back-to-back faster than the configured average interval.
const GLOW_SPARK_SCHEDULE_SPAN_SECONDS =
  GLOW_SPARK_SCHEDULE[GLOW_SPARK_SCHEDULE.length - 1].spawnTime + GLOW_SPARK_SPAWN_INTERVAL_SECONDS;

// Binary-search the (sorted-by-spawnTime) schedule for the index of the last entry whose
// spawnTime is <= `localTime`. Returns -1 if every entry spawns after `localTime`.
function findLastSpawnedIndex(localTime) {
  let lo = 0, hi = GLOW_SPARK_SCHEDULE.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (GLOW_SPARK_SCHEDULE[mid].spawnTime <= localTime) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

// Finds every spark alive at `timeSeconds`, capped at GLOW_SPARK_MAX_ALIVE (most-recently-spawned
// wins ties). Wraps `timeSeconds` into the schedule's single precomputed period via modulo, and
// also checks the tail of the PREVIOUS period (sparks near the end of one period can still be
// alive a little way into the next), so nothing visibly pops out of existence right at the wrap
// boundary. Uses a binary search into the sorted schedule rather than scanning every entry, so
// cost stays O(log GLOW_SPARK_SCHEDULE_ENTRIES + GLOW_SPARK_MAX_ALIVE) regardless of how long the
// wallpaper has been running.
function activeGlowSparks(timeSeconds) {
  const period = GLOW_SPARK_SCHEDULE_SPAN_SECONDS;
  const periodIndex = Math.floor(timeSeconds / period);
  const localTime = timeSeconds - periodIndex * period; // 0 <= localTime < period

  const active = [];

  // Current period: walk backward from the last spawned-by-localTime entry.
  let idx = findLastSpawnedIndex(localTime);
  while (idx >= 0 && active.length < GLOW_SPARK_MAX_ALIVE) {
    const spark = GLOW_SPARK_SCHEDULE[idx];
    const age = localTime - spark.spawnTime;
    if (age >= GLOW_SPARK_MAX_LIFETIME_SECONDS) break; // older entries can no longer be alive
    if (age < spark.lifetime) active.push({ spark, age });
    idx--;
  }

  // Previous period's tail: a spark spawned near the end of the previous period (real elapsed
  // time = its spawnTime + (periodIndex-1)*period) may still be alive now. Its "age" is measured
  // from `timeSeconds`, i.e. localTime + period - spark.spawnTime.
  if (active.length < GLOW_SPARK_MAX_ALIVE) {
    let prevIdx = GLOW_SPARK_SCHEDULE.length - 1;
    while (prevIdx >= 0 && active.length < GLOW_SPARK_MAX_ALIVE) {
      const spark = GLOW_SPARK_SCHEDULE[prevIdx];
      const age = localTime + period - spark.spawnTime;
      // Lifetimes vary per spark, so only the longest possible lifetime bounds the scan: a
      // shorter-lived later spark may be dead while an earlier, longer-lived one is still alive.
      if (age >= GLOW_SPARK_MAX_LIFETIME_SECONDS) break;
      if (age < spark.lifetime) active.push({ spark, age });
      prevIdx--;
    }
  }

  return active;
}

// A smooth rise-then-fade envelope over the spark's lifetime: quick brighten, slow fade.
function glowSparkEnvelope(ageFraction) {
  const riseEnd = 0.15;
  if (ageFraction < riseEnd) return smoothstep(0, riseEnd, ageFraction);
  return 1 - smoothstep(riseEnd, 1, ageFraction);
}

// Draws the chromatic glow (flowing colors) and every currently-active rising spark. `timeSeconds`
// drives both; at timeSeconds=0 this reproduces the IDL-6/7 static look almost exactly (flow
// envelopes all start at their base phase, and no spark has spawned yet at t=0 other than
// whichever schedule entries have spawnTime<=0, which there are none of by construction).
// CHROMATIC_GLOW_COLORS parsed once into [r, g, b, a] with CHROMATIC_GLOW_INTENSITY applied.
const CHROMATIC_GLOW_STOPS = CHROMATIC_GLOW_COLORS.map((color) => {
  const [r, g, b, a] = /rgba\(([^)]+)\)/.exec(color)[1].split(',').map(Number);
  return [r, g, b, Math.min(1, a * CHROMATIC_GLOW_INTENSITY)];
});

// Linearly interpolated color at t in [0, 1] along the column (0 = bottom stop, 1 = top stop).
function chromaticGlowColorAt(t) {
  const scaled = clamp01(t) * (CHROMATIC_GLOW_STOPS.length - 1);
  const index = Math.min(Math.floor(scaled), CHROMATIC_GLOW_STOPS.length - 2);
  const local = scaled - index;
  const from = CHROMATIC_GLOW_STOPS[index];
  const to = CHROMATIC_GLOW_STOPS[index + 1];
  return from.map((value, channel) => {
    const mixed = value + (to[channel] - value) * local;
    return channel < 3 ? Math.round(mixed) : mixed;
  });
}

// Chroma width (2026-09-27): the full-circle fit shrank sceneBasis, and sizing every sample from it
// narrowed the whole fan. Each sample's radius now blends from the SCREEN-relative size at the
// bottom (t=0, the pre-fit look, anchored to the screen edge the glow rises from) to the
// sceneBasis size at the tip (t=1, tied to the Earth it touches), so the fan starts wide and thins
// as it rises.
function chromaticGlowSampleRadius(t) {
  const screenRadius = Math.min(W, H) * CHROMATIC_GLOW_RADIUS_FRACTION;
  const tipRadius = activeSceneBasis() * CHROMATIC_GLOW_RADIUS_FRACTION;
  return mix(screenRadius, tipRadius, t);
}

// Horizontal stretch of one sample (the IDL-16 fan, see drawChromaticGlowAnimated below).
function chromaticGlowSampleWidthScale(t) {
  return mix(CHROMATIC_GLOW_BASE_WIDTH_SCALE, 1, t);
}

// Half the horizontal extent of one sample: what the fan's width actually is at height t.
function chromaticGlowSampleHalfWidth(t) {
  return chromaticGlowSampleRadius(t) * chromaticGlowSampleWidthScale(t);
}

function drawChromaticGlowAnimated(context, cx, earthCy, earthRadius, timeSeconds) {
  const baseY = H * CHROMATIC_GLOW_Y_FRACTION;
  // IDL-13: derived from Earth geometry (was a fixed CHROMATIC_GLOW_HEIGHT_FRACTION) so the
  // topmost stacked glow's center always lands exactly on the Earth's bottom limb
  // (earthCy + earthRadius), at any aspect ratio/resolution, per user request that the glow
  // visibly reach/touch the planet's lower edge.
  const earthBottomLimbY = earthCy + earthRadius;
  const columnHeight = Math.max(0, baseY - earthBottomLimbY);
  // IDL-16: degenerate-column guard. At an extreme aspect ratio the Earth's bottom limb can sit at
  // or below baseY, collapsing columnHeight to (effectively) 0 — every sample would then land on
  // the exact same y, and stacking CHROMATIC_GLOW_SAMPLE_COUNT (16) identical 'lighter'-composited
  // circles on top of each other would compound into one badly over-bright blob instead of a
  // gradient. Fall back to a single sample in that case.
  const isDegenerateColumn = columnHeight < 1;
  const sampleCount = isDegenerateColumn ? 1 : CHROMATIC_GLOW_SAMPLE_COUNT;
  context.save();
  context.globalCompositeOperation = 'lighter';
  for (let i = 0; i < sampleCount; i++) {
    // Guarded against sampleCount === 1 (degenerate column, or CHROMATIC_GLOW_SAMPLE_COUNT itself
    // ever configured to 1): i/(sampleCount-1) would divide by zero (0/0 = NaN) there. t=1 in that
    // case reuses the tip's own unchanged appearance (see CHROMATIC_GLOW_BASE_WIDTH_SCALE comment
    // below) rather than an undefined position.
    const t = sampleCount > 1 ? i / (sampleCount - 1) : 1;
    const y = baseY - t * columnHeight;
    const [r, g, b, a] = chromaticGlowColorAt(t);
    // Slow brightness undulation along the column, phase-offset by height so it flows upward.
    const phase = (timeSeconds / CHROMATIC_GLOW_FLOW_PERIOD_SECONDS + t * 0.7) * TAU;
    const flow = 0.75 + 0.25 * Math.sin(phase);
    // IDL-16: fan/inverted-cone shape. t=1 is the tip touching the Earth's bottom limb: width scale
    // 1 and the sceneBasis-sized radius. t=0 (the bottom, screen-edge sample) is stretched
    // horizontally by CHROMATIC_GLOW_BASE_WIDTH_SCALE via a horizontal-only context.scale around the
    // sample's own center, turning the circle into an ellipse. Since the chroma-width fix the radius
    // itself also grows toward the bottom (see chromaticGlowSampleRadius), so the lower samples get
    // taller too; that extra height mostly falls below the screen edge and only thickens the overlap
    // between samples, so the column stays continuous.
    const widthScale = chromaticGlowSampleWidthScale(t);
    const radius = chromaticGlowSampleRadius(t);
    // A wider ellipse spreads the same peak alpha over more area; under 'lighter' (additive)
    // compositing that would otherwise make the wide bottom read as a more saturated blob than the
    // narrow top. Compensate with 1/sqrt(widthScale): gentler than a full 1/widthScale (which would
    // make the widest samples nearly invisible) while still visibly balancing brightness across the
    // fan. widthScale is 1 at the tip, so this is a no-op there — the top is byte-for-byte
    // unchanged from before this task.
    const alphaScale = 1 / Math.sqrt(widthScale);
    context.save();
    context.translate(cx, y);
    context.scale(widthScale, 1);
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius);
    gradient.addColorStop(0, `rgba(${r},${g},${b},${(Math.min(1, a * flow * alphaScale * (isMiniVariant ? MINI_CHROMATIC_GLOW_GAIN : 1))).toFixed(3)})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(0, 0, radius, 0, TAU);
    context.fill();
    context.restore();
  }
  context.restore();

  const sparkSize = GLOW_SPARK_SIZE_FRACTION * activeSceneBasis();
  const jitterRange = GLOW_SPARK_HORIZONTAL_JITTER_FRACTION * activeSceneBasis();
  // IDL-13: the rise distance is now derived (baseY - earthCy) instead of a fixed fraction of H,
  // so a spark always rises exactly to the Earth's horizontal middle line regardless of
  // resolution/aspect ratio; GLOW_SPARK_LIFETIME_SECONDS/_SPAWN_INTERVAL_SECONDS (config.js) are
  // scaled to match this longer distance so both the rise speed and the expected-alive count stay
  // what they were before this change.
  const maxRise = Math.max(0, baseY - earthCy);
  // Belt-and-suspenders: never rise above the Earth's horizontal middle line even if maxRise or
  // rounding ever put a sample a hair past it.
  const lowestAllowedY = earthCy;
  for (const { spark, age } of activeGlowSparks(timeSeconds)) {
    const ageFraction = clamp01(age / spark.lifetime);
    const envelope = glowSparkEnvelope(ageFraction);
    if (envelope <= 0.001) continue;
    const rise = smoothstep(0, 1, ageFraction) * maxRise;
    const y = Math.max(lowestAllowedY, baseY - rise);
    const x = cx + spark.offsetT * jitterRange;
    const intensity = spark.peakIntensity * envelope;
    drawSpark(context, x, y, sparkSize * spark.sizeJitter, intensity, GLOW_SPARK_COLOR);
  }
}

// --- Main animation loop (Linux port) ----------------------------------------------------------

// Linux port of the reference loop section. A4 restored the CielWin alert clock (alertSceneMs) and the
// renderAlertOverlay stage as marked blocks plus the see-through-hook stamp. Adds the processing cadence wrapper,
// synthetic transport probes and the one-shot CIELINUX_SCENE_DRAW_READY_V1 token. scheduleFrame,
// createRenderStageReporter and resetCanvasStateForFrame come from the local js/render-loop.js adapter.
let animationStartMs = null;

const reportRenderError = createRenderStageReporter("[idle-scene]");

// Synthetic one-shot transport probes, not GPU failures or a readiness handshake.
// A missing/throwing console must not interrupt scene initialization.
try { console.info("CIELINUX_DIAGNOSTICS_JS_INFO synthetic transport probe"); } catch (_) {}
try { console.warn("CIELINUX_DIAGNOSTICS_JS_WARN synthetic transport probe"); } catch (_) {}
try { console.error("CIELINUX_DIAGNOSTICS_JS_ERROR synthetic transport probe"); } catch (_) {}

// Fixed storage, cumulative observational metrics; no scheduling authority.
function createCadence(scene) {
    const bounds = [8, 17, 34, 50, 100, 250, Infinity];
    const dt = [0, 0, 0, 0, 0, 0, 0], work = dt.slice();
    let raf = 0, eligible = 0, draw = 0, err = 0, workN = 0;
    let origin = null, last = null, latest = null, maxgap = 0;
    let boundary = 10000, periodic = 0, final = false;
    const valid = value => Number.isFinite(value) && value >= 0;
    function sample(bins, value) {
        if (valid(value)) bins[bounds.findIndex(bound => value <= bound)]++;
    }
    function now() {
        try { return performance.now(); } catch (_) { return NaN; }
    }
    function emit(kind) {
        if (origin === null || latest === null) return;
        const elapsed = Math.min(latest - origin, Number.MAX_SAFE_INTEGER);
        try {
            console.info(`CADENCE scene=${scene} kind=${kind} elapsed_ms=${Math.round(elapsed)} raf=${raf} eligible=${eligible} draw=${draw} err=${err} dt=[${dt}] work=[${work}] work_n=${workN} maxgap_ms=${Math.round(maxgap)}`);
        } catch (_) { /* Observation must not change rendering. */ }
    }
    const api = {
        entry(ms) {
            raf++;
            if (valid(ms) && (latest === null || ms >= latest)) {
                if (origin === null) origin = ms;
                latest = ms;
            }
        },
        begin() { eligible++; return now(); },
        error() { err++; },
        complete(ms) {
            draw++;
            if (valid(ms) && (last === null || ms >= last)) {
                if (last !== null) {
                    const gap = ms - last;
                    sample(dt, gap);
                    maxgap = Math.min(Math.max(maxgap, gap), Number.MAX_SAFE_INTEGER);
                }
                last = ms;
            }
        },
        end(start) {
            const end = now();
            if (valid(start) && valid(end) && end >= start) {
                sample(work, end - start); workN++;
            }
            if (!final && origin !== null && latest - origin >= boundary && periodic < 12) {
                periodic++;
                const elapsed = latest - origin;
                boundary = (Math.floor(elapsed / 10000) + 1) * 10000;
                if (boundary <= elapsed) boundary = Infinity;
                emit('periodic');
            }
        },
        finish() { if (!final) { final = true; emit('final'); } }
    };
    try {
        window.addEventListener('pagehide', api.finish);
        window.addEventListener('beforeunload', api.finish);
    } catch { /* Native shutdown need not deliver either event. */ }
    return api;
}
var cadence = createCadence('idle');
// Forward the native receiver/arguments/ID and callback receiver/arguments unchanged.
var nativeRequestAnimationFrame = window.requestAnimationFrame;
window.requestAnimationFrame = function (callback, ...args) {
  if (typeof callback !== 'function') {
    return Function.prototype.apply.call(nativeRequestAnimationFrame, this, arguments);
  }
  return Function.prototype.apply.call(nativeRequestAnimationFrame, this, [function (...callbackArgs) {
    cadence.entry(callbackArgs[0]);
    return Function.prototype.apply.call(callback, this, callbackArgs);
  }, ...args]);
};

var drawReadyAttempted = false;
function renderFrame(nowMs) {
  var workStart = cadence.begin();
  // Linux port begin (A4): the value the alert overlay's see-through hook needs (CielWin's
  // `timeSeconds = 0` default).
  var alertSceneTime = 0;
  // Linux port end.
  try {
    // A4: shared/js/alert-overlay.js's alertSceneMs freezes the scene clock while a FAILED tile
    // shakes; otherwise it returns the rAF timestamp (minus earlier shakes). CielWin parity.
    const sceneMs = alertSceneMs(nowMs);
    if (animationStartMs === null) animationStartMs = sceneMs;
    const timeSeconds = (sceneMs - animationStartMs) / 1000;
    alertSceneTime = timeSeconds;

    // mini-scene-window T2: the mini variant centers the ring in its square viewport and fits it to
    // min(W, H) (config.js's miniSceneBasis); the full scene keeps its own fit unchanged.
    const cx = isMiniVariant ? W / 2 : W * CENTER_X_FRACTION;
    const cy = isMiniVariant ? H / 2 : H * CENTER_Y_FRACTION;
    const basis = activeSceneBasis();
    // Mini puts the planet at the exact ring center; the full scene keeps it offset above it.
    const earthCx = isMiniVariant ? cx : cx + EARTH_CENTER_X_OFFSET_FRACTION * basis;
    const earthCy = isMiniVariant ? cy : cy + EARTH_CENTER_Y_OFFSET_FRACTION * basis;

    // Rebuild on a basis (CSS-pixel) size change OR a DPR change.
    if (!ringCaches || ringCacheBasis !== basis || ringCacheDpr !== DPR) buildRingCaches(cx, cy, basis, DPR);

    ctx.clearRect(0, 0, W, H);
    // Mini: the canvas stays fully transparent (no background fill).
    if (!isMiniVariant) {
      ctx.fillStyle = BACKGROUND_COLOR;
      ctx.fillRect(0, 0, W, H);
    }

    const earthRadius = basis * EARTH_RADIUS_FRACTION;
    const earthLongitude = EARTH_LONGITUDE + (EARTH_ROTATION_DEGREES_PER_SECOND * Math.PI / 180) * timeSeconds;

    if (!isMiniVariant) drawStarfield(ctx, cx, cy, basis * STARFIELD_INNER_RADIUS_FRACTION, timeSeconds);
    drawDiscBorder(ctx, cx, cy, basis * DISC_BORDER_INNER_RADIUS_FRACTION, basis * DISC_BORDER_OUTER_RADIUS_FRACTION);

    // IDL-12 perf: draw every ring's (unlit) rotated content first, then ONE combined lighting mask.
    for (let i = 0; i < RING_ANIMATIONS.length; i++) {
      const angle = RING_ANIMATIONS[i].speed * timeSeconds;
      drawCachedRingContent(ctx, ringCaches[i], cx, cy, angle);
      // Linux port begin (A4): js/see-through-hook.js re-stamps exactly this draw (CielWin D6c).
      if (RING_ANIMATIONS[i].name === 'constellation') constellationRingStamp = { cache: ringCaches[i], cx: cx, cy: cy, angle: angle };
      // Linux port end.
    }
    // Mini skips the lighting mask: it is a multiply over the whole ring annuli, which on the see-through
    // canvas (no black behind it) paints an opaque metallic grey instead of darkening the ring.
    if (!isMiniVariant) drawCombinedLightingMask(ctx, cx, cy);

    drawInnerRing(ctx, cx, cy, basis * INNER_RING_RADIUS_FRACTION);
    drawEarth(ctx, earthCx, earthCy, earthRadius, earthLongitude, timeSeconds);

    // Mini keeps the chroma fan and its sparks (additive 'lighter' gradients) but drops the vignette.
    drawChromaticGlowAnimated(ctx, cx, earthCy, earthRadius, timeSeconds);
    if (!isMiniVariant) drawVignette(ctx);
    // Mini: occlude the background under the ring bands, then fade everything out before the window edges.
    if (isMiniVariant) {
      drawMiniRingBases(ctx, cx, cy, basis);
      applyMiniEdgeFade(ctx, W, H);
    }
    if (!drawReadyAttempted && W > 0 && H > 0) {
      drawReadyAttempted = true; // Attempt once even if the console throws.
      try { console.log('CIELINUX_SCENE_DRAW_READY_V1 idle'); } catch (_) {}
    }
    cadence.complete(nowMs);
  } catch (error) {
    cadence.error();
    resetCanvasStateForFrame();
    reportRenderError("scene", error);
  } finally {
    cadence.end(workStart);
  }
  // Linux port begin (A4): the shared alert overlay draws last, over the finished (edge-faded) scene,
  // in its own try so a failing overlay never stops the scene (CielWin parity). It gets the real
  // timestamp; the scene above drew with alertSceneMs's frozen clock while a FAILED tile shakes.
  try {
    renderAlertOverlay(nowMs, W, H, alertSceneTime);
  } catch (error) {
    resetCanvasStateForFrame();
    reportRenderError("alert-overlay", error);
  }
  // Linux port end.
  scheduleFrame(renderFrame);
}

function startAnimation() {
  animationStartMs = null;
  scheduleFrame(renderFrame);
}
