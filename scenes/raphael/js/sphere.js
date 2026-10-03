// html-wallpaper-demo D6b: copied verbatim from docs/great-sage/background-raphael/js/sphere.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged.

// sphere.js — foreground inclined-ray generation. Loads after config.js and math.js. Uses only
// per-index local mulberry32 instances, never the shared rnd() stream, so it has no ordering
// dependency on scene-data.js.
// Alternating signed speeds deliberately let rays cross rather than rotate in lockstep.
//
// RAP-2b: the segmented sphere (candidate/descriptor generation, assembly/rotation/projection
// math) that used to live in this file was removed — user: no sphere, bands or orbits in Raphael.
function createForegroundInclinedRays(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Foreground inclined ray count must be a non-negative integer.');
  }
  return Array.from({ length: count }, (_, index) => {
    const random = mulberry32((0x7f4a7c15 + index * 0x9e3779b9) >>> 0);
    const direction = index % 2 === 0 ? 1 : -1;
    return {
      // A golden-angle distribution keeps existing indexed descriptors stable when density changes.
      angularOffset: fract(index * 0.6180339887498949 + (random() - 0.5) * 0.035) * TAU,
      angularSpeed: direction * (0.10 + random() * 0.32 + index * 1e-6),
      inclination: (45 + random() * 15) * Math.PI / 180,
    };
  });
}

const PERSPECTIVE_RAYS = createForegroundInclinedRays(FOREGROUND_INCLINED_RAY_COUNT);
