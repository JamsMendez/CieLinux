// html-wallpaper-demo D6a: copied verbatim from docs/great-sage/background-explorer/js/rising-sparks.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source own header/body follow unchanged.

// rising-sparks.js — the explorer variant's blue layer and its field of rising star sparks.
// Loads after config.js and math.js (uses mulberry32, clamp01, smoothstep, mix). Stateless:
// every spark is derived from (slot index, time), so the field loops forever with no bookkeeping.
//
// Each of RISING_SPARK_COUNT slots owns a fixed respawn period. Within one period the slot's spark
// lives for `lifetime` seconds, then rests briefly and is replaced by a fresh spark whose origin,
// speed, and incline are rehashed from (slot, cycle). The spark rises at a constant speed; its
// horizontal velocity holds steady (an almost straight, inclined path) until BEND_START, then
// eases to zero by BEND_END so the path bends to straight up before the spark fades out.

function risingSparkRandom(index, cycle) {
  return mulberry32((RISING_SPARK_SEED ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(cycle + 1, 0x85ebca6b)) >>> 0);
}

// Linux mini optimization begin (O1): the slot schedule (lifetime, period, stagger offset) is derived once
// per slot at load into typed arrays, and each slot's per-cycle spark is rehashed only when its cycle
// changes (into a reused object), instead of two mulberry32 closures plus a fresh object per slot per
// frame. Every value comes from the same PRNG draws in the same order, so the output is unchanged.
const RISING_SPARK_SLOT_LIFETIME = new Float64Array(RISING_SPARK_COUNT);
const RISING_SPARK_SLOT_PERIOD = new Float64Array(RISING_SPARK_COUNT);
const RISING_SPARK_SLOT_OFFSET = new Float64Array(RISING_SPARK_COUNT);
for (let i = 0; i < RISING_SPARK_COUNT; i++) {
  const slotRandom = risingSparkRandom(i, -1);
  const lifetime = mix(RISING_SPARK_LIFETIME_MIN_SECONDS, RISING_SPARK_LIFETIME_MAX_SECONDS, slotRandom());
  const period = lifetime * (1 + RISING_SPARK_REST_FRACTION);
  RISING_SPARK_SLOT_LIFETIME[i] = lifetime;
  RISING_SPARK_SLOT_PERIOD[i] = period;
  RISING_SPARK_SLOT_OFFSET[i] = slotRandom() * period; // stagger slots so they never pulse together
}
const RISING_SPARK_SLOT_SPARKS = Array.from({ length: RISING_SPARK_COUNT }, (_, index) => ({
  index, cycle: NaN, age: 0, lifetime: RISING_SPARK_SLOT_LIFETIME[index], period: RISING_SPARK_SLOT_PERIOD[index],
  x0: 0, y0: 0, speed: 0, tilt: 0, bendStart: 0, bendEnd: 0, size: 0, brightness: 0,
}));

// Returns the slot's cached spark object (valid until the next call for the same slot).
function risingSparkAt(index, timeSeconds, width, height) {
  const period = RISING_SPARK_SLOT_PERIOD[index];
  const localTime = timeSeconds + RISING_SPARK_SLOT_OFFSET[index];
  const cycle = Math.floor(localTime / period);
  const spark = RISING_SPARK_SLOT_SPARKS[index];
  spark.age = localTime - cycle * period;
  if (spark.cycle === cycle) return spark;

  const random = risingSparkRandom(index, cycle);
  const x0 = random();
  const y0 = mix(RISING_SPARK_SPAWN_TOP_FRACTION, 1.02, random());
  const offCenter = (0.5 - x0) * 2; // -1 at the right edge, +1 at the left edge
  const tilt = Math.sign(offCenter || 1)
    * (RISING_SPARK_TILT_BASE + RISING_SPARK_TILT_EDGE * Math.abs(offCenter))
    * mix(0.8, 1, random());
  const bendJitter = (random() - 0.5) * 0.1;
  spark.cycle = cycle;
  spark.x0 = x0;
  spark.y0 = y0;
  spark.speed = mix(RISING_SPARK_SPEED_MIN, RISING_SPARK_SPEED_MAX, random());
  spark.tilt = tilt;
  spark.bendStart = RISING_SPARK_BEND_START + bendJitter;
  spark.bendEnd = RISING_SPARK_BEND_END + bendJitter;
  spark.size = mix(0.6, 1.4, random());
  spark.brightness = mix(0.45, 1, random());
  return spark;
}
// Linux mini optimization end.

// Normalized horizontal travel at life fraction u: the integral of (1 - smoothstep(a, b, s)) ds
// from 0 to u, i.e. full-speed drift before the bend, eased drift through it, none after.
function risingSparkDrift(u, a, b) {
  const span = b - a;
  const t = clamp01((u - a) / span);
  const easedAway = span * (t * t * t - (t * t * t * t) / 2) + Math.max(0, u - b);
  return u - easedAway;
}

// Linux mini optimization: risingSparkPositionInto writes into `out` (no per-sample object); the
// arithmetic is the reference risingSparkPosition's, which now wraps it.
function risingSparkPositionInto(spark, age, width, height, out, offset) {
  const rise = spark.speed * height * age;
  const u = age / spark.lifetime;
  const drift = spark.tilt * spark.speed * height * spark.lifetime * risingSparkDrift(u, spark.bendStart, spark.bendEnd);
  out[offset] = spark.x0 * width + drift;
  out[offset + 1] = spark.y0 * height - rise;
}

function risingSparkPosition(spark, age, width, height) {
  const out = [0, 0];
  risingSparkPositionInto(spark, age, width, height, out, 0);
  return { x: out[0], y: out[1] };
}

function risingSparkEnvelope(ageFraction) {
  return smoothstep(0, 0.1, ageFraction) * (1 - smoothstep(0.55, 1, ageFraction));
}

const RISING_SPARK_TRAIL_SAMPLES = 6;

// Linux mini optimization begin (O1): the trail points are computed into one reused Float64Array, and in
// mini a spark whose whole streak and head lie beyond the edge-fade radius (applyMiniEdgeFade's
// MINI_EDGE_FADE_OUTER circle, where the destination-in mask is fully transparent) is skipped: its pixels
// would be erased anyway. The margin covers the widest stroke half-width (0.77 px), the largest head
// radius (1.82 px) and anti-aliasing. Visible sparks issue exactly the reference draw calls.
const RISING_SPARK_CULL_MARGIN_PX = 3;
const risingSparkTrail = new Float64Array((RISING_SPARK_TRAIL_SAMPLES + 1) * 2);

function risingSparkSegmentOutside(ax, ay, bx, by, cx, cy, radiusSquared) {
  const dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / lengthSquared : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const ex = ax + t * dx - cx, ey = ay + t * dy - cy;
  return ex * ex + ey * ey > radiusSquared;
}

function risingSparkTrailOutside(cx, cy, radius) {
  const radiusSquared = radius * radius;
  for (let s = 0; s < RISING_SPARK_TRAIL_SAMPLES; s++) {
    const o = s * 2;
    if (!risingSparkSegmentOutside(risingSparkTrail[o], risingSparkTrail[o + 1],
      risingSparkTrail[o + 2], risingSparkTrail[o + 3], cx, cy, radiusSquared)) return false;
  }
  return true;
}

// Linux mini optimization (O1b): the per-segment terms of the trail loop depend only on the sample index,
// so they are evaluated once here with the loop's own expressions (identical doubles) instead of per
// segment, per spark, per frame. The stroke color prefix is the constant part of the reference template
// literal: prefix + number + ')' builds the same string (both use Number::toString).
const RISING_SPARK_SEGMENT_T = new Float64Array(RISING_SPARK_TRAIL_SAMPLES + 1);
const RISING_SPARK_SEGMENT_WIDTH = new Float64Array(RISING_SPARK_TRAIL_SAMPLES + 1); // mix(0.4, 1, t)
const RISING_SPARK_SEGMENT_LAG = new Float64Array(RISING_SPARK_TRAIL_SAMPLES + 1); // trail seconds * (1 - t)
for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++) {
  const t = s / RISING_SPARK_TRAIL_SAMPLES;
  RISING_SPARK_SEGMENT_T[s] = t;
  RISING_SPARK_SEGMENT_WIDTH[s] = mix(0.4, 1, t);
  RISING_SPARK_SEGMENT_LAG[s] = RISING_SPARK_TRAIL_SECONDS * (1 - t);
}
const RISING_SPARK_STROKE_PREFIX = `rgba(${RISING_SPARK_COLOR}, `;
// Linux mini optimization begin (O1d): user-approved smaller mini spark head (odd/tasks/mini-scene-optimization.md).
// Mini heads (atlas bake and young sparks) use this radius instead of RISING_SPARK_HEAD_RADIUS (1.3, config.js);
// the full variant is unchanged.
const RISING_SPARK_MINI_HEAD_RADIUS = 0.55; // CSS px, user-approved (2026-10-03)
// Linux mini optimization end (O1d).
// Linux mini optimization begin (O1c P1): user-approved visual-risk change (odd/tasks/mini-scene-optimization.md).
// In mini, a spark older than RISING_SPARK_TRAIL_SECONDS (all trail samples unclamped, so they are evenly
// spaced in time and the trail is a near-straight, gently bending line) is drawn as two rotated sprites,
// one per trail half split at the middle sample, instead of 6 strokes + 1 head fill. The sprites are cut
// from one atlas baked with the same segments, taper, round caps, head and 'lighter' accumulation at unit
// alpha; globalAlpha then applies the spark's alpha. Buckets: half lengths every 0.5 device px (nearest,
// placed at the chord midpoint: endpoint error <= 0.125 device px) and spark sizes every 0.1 (mini head
// radius error <= 0.0275 CSS px); measured worst point error is pinned by explorer-sprites.contract.test.mjs.
// Younger sparks keep the stroke path. The atlas is rebuilt only when W, H or DPR change.
const RISING_SPARK_SPRITE_PAD = 3; // CSS px around the streak: widest mini head radius (0.77) plus anti-aliasing
const RISING_SPARK_SPRITE_SIZE_MIN = 0.6; // spark.size = mix(0.6, 1.4, random()) in risingSparkAt
const RISING_SPARK_SPRITE_SIZE_MAX = 1.4;
const RISING_SPARK_SPRITE_SIZE_STEP = 0.1;
const RISING_SPARK_SPRITE_LENGTH_STEP_DEVICE_PX = 0.5;
let risingSparkAtlas = null;

function risingSparkAtlasFor(width, height, dpr) {
  const cached = risingSparkAtlas;
  if (cached !== null && cached.width === width && cached.height === height && cached.dpr === dpr) return cached;
  // A trail half spans half the trail seconds: its vertical extent is exactly speed * height * halfSeconds,
  // and its horizontal extent at most |tilt| times that (the drift rate never exceeds the tilt).
  const halfSeconds = RISING_SPARK_TRAIL_SECONDS / 2;
  const lengthMin = RISING_SPARK_SPEED_MIN * height * halfSeconds;
  const lengthMax = RISING_SPARK_SPEED_MAX * height * halfSeconds * Math.hypot(1, RISING_SPARK_TILT_BASE + RISING_SPARK_TILT_EDGE);
  const lengthStep = RISING_SPARK_SPRITE_LENGTH_STEP_DEVICE_PX / dpr;
  const lengthCount = Math.ceil((lengthMax - lengthMin) / lengthStep) + 1;
  const sizeCount = Math.round((RISING_SPARK_SPRITE_SIZE_MAX - RISING_SPARK_SPRITE_SIZE_MIN) / RISING_SPARK_SPRITE_SIZE_STEP) + 1;
  const lengths = new Float64Array(lengthCount), sizes = new Float64Array(sizeCount);
  for (let col = 0; col < lengthCount; col++) lengths[col] = lengthMin + col * lengthStep;
  for (let k = 0; k < sizeCount; k++) sizes[k] = RISING_SPARK_SPRITE_SIZE_MIN + k * RISING_SPARK_SPRITE_SIZE_STEP;
  const pad = RISING_SPARK_SPRITE_PAD;
  const cellWidth = Math.ceil((lengths[lengthCount - 1] + 2 * pad) * dpr);
  const cellHeight = Math.ceil(2 * pad * dpr);
  const canvas = document.createElement('canvas');
  canvas.width = lengthCount * cellWidth;
  canvas.height = 2 * sizeCount * cellHeight;
  const bake = canvas.getContext('2d');
  bake.globalCompositeOperation = 'lighter';
  bake.lineCap = 'round';
  // Cell (row = sizeIndex * 2 + half, col): the half's tail at (pad, pad), its head end at (pad + length, pad).
  for (let sizeIndex = 0; sizeIndex < sizeCount; sizeIndex++) {
    const sparkWidth = RISING_SPARK_WIDTH * sizes[sizeIndex];
    for (let half = 0; half < 2; half++) {
      for (let col = 0; col < lengthCount; col++) {
        const length = lengths[col];
        bake.setTransform(dpr, 0, 0, dpr, col * cellWidth, (sizeIndex * 2 + half) * cellHeight);
        for (let k = 1; k <= 3; k++) {
          const s = half * 3 + k;
          bake.strokeStyle = RISING_SPARK_STROKE_PREFIX + RISING_SPARK_SEGMENT_T[s] + ')';
          bake.lineWidth = sparkWidth * RISING_SPARK_SEGMENT_WIDTH[s];
          bake.beginPath();
          bake.moveTo(pad + (k - 1) / 3 * length, pad);
          bake.lineTo(pad + k / 3 * length, pad);
          bake.stroke();
        }
        if (half === 1) {
          bake.fillStyle = 'rgba(255, 255, 255, 1)';
          bake.beginPath();
          bake.arc(pad + length, pad, RISING_SPARK_MINI_HEAD_RADIUS * sizes[sizeIndex], 0, TAU);
          bake.fill();
        }
      }
    }
  }
  risingSparkAtlas = { canvas, width, height, dpr, pad, cellWidth, cellHeight,
    lengthMin, lengthStep, lengthCount, lengths,
    sizeMin: RISING_SPARK_SPRITE_SIZE_MIN, sizeStep: RISING_SPARK_SPRITE_SIZE_STEP, sizeCount, sizes };
  return risingSparkAtlas;
}

// Draws one mature spark as its two trail-half sprites: each is rotated onto its chord (trail points 0-3 and
// 3-6), centered on the chord midpoint, on top of the canvas's device-pixel scale.
function drawRisingSparkSprites(context, atlas, trail, size, alpha) {
  let sizeIndex = Math.round((size - atlas.sizeMin) / atlas.sizeStep);
  sizeIndex = sizeIndex < 0 ? 0 : (sizeIndex >= atlas.sizeCount ? atlas.sizeCount - 1 : sizeIndex);
  const drawWidth = atlas.cellWidth / atlas.dpr, drawHeight = atlas.cellHeight / atlas.dpr;
  context.globalAlpha = alpha;
  for (let half = 0; half < 2; half++) {
    const o = half * 6;
    const ax = trail[o], ay = trail[o + 1], bx = trail[o + 6], by = trail[o + 7];
    const dx = bx - ax, dy = by - ay, length = Math.sqrt(dx * dx + dy * dy);
    const cos = dx / length, sin = dy / length;
    let col = Math.round((length - atlas.lengthMin) / atlas.lengthStep);
    col = col < 0 ? 0 : (col >= atlas.lengthCount ? atlas.lengthCount - 1 : col); // never hit: the range is analytic
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    context.setTransform(canvasScaleX * cos, canvasScaleY * sin, -canvasScaleX * sin, canvasScaleY * cos,
      canvasScaleX * mx, canvasScaleY * my);
    context.drawImage(atlas.canvas, col * atlas.cellWidth, (sizeIndex * 2 + half) * atlas.cellHeight,
      atlas.cellWidth, atlas.cellHeight, -(atlas.pad + atlas.lengths[col] / 2), -atlas.pad, drawWidth, drawHeight);
  }
}
// Linux mini optimization end (O1c P1).

function drawRisingSparks(context, timeSeconds) {
  const cullRadius = isMiniVariant ? Math.min(W, H) * MINI_EDGE_FADE_OUTER + RISING_SPARK_CULL_MARGIN_PX : Infinity;
  const fadeCx = W / 2, fadeCy = H / 2;
  const trail = risingSparkTrail;
  // Linux mini optimization begin (O1c P1): mini draws mature sparks from the streak atlas (see above).
  const atlas = isMiniVariant ? risingSparkAtlasFor(W, H, DPR) : null;
  let spriteState = false;
  // Linux mini optimization end (O1c P1).
  context.save();
  context.globalCompositeOperation = 'lighter';
  context.lineCap = 'round';
  for (let i = 0; i < RISING_SPARK_COUNT; i++) {
    const spark = risingSparkAt(i, timeSeconds, W, H);
    if (spark.age > spark.lifetime) continue;
    const alpha = risingSparkEnvelope(spark.age / spark.lifetime) * spark.brightness;
    if (alpha <= 0.01) continue;

    // Streak: a tapered polyline through the spark's recent positions, so the tail follows the
    // bend instead of cutting straight across it.
    risingSparkPositionInto(spark, Math.max(0, spark.age - RISING_SPARK_TRAIL_SECONDS), W, H, trail, 0);
    for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++) {
      const sampleAge = Math.max(0, spark.age - RISING_SPARK_SEGMENT_LAG[s]); // O1b: hoisted lag
      risingSparkPositionInto(spark, sampleAge, W, H, trail, s * 2);
    }
    if (cullRadius !== Infinity && risingSparkTrailOutside(fadeCx, fadeCy, cullRadius)) continue;
    // Linux mini optimization begin (O1c P1): two sprites per mature spark; a young spark that follows
    // sprites first restores the canvas transform and alpha its strokes expect.
    if (atlas !== null && spark.age >= RISING_SPARK_TRAIL_SECONDS) {
      drawRisingSparkSprites(context, atlas, trail, spark.size, alpha);
      spriteState = true;
      continue;
    }
    if (spriteState) {
      context.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);
      context.globalAlpha = 1;
      spriteState = false;
    }
    // Linux mini optimization end (O1c P1).

    // O1b: RISING_SPARK_WIDTH * spark.size is the left operand the reference product evaluates first. The
    // last segment's t is exactly 1 (alpha * 1 === alpha), so it and the head share one alpha string.
    const sparkWidth = RISING_SPARK_WIDTH * spark.size;
    const alphaText = String(alpha);
    for (let s = 1; s <= RISING_SPARK_TRAIL_SAMPLES; s++) {
      const segmentAlpha = s === RISING_SPARK_TRAIL_SAMPLES ? alphaText : alpha * RISING_SPARK_SEGMENT_T[s];
      context.strokeStyle = RISING_SPARK_STROKE_PREFIX + segmentAlpha + ')';
      context.lineWidth = sparkWidth * RISING_SPARK_SEGMENT_WIDTH[s];
      context.beginPath();
      context.moveTo(trail[s * 2 - 2], trail[s * 2 - 1]);
      context.lineTo(trail[s * 2], trail[s * 2 + 1]);
      context.stroke();
    }

    // Linux mini optimization begin (O1d): a young mini spark's head uses the mini radius (see above).
    if (atlas !== null) {
      const miniHead = RISING_SPARK_TRAIL_SAMPLES * 2;
      context.fillStyle = 'rgba(255, 255, 255, ' + alphaText + ')';
      context.beginPath();
      context.arc(trail[miniHead], trail[miniHead + 1], RISING_SPARK_MINI_HEAD_RADIUS * spark.size, 0, TAU);
      context.fill();
      continue;
    }
    // Linux mini optimization end (O1d).
    const head = RISING_SPARK_TRAIL_SAMPLES * 2;
    context.fillStyle = 'rgba(255, 255, 255, ' + alphaText + ')';
    context.beginPath();
    context.arc(trail[head], trail[head + 1], RISING_SPARK_HEAD_RADIUS * spark.size, 0, TAU);
    context.fill();
  }
  context.restore();
}
// Linux mini optimization end.

// mini-scene-window T2: the mini variant's blue ring. drawBlueLayer's 'color' fill paints an opaque
// blue wherever the backdrop is transparent (and its 'screen' glow paints the whole canvas), which
// would fill the see-through window; 'source-atop' only tints pixels the ring already drew.
function drawBlueRingTint(context) {
  context.save();
  context.globalCompositeOperation = 'source-atop';
  context.globalAlpha = MINI_BLUE_TINT_ALPHA;
  context.fillStyle = BLUE_LAYER_TINT_COLOR;
  context.fillRect(0, 0, W, H);
  context.restore();
}

// Blue wash over the finished monochrome composition: 'color' keeps each pixel's luminance but
// takes the tint's hue/saturation, then a centered 'screen' glow brightens the middle.
function drawBlueLayer(context, cx, cy) {
  context.save();
  context.globalCompositeOperation = 'color';
  context.fillStyle = BLUE_LAYER_TINT_COLOR;
  context.fillRect(0, 0, W, H);

  context.globalCompositeOperation = 'screen';
  const radius = Math.max(W, H) * BLUE_LAYER_GLOW_RADIUS_FRACTION;
  const glow = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
  glow.addColorStop(0, BLUE_LAYER_GLOW_COLOR);
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, W, H);
  context.restore();
}
