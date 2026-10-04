// html-wallpaper-demo D2: verbatim port of docs/great-sage/backgroud-processing/js/sprites.js (that
// tree is reference-only, excluded from git -- see the feature doc, "Source material"). Not
// restyled: only this header comment was added, the source's own header/body follow unchanged.
//
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

// ctx.shadowBlur re-blurs every shape on every draw. The same soft glows are baked as blurred
// silhouettes (sigma = shadowBlur / 2, like the canvas shadow) in a few size buckets and
// stamped under the live, unshadowed fill and stroke.
// GLOW_BUCKET_BASE, GLOW_BUCKET_RATIO, GLOW_SPRITE_MAX_DIM, ORBIT_BLOCK_GLOW_BLUR,
// ORBIT_BLOCK_GLOW_ALPHA moved to js/config.js (SPL-2 consolidation).
const GLOW_STYLES = {
  'solid-fill': { color: '164,232,255', blur: SEGMENTED_SPHERE_GLOW_BLUR },
  'solid-stroke': { color: '164,232,255', blur: SEGMENTED_SPHERE_GLOW_BLUR, lineWidth: 1.0 },
  'outline-stroke': { color: '132,236,255', blur: SEGMENTED_SPHERE_GLOW_BLUR, lineWidth: 0.8 },
  'gridded-fill': { color: '180,238,255', blur: SEGMENTED_SPHERE_GLOW_BLUR },
  'gridded-stroke': { color: '180,238,255', blur: SEGMENTED_SPHERE_GLOW_BLUR, lineWidth: 0.72, grid: true },
  'orbit-block': { color: '255,255,255', blur: ORBIT_BLOCK_GLOW_BLUR },
};
const glowCache = new Map();

function paintGlowRect(g, k, style, width, height) {
  const w = width * k;
  const h = height * k;
  g.filter = `blur(${structurePx(style.blur, 1) / 2 * k}px)`;
  g.fillStyle = `rgb(${style.color})`;
  g.strokeStyle = g.fillStyle;
  if (!style.lineWidth) {
    g.fillRect(-w / 2, -h / 2, w, h);
    return;
  }
  g.lineWidth = structurePx(style.lineWidth, 0.5) * k;
  g.strokeRect(-w / 2, -h / 2, w, h);
  if (style.grid) {
    const grid = griddedRectangleInternalLineCoordinates({ width: w, height: h });
    g.beginPath();
    for (const xCoordinate of grid.vertical) {
      g.moveTo(xCoordinate, grid.top);
      g.lineTo(xCoordinate, grid.bottom);
    }
    for (const yCoordinate of grid.horizontal) {
      g.moveTo(grid.left, yCoordinate);
      g.lineTo(grid.right, yCoordinate);
    }
    g.stroke();
  }
}

// Linux mini optimization begin (O2): mini stamps ~80 glow sprites per frame, and each lookup above built
// a `${name}:${step}` template string. Mini keeps a second index of the same glowCache entries keyed
// by (name, numeric step), filled on first use from glowCache itself and cleared with it in
// buildSprites, so every stamp gets the very same entry (same bucket, same sprite) as the reference.
const miniGlowEntries = new Map();

function miniGlowEntriesFor(name) {
  let byStep = miniGlowEntries.get(name);
  if (!byStep) miniGlowEntries.set(name, byStep = new Map());
  return byStep;
}

// Linux mini optimization end.
function glowSprite(name, width, height) {
  const step = Math.round(Math.log(width / GLOW_BUCKET_BASE) / Math.log(GLOW_BUCKET_RATIO));
  // Linux mini optimization begin (O2): see miniGlowEntriesFor (B5: the wallpaper too).
  const miniEntries = miniGlowEntriesFor(name);
  const miniEntry = miniEntries ? miniEntries.get(step) : undefined;
  if (miniEntry) return miniEntry;
  // Linux mini optimization end.
  const key = `${name}:${step}`;
  let entry = glowCache.get(key);
  if (!entry) {
    const style = GLOW_STYLES[name];
    const bucketWidth = GLOW_BUCKET_BASE * GLOW_BUCKET_RATIO ** step;
    const bucketHeight = bucketWidth * height / width;
    const pad = structurePx(style.blur, 1) * 1.5 + structurePx(style.lineWidth || 0, 0.5);
    entry = {
      bucketWidth,
      sprite: bakeSprite(bucketWidth / 2 + pad, bucketHeight / 2 + pad,
        (g, k) => paintGlowRect(g, k, style, bucketWidth, bucketHeight), GLOW_SPRITE_MAX_DIM),
    };
    glowCache.set(key, entry);
  }
  // Linux mini optimization begin (O2): see miniGlowEntriesFor.
  if (miniEntries) miniEntries.set(step, entry);
  // Linux mini optimization end.
  return entry;
}

// Callers wrap this in ctx.save()/ctx.restore(): it leaves globalAlpha at `alpha`.
function stampGlow(name, width, height, alpha) {
  const { sprite, bucketWidth } = glowSprite(name, width, height);
  stampSprite(sprite, width / bucketWidth, alpha);
}

// Line glows: a horizontal blurred capsule baked once and drawn in three slices (two end caps
// and one stretched middle) along any segment, replacing per-draw shadowBlur on strokes.
// GLOW_LINE_BASE_WIDTH moved to js/config.js (SPL-2 consolidation).
const GLOW_LINE_STYLES = {
  'prism-edge': '255,255,245',
};

function glowLineSprite(name, lineWidth, blurPerWidth) {
  const step = Math.round(Math.log(lineWidth / GLOW_LINE_BASE_WIDTH) / Math.log(GLOW_BUCKET_RATIO));
  const key = `line:${name}:${step}`;
  let entry = glowCache.get(key);
  if (!entry) {
    const width = GLOW_LINE_BASE_WIDTH * GLOW_BUCKET_RATIO ** step;
    const blur = width * blurPerWidth;
    const pad = Math.ceil(blur * 1.5 + width / 2);
    const length = 2 * pad + 8;
    const sprite = bakeSprite(length / 2 + pad, pad, (g, k) => {
      g.filter = `blur(${blur / 2 * k}px)`;
      g.strokeStyle = `rgb(${GLOW_LINE_STYLES[name]})`;
      g.lineCap = 'round';
      g.lineWidth = width * k;
      g.beginPath();
      g.moveTo(-length / 2 * k, 0);
      g.lineTo(length / 2 * k, 0);
      g.stroke();
    }, GLOW_SPRITE_MAX_DIM * 4);
    entry = { sprite, pad, length };
    glowCache.set(key, entry);
  }
  return entry;
}

function stampGlowLine(name, lineWidth, blurPerWidth, x1, y1, x2, y2, alpha) {
  const { sprite, pad, length } = glowLineSprite(name, lineWidth, blurPerWidth);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const span = Math.hypot(dx, dy);
  const { canvas, hh } = sprite;
  const kx = canvas.width / (length + 2 * pad);
  const cap = 2 * pad * kx;
  ctx.save();
  ctx.translate(x1, y1);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.globalAlpha = alpha;
  if (span >= 2 * pad) {
    ctx.drawImage(canvas, 0, 0, cap, canvas.height, -pad, -hh, 2 * pad, 2 * hh);
    ctx.drawImage(canvas, cap, 0, canvas.width - 2 * cap, canvas.height, pad, -hh, span - 2 * pad, 2 * hh);
    ctx.drawImage(canvas, canvas.width - cap, 0, cap, canvas.height, span - pad, -hh, 2 * pad, 2 * hh);
  } else {
    ctx.drawImage(canvas, -pad, -hh, span + 2 * pad, 2 * hh);
  }
  ctx.restore();
}

function buildSprites() {
  glowCache.clear();
  // Linux mini optimization begin (O2): mini never draws the halo, soft-oval, chroma-ring, flare-body or
  // flare-ring sprites. They are read only by drawSpectralHalo, chromaEllipse, drawSoftOvalFields and
  // drawSpectralFlare, which only drawSoftOvalFields, drawLensFlares and drawChromaticSideLoops reach,
  // and main.js never calls those in mini. Mini keeps just the lazily baked glow sprites (glowCache).
  // B5: the numeric glow index serves the wallpaper too, so it is cleared with glowCache in both variants.
  miniGlowEntries.clear();
  if (isMiniVariant) {
    sprites = {};
    spritesStale = false;
    return;
  }
  // Linux mini optimization end.
  const haloReference = W * HALO_REFERENCE_WIDTH_FACTOR;
  const softOvalViewportSize = softOvalViewportAxes();
  sprites = {
    halo: WET_HALO_LAYERS.map((layer) =>
      bakeSprite(HALO_SPRITE_RADIUS, HALO_SPRITE_RADIUS, (g, k) =>
        paintHalo(g, k, HALO_SPRITE_RADIUS, layer.blur * HALO_SPRITE_RADIUS / (haloReference * layer.scale)))
    ),
    softOvals: SOFT_OVAL_FIELDS.map((field) =>
      bakeSprite(softOvalViewportSize.x * field.rx * SOFT_OVAL_SIZE_FACTOR + field.blur * SOFT_OVAL_BLUR_FACTOR * 3, softOvalViewportSize.y * field.ry * SOFT_OVAL_SIZE_FACTOR + field.blur * SOFT_OVAL_BLUR_FACTOR * 3, (g, k) => paintSoftOval(g, k, field))
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
  };
  if (sprites.softOvals.length !== SOFT_OVAL_FIELDS.length) {
    throw new Error('Soft oval sprite baking must produce one sprite per configured field.');
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
