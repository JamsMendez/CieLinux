// html-wallpaper-demo D6a: copied verbatim from docs/great-sage/background-explorer/js/math.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source own header/body follow unchanged.

// math.js — generic numeric helpers and the shared seeded PRNG (rnd).
// Loads after config.js. Depends on nothing else.
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;
const fract = (x) => x - Math.floor(x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

// Angle-based top-light brightness, symmetric left/right around straight up (angle = -TAU/4).
// Fit empirically against pixel-sampled brightness at several angles around the alphabet ring
// in the reference image (0deg=207, 40deg=151, 60deg=99, 80deg=49, 90deg=37, 110deg=19,
// 140deg=14, out of a 0-255 scale) rather than assumed: a cosine falloff for the main lobe
// (matches the measured curve closely from 0-90deg) plus a small ambient floor that itself
// fades out by LIGHT_AMBIENT_FADE_ANGLE, capturing the low-but-nonzero brightness the reference
// still shows past 90deg instead of a hard cutoff. `angle` is in standard canvas radians
// (0 = +x axis); brightness depends only on the angular distance from straight up, so left and
// right at the same distance are always equal.
// When true, every ring draw function's brightness reads as full (1) regardless of angle. Used
// only while baking a ring's raw content into its offscreen cache (see rings.js): the cache holds
// unlit content once, then the screen-fixed lighting mask (built from this same function, with
// this flag false) is composited on top every frame as the ring rotates underneath it.
let bakingRingContent = false;

function verticalLightBrightness(angle) {
  if (bakingRingContent) return 1;
  // Angular distance from straight up, in [0, PI]: 0 at the top, PI at the bottom.
  // "Straight up" is angle = -PI/2, so the unit vector for `angle` compared to (0,-1) gives
  // cos(distanceFromTop) = -sin(angle).
  const cosDistance = Math.max(-1, Math.min(1, -Math.sin(angle)));
  const distanceFromTop = Math.acos(cosDistance);
  const cosinePart = Math.max(0, Math.cos(distanceFromTop)) * LIGHT_COSINE_WEIGHT;
  const ambientPart = LIGHT_AMBIENT_FLOOR * Math.max(0, 1 - distanceFromTop / LIGHT_AMBIENT_FADE_ANGLE);
  const curve = clamp01(mix(LIGHT_BOTTOM_BRIGHTNESS, LIGHT_TOP_BRIGHTNESS, cosinePart + ambientPart));
  // IDL-11: the 0-90ish-degree falloff above (top through side) is unchanged — this is the same
  // fitted curve as before. Past that, the curve was fading all the way to 0 by ~170deg, making
  // ring content unreadable near the true bottom. Blend up toward LIGHT_BOTTOM_FLOOR (a hard floor
  // at 180deg = straight down) via a linear-in-angle ramp, taking whichever of the old curve or
  // the ramp is brighter at each angle — so the ramp only ever raises the far side/bottom, never
  // dims the already-correct top/side region (the ramp itself is far below `curve` there).
  const floorRamp = LIGHT_BOTTOM_FLOOR * (distanceFromTop / Math.PI);
  return Math.max(curve, floorRamp);
}

// 3D vector helpers used by earth.js for sphere-surface noise sampling.
function normalize3([x, y, z]) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
