// html-wallpaper-demo D6b: copied verbatim from docs/great-sage/background-raphael/js/scene-data.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged.

// scene-data.js — seeded scene descriptor arrays (stars, radial streaks, aurora, film
// grain, soft oval fields). Loads after config.js, math.js, and sphere.js.
// The stars/streaks/aurora/grain block below consumes the SHARED rnd()
// stream and must keep its exact call order; do not reorder or interleave other rnd()
// consumers into it.
// RAP-2b: orbit blocks (createOrbitBlocks/orbitBlocks) were removed — user: no sphere, bands or
// orbits in Raphael. Nothing after them in this file reads from the shared rnd() stream, so their
// removal does not shift any other descriptor array's seeded values.
// All atmospheric variation is seeded once so the 60-second ping-pong is exact.
// BASE_STAR_COUNT moved to js/config.js (SPL-2 consolidation).
const seededStar = (random) => {
  const bright = random() > 0.90;
  return {
    a: random() * TAU,
    z: random(),
    lane: 0.16 + random() * 1.34,
    r: bright ? 1.15 + random() * 1.85 : 0.28 + random() * 1.20,
    twinkle: random() * TAU,
    speed: 0.26 + random() * 0.78,
    warm: random() > 0.78,
    glint: bright && random() > 0.34,
  };
};
// The first BASE_STAR_COUNT stars always consume the shared stream, so the streaks, aurora, grain and
// orbit blocks below keep their values whatever BACKGROUND_PARTICLE_COUNT is. Extra stars use their own stream.
const baseStars = Array.from({ length: BASE_STAR_COUNT }, () => seededStar(rnd));
const extraStarRandom = mulberry32(0x5a17c0de);
const stars = BACKGROUND_PARTICLE_COUNT <= BASE_STAR_COUNT
  ? baseStars.slice(0, BACKGROUND_PARTICLE_COUNT)
  : baseStars.concat(Array.from({ length: BACKGROUND_PARTICLE_COUNT - BASE_STAR_COUNT }, () => seededStar(extraStarRandom)));

// RADIAL_STREAK_WIDTH_MULTIPLIER, RADIAL_STREAK_GRADIENT, RADIAL_STREAK_SOFT_LAYERS
// moved to js/config.js (SPL-2 consolidation).
const radialStreaks = Array.from({ length: 72 }, () => ({
  a: rnd() * TAU,
  z: 0.66 + rnd() * 0.34,
  lane: 0.76 + rnd() * 0.52,
  speed: 0.20 + rnd() * 0.48,
  width: rnd() < 0.16 ? 1.8 : 0.55 + rnd() * 0.85,
  alpha: 0.12 + rnd() * 0.34,
  cyan: rnd() > 0.58,
}));

const AURORA_GREEN = '65,255,120';
const AURORA_BLUE = '44,190,255';
const aurora = Array.from({ length: 34 }, () => ({
  a: rnd() * TAU,
  orbit: 0.10 + rnd() * 0.36,
  rx: 0.07 + rnd() * 0.15,
  ry: 0.05 + rnd() * 0.15,
  phase: rnd() * TAU,
  green: rnd() < 0.72,
  alpha: 0.06 + rnd() * 0.11,
}));

const filmGrain = Array.from({ length: 180 }, () => ({
  x: rnd(),
  y: rnd(),
  phase: rnd() * TAU,
  size: rnd() < 0.14 ? 1.5 : 0.55 + rnd() * 0.7,
  alpha: 0.008 + rnd() * 0.026,
}));

const RAINBOW_STOPS = [
  [0.00, '64,210,255'],
  [0.18, '72,126,255'],
  [0.38, '255,74,182'],
  [0.58, '255,228,64'],
  [0.78, '76,255,178'],
  [1.00, '64,210,255'],
];
const WET_HALO_LAYERS = [
  { scale: 1.00, blur: 7, alpha: 0.18 },
  { scale: 1.34, blur: 13, alpha: 0.10 },
];
const CHROMATIC_LOOP_GROUPS = [
  { rx: 0.110, ry: 0.220, rot: -0.05, alpha: 0.52, width: 2.4, orbitX: 0.52, orbitY: 0.50, stagger: 0 / 3, depthPhase: 0.18, spinDirection: 1 },
  { rx: 0.145, ry: 0.185, rot: 0.69, alpha: 0.44, width: 2.3, orbitX: 0.50, orbitY: 0.54, stagger: 1 / 3, depthPhase: 1.72, spinDirection: -1 },
  { rx: 0.135, ry: 0.205, rot: -0.62, alpha: 0.40, width: 2.2, orbitX: 0.54, orbitY: 0.52, stagger: 2 / 3, depthPhase: 3.34, spinDirection: 1 },
];
const SPECTRAL_FLARES = [
  { x: 0.775, y: 0.510, radius: 0.085, alpha: 0.82, orbitX: 0.040, orbitY: 0.028, orbitPhase: 0.09, stagger: 0.16 },
  { x: 0.390, y: 0.515, radius: 0.055, alpha: 0.62, orbitX: 0.030, orbitY: 0.022, orbitPhase: 0.58, stagger: 0.58 },
];
const BASE_SOFT_OVAL_FIELDS = [
  { x: 0.07, y: 0.10, rx: 0.20, ry: 0.13, rotation: -0.46, color: AURORA_GREEN, orbitX: 0.018, orbitY: 0.016, phase: 0.15, alpha: 0.110, blur: 46 },
  { x: 0.48, y: 0.05, rx: 0.17, ry: 0.10, rotation: 0.18, color: AURORA_BLUE, orbitX: 0.016, orbitY: 0.014, phase: 0.68, alpha: 0.090, blur: 44 },
  { x: 0.93, y: 0.12, rx: 0.19, ry: 0.14, rotation: 0.62, color: AURORA_GREEN, orbitX: 0.020, orbitY: 0.018, phase: 1.24, alpha: 0.105, blur: 48 },
  { x: 0.04, y: 0.48, rx: 0.16, ry: 0.22, rotation: -0.18, color: AURORA_BLUE, orbitX: 0.015, orbitY: 0.022, phase: 1.79, alpha: 0.095, blur: 45 },
  { x: 0.96, y: 0.46, rx: 0.17, ry: 0.21, rotation: 0.34, color: AURORA_GREEN, orbitX: 0.017, orbitY: 0.020, phase: 2.31, alpha: 0.100, blur: 47 },
  { x: 0.10, y: 0.90, rx: 0.21, ry: 0.12, rotation: 0.41, color: AURORA_BLUE, orbitX: 0.020, orbitY: 0.015, phase: 2.86, alpha: 0.105, blur: 49 },
  { x: 0.51, y: 0.96, rx: 0.16, ry: 0.12, rotation: -0.12, color: AURORA_GREEN, orbitX: 0.014, orbitY: 0.017, phase: 3.40, alpha: 0.090, blur: 43 },
  { x: 0.90, y: 0.88, rx: 0.20, ry: 0.14, rotation: -0.55, color: AURORA_BLUE, orbitX: 0.019, orbitY: 0.018, phase: 3.96, alpha: 0.105, blur: 50 },
  { x: 0.28, y: 0.30, rx: 0.18, ry: 0.11, rotation: -0.64, color: AURORA_GREEN, orbitX: 0.019, orbitY: 0.017, phase: 4.48, alpha: 0.095, blur: 44 },
  { x: 0.73, y: 0.29, rx: 0.17, ry: 0.13, rotation: 0.71, color: AURORA_BLUE, orbitX: 0.018, orbitY: 0.019, phase: 5.02, alpha: 0.100, blur: 46 },
  { x: 0.24, y: 0.72, rx: 0.19, ry: 0.12, rotation: 0.33, color: AURORA_BLUE, orbitX: 0.021, orbitY: 0.016, phase: 5.57, alpha: 0.095, blur: 45 },
  { x: 0.77, y: 0.69, rx: 0.18, ry: 0.14, rotation: -0.29, color: AURORA_GREEN, orbitX: 0.018, orbitY: 0.020, phase: 6.08, alpha: 0.100, blur: 48 },
];

function createSoftOvalFields(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Soft oval field count must be a non-negative integer.');
  }
  const fields = BASE_SOFT_OVAL_FIELDS.slice(0, count);
  for (let index = BASE_SOFT_OVAL_FIELDS.length; index < count; index++) {
    const generatedIndex = index - BASE_SOFT_OVAL_FIELDS.length;
    const random = mulberry32((0x3c6ef372 + generatedIndex * 0x9e3779b9) >>> 0);
    // Low-discrepancy positions and local seeds keep extra descriptors prefix-stable and isolated from rnd.
    fields.push({
      x: 0.04 + 0.92 * fract((generatedIndex + 0.5) * 0.6180339887498949),
      y: 0.05 + 0.91 * fract((generatedIndex + 0.5) * 0.7548776662466927),
      rx: 0.16 + random() * 0.05,
      ry: 0.10 + random() * 0.12,
      rotation: -0.64 + random() * 1.35,
      color: generatedIndex % 2 === 0 ? AURORA_GREEN : AURORA_BLUE,
      orbitX: 0.014 + random() * 0.007,
      orbitY: 0.014 + random() * 0.008,
      phase: random() * TAU,
      alpha: 0.090 + random() * 0.020,
      blur: 43 + Math.floor(random() * 8),
    });
  }
  return fields;
}

const SOFT_OVAL_FIELDS = createSoftOvalFields(SOFT_OVAL_FIELD_COUNT);

// RAP-4: a second, larger field of smaller, more circular ovals (Raphael). Same shape/isolation
// pattern as createSoftOvalFields' generated (beyond-the-original-12) entries: a low-discrepancy
// position plus a per-index seed isolated from the shared rnd() stream, so this field never shifts
// any other descriptor array's seeded values and stays stable if its own count changes.
function createCircularOvalFields(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Circular oval field count must be a non-negative integer.');
  }
  return Array.from({ length: count }, (_, index) => {
    const random = mulberry32((0x9e2d1a7b + index * 0x9e3779b9) >>> 0);
    const radius = CIRCULAR_OVAL_SIZE_FACTOR * (0.6 + random() * 0.5);
    // Kept within CIRCULAR_OVAL_ASPECT_TOLERANCE of 1 so every generated oval reads as circular.
    const aspectJitter = (random() - 0.5) * 2 * CIRCULAR_OVAL_ASPECT_TOLERANCE;
    return {
      x: 0.03 + 0.94 * fract((index + 0.5) * 0.6180339887498949 + 0.11),
      y: 0.04 + 0.93 * fract((index + 0.5) * 0.7548776662466927 + 0.29),
      rx: radius * (1 + aspectJitter),
      ry: radius,
      rotation: random() * TAU,
      color: index % 2 === 0 ? AURORA_GREEN : AURORA_BLUE,
      orbitX: 0.006 + random() * 0.006,
      orbitY: 0.006 + random() * 0.006,
      phase: random() * TAU,
      alpha: 0.10 + random() * 0.06,
      blur: 10 + Math.floor(random() * 10),
    };
  });
}

const CIRCULAR_OVAL_FIELDS = createCircularOvalFields(CIRCULAR_OVAL_FIELD_COUNT);
