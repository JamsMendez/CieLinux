// html-wallpaper-demo D6c: copied verbatim from docs/great-sage/background-idle/js/earth.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged.

// earth.js — procedural grayscale globe. Loads after config.js and math.js.
//
// Animation-friendly design (IDL-8): fractal noise runs exactly once, at load, to bake a flat
// equirectangular (lon x lat) surface texture with no lighting baked in. Per resize, a second
// one-time pass builds a disc lookup: for every pixel inside the on-screen circle it stores the
// base longitude, latitude, and the (rotation-independent) lighting multiplier for that point on
// the sphere. Spinning the globe each frame is then just: for every disc pixel, add the current
// longitude offset to its stored base longitude, sample the equirectangular texture (bilinear),
// multiply by the stored lighting value, write the pixel — no trigonometry-heavy per-pixel noise,
// no re-deriving the lighting model, at any frame rate.

// Deterministic 3D value-noise lattice: a fixed-size cube of pseudo-random gradients hashed by
// integer lattice coordinates, trilinearly interpolated. Fully seeded, no per-frame randomness.
function makeNoiseHash(seed) {
  const table = new Float32Array(4096);
  const random = mulberry32(seed);
  for (let i = 0; i < table.length; i++) table[i] = random();
  return function hash3(x, y, z) {
    const h = (x * 374761393 + y * 668265263 + z * 2147483647) ^ (x * 2246822519);
    return table[Math.abs(h) & 4095];
  };
}

function valueNoise3(hash3, x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = smoothstep(0, 1, xf), v = smoothstep(0, 1, yf), w = smoothstep(0, 1, zf);
  const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = mix(c000, c100, u), x10 = mix(c010, c110, u);
  const x01 = mix(c001, c101, u), x11 = mix(c011, c111, u);
  const y0 = mix(x00, x10, v), y1 = mix(x01, x11, v);
  return mix(y0, y1, w);
}

function fractalNoise3(hash3, x, y, z, octaves) {
  let value = 0, amplitude = 0.5, frequency = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    value += amplitude * valueNoise3(hash3, x * frequency, y * frequency, z * frequency);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / total;
}

const EARTH_TERRAIN_HASH = makeNoiseHash(EARTH_NOISE_SEED);
const EARTH_CLOUD_HASH = makeNoiseHash((EARTH_NOISE_SEED ^ 0x5bd1e995) >>> 0);

// --- Equirectangular surface bake (once, at load) ---------------------------------------------
// width = 2x height so longitude (0..2*PI) and latitude (-PI/2..PI/2) have equal angular
// resolution per pixel. No lighting: this is pure surface color (ocean/land/cloud), grayscale.
const EARTH_EQUIRECT_HEIGHT = 320;
const EARTH_EQUIRECT_WIDTH = EARTH_EQUIRECT_HEIGHT * 2;

function renderEquirectangularTexture() {
  const w = EARTH_EQUIRECT_WIDTH, h = EARTH_EQUIRECT_HEIGHT;
  // Float32 per channel keeps the later per-frame bilinear resample simple and avoids repeated
  // Uint8 rounding error when the same texel is sampled at slightly different offsets each frame.
  const rgb = new Float32Array(w * h * 3);

  for (let py = 0; py < h; py++) {
    const lat = (py / (h - 1) - 0.5) * Math.PI; // -PI/2..PI/2
    const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
    for (let px = 0; px < w; px++) {
      const lon = (px / w) * TAU; // 0..2*PI
      const sx = cosLat * Math.cos(lon);
      const sz = cosLat * Math.sin(lon);
      const sy = sinLat;

      const terrain = fractalNoise3(EARTH_TERRAIN_HASH, sx * 1.8, sy * 1.8, sz * 1.8, 5);
      const clouds = fractalNoise3(EARTH_CLOUD_HASH, sx * 3.4 + 5, sy * 3.4 + 5, sz * 3.4 + 5, 5);

      const isLand = terrain > EARTH_LAND_THRESHOLD;
      const oceanDepth = clamp01((terrain - (EARTH_LAND_THRESHOLD - 0.28)) / 0.28);
      let r, g, b;
      if (isLand) {
        [r, g, b] = EARTH_LAND_COLOR;
      } else {
        r = mix(EARTH_OCEAN_COLOR_DEEP[0], EARTH_OCEAN_COLOR_SHALLOW[0], oceanDepth);
        g = mix(EARTH_OCEAN_COLOR_DEEP[1], EARTH_OCEAN_COLOR_SHALLOW[1], oceanDepth);
        b = mix(EARTH_OCEAN_COLOR_DEEP[2], EARTH_OCEAN_COLOR_SHALLOW[2], oceanDepth);
      }

      // Clouds only read on the sunlit cap in the final render; the equirect bake stores every
      // latitude's cloud cover unconditionally (upFacing/lighting is applied later, per frame,
      // from the disc lookup — not baked into this texture).
      if (clouds > EARTH_CLOUD_THRESHOLD) {
        const cloudAmount = clamp01((clouds - EARTH_CLOUD_THRESHOLD) / (1 - EARTH_CLOUD_THRESHOLD));
        r = mix(r, EARTH_CLOUD_COLOR[0], cloudAmount * 0.92);
        g = mix(g, EARTH_CLOUD_COLOR[1], cloudAmount * 0.92);
        b = mix(b, EARTH_CLOUD_COLOR[2], cloudAmount * 0.92);
      }

      const idx = (py * w + px) * 3;
      rgb[idx] = r;
      rgb[idx + 1] = g;
      rgb[idx + 2] = b;
    }
  }
  return { width: w, height: h, rgb };
}
const EARTH_EQUIRECT = renderEquirectangularTexture();

// Bilinear sample of the equirect texture at (lon, lat); lon wraps, lat clamps to the poles.
function sampleEquirect(lon, lat) {
  const w = EARTH_EQUIRECT.width, h = EARTH_EQUIRECT.height, rgb = EARTH_EQUIRECT.rgb;
  const u = (fract(lon / TAU) * w + w) % w; // wrap
  const v = clamp01((lat / Math.PI) + 0.5) * (h - 1); // clamp at poles
  const u0 = Math.floor(u) % w, u1 = (u0 + 1) % w;
  const v0 = Math.floor(v), v1 = Math.min(v0 + 1, h - 1);
  const fu = u - Math.floor(u), fv = v - v0;

  const i00 = (v0 * w + u0) * 3, i10 = (v0 * w + u1) * 3;
  const i01 = (v1 * w + u0) * 3, i11 = (v1 * w + u1) * 3;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = mix(rgb[i00 + c], rgb[i10 + c], fu);
    const bottom = mix(rgb[i01 + c], rgb[i11 + c], fu);
    out[c] = mix(top, bottom, fv);
  }
  return out;
}

// --- Per-disc lighting/geometry lookup (rebuilt only when the on-screen radius changes) --------
// One entry per pixel inside the disc: base longitude/latitude (at longitude offset 0) plus the
// final per-pixel light multiplier and grayscale atmosphere-rim tint amount — everything that
// does NOT depend on the current spin, so it is computed exactly once per resize.
let earthDiscLookup = null; // { size, lon:Float32Array, lat:Float32Array, light:Float32Array, rim:Float32Array, inside:Uint8Array }
let earthDiscLookupSize = -1;

function buildEarthDiscLookup(size) {
  const radius = size / 2 - 1;
  const lon = new Float32Array(size * size);
  const lat = new Float32Array(size * size);
  const light = new Float32Array(size * size);
  const rim = new Float32Array(size * size);
  const inside = new Uint8Array(size * size);

  for (let py = 0; py < size; py++) {
    const ny = (py - radius) / radius;
    for (let px = 0; px < size; px++) {
      const idx = py * size + px;
      const nx = (px - radius) / radius;
      const distanceSquared = nx * nx + ny * ny;
      if (distanceSquared > 1) continue; // outside[idx] stays 0 (transparent)
      const nz = Math.sqrt(1 - distanceSquared);

      inside[idx] = 1;
      lat[idx] = Math.asin(Math.max(-1, Math.min(1, -ny))); // ny in [-1,1]; -ny is sin(lat) directly
      lon[idx] = Math.atan2(nz, nx); // base longitude at zero spin offset; atan2 keeps it continuous

      const upFacing = clamp01(-ny * 0.95 + 0.12);
      const viewFacing = clamp01(nz);
      const dayWeight = Math.pow(upFacing, 1 / Math.max(EARTH_TERMINATOR_SOFTNESS, 0.05)) * (0.65 + 0.35 * viewFacing);
      let l = mix(EARTH_NIGHT_FLOOR, EARTH_DAY_BRIGHTNESS, dayWeight);
      const limb = 0.6 + 0.4 * viewFacing;
      l *= limb;
      light[idx] = l;

      // Cloud visibility also depends only on the fixed lighting geometry (upFacing), not on
      // spin, so it is folded into a per-pixel multiplier applied to the sampled cloud blend at
      // draw time via a second lookup value stored in `rim`'s companion below.
      rim[idx] = dayWeight * Math.pow(1 - viewFacing, 3) * 0.6;
    }
  }
  return { size, lon, lat, light, rim, inside };
}

// Cloud visibility multiplier (upper-cap-only clouds) shares the same upFacing term as lighting;
// stored separately so renderEarthFrame can re-blend the equirect texture's unconditional cloud
// bake down to "visible only near the top" without re-deriving geometry per frame.
let earthCloudVisibilityLookup = null;

function buildEarthCloudVisibilityLookup(size) {
  const radius = size / 2 - 1;
  const out = new Float32Array(size * size);
  for (let py = 0; py < size; py++) {
    const ny = (py - radius) / radius;
    const upFacingForClouds = clamp01(-ny * 0.9 + 0.35);
    const v = smoothstep(0.22, 0.6, upFacingForClouds);
    for (let px = 0; px < size; px++) out[py * size + px] = v;
  }
  return out;
}

// Linux wallpaper optimization begin (W1): odd/tasks/wallpaper-explorer-idle-cpu.md. The equirect bake is
// grayscale (every EARTH_*_COLOR has r = g = b), so every texel has r = g = b and the reference loop below
// computes the same value three times per pixel. When that holds (checked once at load), this path computes
// it once with the reference expressions in the reference order (identical doubles, identical bytes) and
// writes the pixel as one 32-bit word. The wrap `(fract(x) * ew + ew) % ew` is rewritten without the float
// modulo: s = fract(x) * ew + ew lies in [ew, 2 * ew], where s % ew is exactly s - ew (or 0 at 2 * ew), so
// the result is bit-identical. Per-size tables hold the inside pixels' lookups (exact Float32 copies of
// the Float32 lookups) and the reference latitude row terms. Falls back to the reference loop otherwise.
const EARTH_EQUIRECT_GRAY = (() => {
  const rgb = EARTH_EQUIRECT.rgb, texels = EARTH_EQUIRECT.width * EARTH_EQUIRECT.height;
  const gray = new Float32Array(texels);
  for (let i = 0; i < texels; i++) {
    if (rgb[i * 3] !== rgb[i * 3 + 1] || rgb[i * 3] !== rgb[i * 3 + 2]) return null;
    gray[i] = rgb[i * 3];
  }
  return gray;
})();
const EARTH_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
let earthGrayTables = null;

function buildEarthGrayTables(lookup, cloudVisibility, imageData) {
  const { lon, lat, light, rim, inside } = lookup;
  const ew = EARTH_EQUIRECT.width, eh = EARTH_EQUIRECT.height;
  let count = 0;
  for (let idx = 0; idx < inside.length; idx++) count += inside[idx];
  const tables = {
    lookup, imageData, count, words: new Int32Array(imageData.data.buffer, imageData.data.byteOffset, inside.length),
    pixel: new Int32Array(count), lon: new Float32Array(count), rowLo: new Int32Array(count), rowHi: new Int32Array(count),
    fv: new Float64Array(count), light: new Float32Array(count), rim: new Float32Array(count), cv: new Float32Array(count),
  };
  for (let idx = 0, k = 0; idx < inside.length; idx++) {
    if (!inside[idx]) continue;
    const v = clamp01((lat[idx] / Math.PI) + 0.5) * (eh - 1); // reference expression
    const v0 = Math.floor(v), v1 = Math.min(v0 + 1, eh - 1);
    tables.pixel[k] = idx;
    tables.lon[k] = lon[idx];
    tables.rowLo[k] = v0 * ew;
    tables.rowHi[k] = v1 * ew;
    tables.fv[k] = v - v0;
    tables.light[k] = light[idx];
    tables.rim[k] = rim[idx];
    tables.cv[k] = cloudVisibility[idx];
    k++;
  }
  return tables;
}

function renderEarthGrayPixels(longitude) {
  let tables = earthGrayTables;
  if (tables === null || tables.lookup !== earthDiscLookup || tables.imageData !== earthFrameImageData) {
    tables = earthGrayTables = buildEarthGrayTables(earthDiscLookup, earthCloudVisibilityLookup, earthFrameImageData);
  }
  const gray = EARTH_EQUIRECT_GRAY, ew = EARTH_EQUIRECT.width, ew2 = ew * 2;
  const { count, words, pixel, lon, rowLo, rowHi, fv: fvs, light, rim, cv: cvs } = tables;
  for (let k = 0; k < count; k++) {
    const x = (lon[k] + longitude) / TAU;
    const s = (x - Math.floor(x)) * ew + ew;
    const u = s >= ew2 ? s - ew2 : s - ew; // === s % ew (see above)
    const u0 = u | 0, u1 = u0 + 1 === ew ? 0 : u0 + 1; // 0 <= u < ew: truncation === Math.floor
    const fu = u - u0, fv = fvs[k];
    const lo = rowLo[k], hi = rowHi[k];
    const a00 = gray[lo + u0], a10 = gray[lo + u1], a01 = gray[hi + u0], a11 = gray[hi + u1];
    const top = a00 + (a10 - a00) * fu, bottom = a01 + (a11 - a01) * fu;
    const r0 = top + (bottom - top) * fv;
    const cv = cvs[k], rimAmount = rim[k];
    const dim = r0 * 0.55;
    let rr = dim + (r0 - dim) * cv;
    rr = rr + (235 - rr) * rimAmount;
    const lit = (rr * light[k]) / 255;
    const scaled = (lit < 0 ? 0 : (lit > 1 ? 1 : lit)) * 255; // clamp01(lit) * 255, in [0, 255]
    // === Math.round(scaled): for scaled >= 0.5 the sum scaled + 0.5 is exact (same binade, ulp <= 2^-45),
    // so truncating it is round-half-up; below 0.5 Math.round gives 0 (also for 0.5 - 2^-54, where the
    // rounded sum would reach 1).
    const value = scaled < 0.5 ? 0 : (scaled + 0.5) | 0;
    words[pixel[k]] = -16777216 | (value << 16) | (value << 8) | value; // 0xff000000 as int32: A=255, B=G=R
  }
}
// Linux wallpaper optimization end (W1).

const earthFrameCanvas = document.createElement('canvas');
const earthFrameCtx = earthFrameCanvas.getContext('2d');
let earthFrameImageData = null;

// Renders one frame of the globe (surface + clouds + lighting, no rim-light arc or flare — those
// stay separate draw passes in drawEarth) into the shared offscreen canvas at `size`x`size`, for
// the given `longitude` (radians). Rebuilds the disc/cloud lookups only when `size` changes.
function renderEarthFrame(size, longitude) {
  if (earthDiscLookupSize !== size) {
    earthFrameCanvas.width = size;
    earthFrameCanvas.height = size;
    earthDiscLookup = buildEarthDiscLookup(size);
    earthCloudVisibilityLookup = buildEarthCloudVisibilityLookup(size);
    earthFrameImageData = earthFrameCtx.createImageData(size, size);
    earthDiscLookupSize = size;
  }

  // Linux wallpaper optimization begin (W1): grayscale fast path, byte-identical (see renderEarthGrayPixels).
  if (EARTH_EQUIRECT_GRAY !== null && EARTH_LITTLE_ENDIAN) {
    renderEarthGrayPixels(longitude);
    earthFrameCtx.putImageData(earthFrameImageData, 0, 0);
    return earthFrameCanvas;
  }
  // Linux wallpaper optimization end (W1).
  const { lon, lat, light, rim, inside } = earthDiscLookup;
  const cloudVisibility = earthCloudVisibilityLookup;
  const data = earthFrameImageData.data;
  const count = size * size;
  // Linux mini optimization begin (O1): sampleEquirect inlined (same arithmetic, same order) so the loop
  // allocates no per-pixel [r, g, b] array.
  const ew = EARTH_EQUIRECT.width, eh = EARTH_EQUIRECT.height, erg = EARTH_EQUIRECT.rgb;
  // Linux mini optimization end.

  for (let idx = 0; idx < count; idx++) {
    const o = idx * 4;
    if (!inside[idx]) {
      data[o + 3] = 0;
      continue;
    }
    // Linux mini optimization begin (O1): inlined sampleEquirect(lon[idx] + longitude, lat[idx]).
    const sampleLon = lon[idx] + longitude, sampleLat = lat[idx];
    const u = (fract(sampleLon / TAU) * ew + ew) % ew; // wrap
    const v = clamp01((sampleLat / Math.PI) + 0.5) * (eh - 1); // clamp at poles
    const u0 = Math.floor(u) % ew, u1 = (u0 + 1) % ew;
    const v0 = Math.floor(v), v1 = Math.min(v0 + 1, eh - 1);
    const fu = u - Math.floor(u), fv = v - v0;
    const i00 = (v0 * ew + u0) * 3, i10 = (v0 * ew + u1) * 3;
    const i01 = (v1 * ew + u0) * 3, i11 = (v1 * ew + u1) * 3;
    const r0 = mix(mix(erg[i00], erg[i10], fu), mix(erg[i01], erg[i11], fu), fv);
    const g0 = mix(mix(erg[i00 + 1], erg[i10 + 1], fu), mix(erg[i01 + 1], erg[i11 + 1], fu), fv);
    const b0 = mix(mix(erg[i00 + 2], erg[i10 + 2], fu), mix(erg[i01 + 2], erg[i11 + 2], fu), fv);
    // Linux mini optimization end.
    const l = light[idx];
    const rimAmount = rim[idx];
    // The equirect bake blends clouds in unconditionally (every latitude/longitude gets its
    // cloud coverage regardless of lighting); cloudVisibility[idx] gates that back down to
    // "clouds only read near the sunlit cap" by pulling low-visibility pixels part-way back
    // toward a darker tone, cheaply, without resampling a separate cloud-free texture.
    const cv = cloudVisibility[idx];
    let rr = mix(r0 * 0.55, r0, cv);
    let gg = mix(g0 * 0.55, g0, cv);
    let bb = mix(b0 * 0.55, b0, cv);

    rr = mix(rr, 235, rimAmount);
    gg = mix(gg, 235, rimAmount);
    bb = mix(bb, 235, rimAmount);

    data[o] = Math.round(clamp01((rr * l) / 255) * 255);
    data[o + 1] = Math.round(clamp01((gg * l) / 255) * 255);
    data[o + 2] = Math.round(clamp01((bb * l) / 255) * 255);
    data[o + 3] = 255;
  }
  earthFrameCtx.putImageData(earthFrameImageData, 0, 0);
  return earthFrameCanvas;
}

// Draws the globe centered at (cx, cy) with the given on-screen `radius`, plus its rim light and
// a cross-shaped star flare on the top limb. `longitude` in radians; increases over time to spin
// the globe (see animate.js). `timeSeconds` (IDL-13) drives only the flare's blink — it never
// reaches renderEarthFrame/the disc lookup above, so the cached surface texture is unaffected.
function drawEarth(context, cx, cy, radius, longitude, timeSeconds) {
  // IDL-12: the IDL-8 fixed EARTH_TEXTURE_SIZE cap (320px) was well below the disc's actual
  // on-screen diameter at larger viewports (e.g. 644px logical at 3440x1440 DPR1, 840px physical
  // at 1680x939 DPR2), so the surface was rendered at roughly half native resolution or worse and
  // read as visibly blocky once zoomed in, even with the IDL-11 high-quality upscale (smoothing
  // can blur blockiness but cannot restore missing detail). Target native resolution at the
  // CURRENT DPR (so the internal per-pixel buffer always matches the main canvas's own backing
  // store density), capped at EARTH_TEXTURE_SIZE_MAX as a cost ceiling for very large/high-DPR
  // displays — profiled (see feature doc) to confirm this cap is not reached at either tested
  // resolution/DPR, so both render at full native density in practice.
  const size = Math.max(2, Math.min(Math.round(radius * 2 * DPR + 2), EARTH_TEXTURE_SIZE_MAX));
  const texture = renderEarthFrame(size, longitude);
  context.save();
  // IDL-11: the low-res surface texture is still cheap per-frame (unchanged above), but the
  // upscale to on-screen radius was left at the canvas default imageSmoothingQuality ('low'),
  // which reads as pixelation especially on the disc's own silhouette/limb. High-quality bilinear
  // upscaling here is a one-line, ~free fix for interior softness; the actual crisp EDGE comes
  // from the clip path below (drawn in device-resolution vector space, independent of the
  // low-res texture's own pixel grid), not from the texture itself.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.beginPath();
  // Inset the clip circle very slightly so the anti-aliased clip edge sits inside the texture's
  // own edge (which can have a faint stairstep from the low-res bake) rather than exactly on top
  // of it — the clip's own anti-aliasing then draws the crisp, smooth silhouette.
  context.arc(cx, cy, radius - 0.5, 0, TAU);
  context.clip();
  context.drawImage(texture, cx - radius, cy - radius, radius * 2, radius * 2);
  context.restore();

  // Rim light: a thin bright arc hugging only the top of the limb (roughly +-70deg from straight
  // up), feathered at both angular ends so it fades out smoothly instead of a hard-edged cap.
  // Screen-fixed (does not depend on longitude), so it is cheap to redraw every frame as-is.
  // Linux mini optimization begin (O1): the rim is screen-fixed, so on the scene canvas its 90 gradient
  // segments are painted once per geometry into a device-aligned static layer (rings.js drawStaticLayer)
  // and stamped with one drawImage per frame. paintEarthRim is the reference loop, unchanged.
  const rimExtent = radius * 1.035 + 2;
  drawStaticLayer(context, earthRimLayer, `${cx},${cy},${radius}`,
    cx - rimExtent, cy - rimExtent, cx + rimExtent, cy + rimExtent,
    (layerContext) => paintEarthRim(layerContext, cx, cy, radius));
  // Linux mini optimization end.

  // Uses the shared drawSpark(x, y, size, intensity, color, rayLength) defined in rings.js — safe
  // to call here because all scripts finish loading (and every function declaration hoists to
  // the top of its own file) before main.js ever invokes render().
  // IDL-13: the flare used to be fixed at intensity 1 (static, never changed) — now it smoothly
  // fades off and back on, deterministic from elapsed time (a plain sine wave, no Math.random),
  // looping every EARTH_FLARE_BLINK_PERIOD_SECONDS between EARTH_FLARE_BLINK_MIN_INTENSITY (~0,
  // truly off) and 1 (full brightness). Falls back to full intensity when timeSeconds is not
  // supplied (e.g. a future static single-frame caller), matching drawStarfield's own
  // default-to-0 convention elsewhere in this codebase.
  const t = typeof timeSeconds === 'number' ? timeSeconds : 0;
  const blinkPhase = (t / EARTH_FLARE_BLINK_PERIOD_SECONDS) * TAU;
  const blinkWave = (Math.sin(blinkPhase) + 1) / 2; // 0..1, smooth and periodic
  const flareIntensity = mix(EARTH_FLARE_BLINK_MIN_INTENSITY, 1, blinkWave);
  const flareSize = sceneBasis(W, H) * EARTH_FLARE_SIZE_FRACTION;
  const rayLength = sceneBasis(W, H) * EARTH_FLARE_RAY_LENGTH_FRACTION;
  drawSpark(context, cx, cy - radius * 0.98, flareSize, flareIntensity, EARTH_FLARE_COLOR, rayLength);
}

// Linux mini optimization begin (O1): the reference rim-light loop, painted into earthRimLayer (a
// createStaticLayer() shape; written out because rings.js loads after this file).
const earthRimLayer = { key: null, canvas: null, x: 0, y: 0 };

function paintEarthRim(context, cx, cy, radius) {
  const rimArcHalfAngle = (70 * Math.PI) / 180;
  const rimSegmentCount = 90;
  context.save();
  for (let s = 0; s < rimSegmentCount; s++) {
    const t0 = s / rimSegmentCount;
    const t1 = (s + 1) / rimSegmentCount;
    const a0 = -Math.PI / 2 - rimArcHalfAngle + t0 * rimArcHalfAngle * 2;
    const a1 = -Math.PI / 2 - rimArcHalfAngle + t1 * rimArcHalfAngle * 2;
    const angularFade = Math.sin(Math.PI * (t0 + t1) / 2); // 0 at both ends, 1 at the top
    if (angularFade <= 0.01) continue;
    context.beginPath();
    context.arc(cx, cy, radius * 1.035, a0, a1);
    context.arc(cx, cy, radius * 0.95, a1, a0, true);
    context.closePath();
    const rimGradient = context.createRadialGradient(cx, cy, radius * 0.95, cx, cy, radius * 1.035);
    rimGradient.addColorStop(0, 'rgba(150,200,255,0)');
    rimGradient.addColorStop(1, applyBrightness(EARTH_RIM_LIGHT_COLOR, angularFade));
    context.fillStyle = rimGradient;
    context.fill();
  }
  context.restore();
}
// Linux mini optimization end.
