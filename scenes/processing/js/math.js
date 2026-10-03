// html-wallpaper-demo D2: verbatim port of docs/great-sage/backgroud-processing/js/math.js (that
// tree is reference-only, excluded from git -- see the feature doc, "Source material"). Not
// restyled: only this header comment was added, the source's own header/body follow unchanged.
//
// math.js — generic numeric helpers and the shared seeded PRNG (rnd).
// Loads after config.js. Depends on nothing else.
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;
const fract = (x) => x - Math.floor(x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const pingpong01 = (x) => {
  const cycle = x % 2;
  return cycle <= 1 ? cycle : 2 - cycle;
};

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x4a77cafe);
