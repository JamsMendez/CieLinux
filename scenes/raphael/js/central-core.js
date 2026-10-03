// html-wallpaper-demo D6b: copied verbatim from docs/great-sage/background-raphael/js/central-core.js
// (reference-only, excluded from git -- see the feature doc, "Source material"). Not restyled:
// only this header comment was added, the source's own header/body follow unchanged.

// central-core.js — pure geometry/data for the central core's light redesign (RAP-24). Loads after
// config.js and math.js; touches no DOM/ctx, so every value/function here is directly testable
// through the vm harness. js/layers.js's drawCentralCore consumes these to paint the actual layer.
//
// RAP-24 (user feedback): "La luz del centro: dale más efecto de luz, se ve como un círculo
// amarillo" — the previous look was a large, nearly-opaque flat disc (radius 0.88r, alpha 0.97),
// which reads as a flat yellow circle rather than a light source. The redesign: a very small
// white-gold HOT core, a strong soft multi-layer bloom with a smooth falloff that reaches ~0 alpha
// at every gradient's outer stop (no hard edge anywhere), faint slowly-rotating starburst/glare
// streaks, and a subtle flare that pulses in sync with the hexadecagon's own pulse.

// Each [offset, alpha] stop list below feeds a real ctx.createRadialGradient(...).addColorStop(...)
// call in drawCentralCore — kept here as plain data (not built inline in the ctx code) specifically
// so "no hard edge" is a testable numeric property: every list's alpha must be monotonically
// non-increasing from the center outward and reach ~0 by its last stop.
const CENTRAL_CORE_HOT_STOPS = [
  [0.00, 1.00],
  [0.35, 0.92],
  [0.70, 0.45],
  [1.00, 0.00],
];
const CENTRAL_CORE_BLOOM_INNER_STOPS = [
  [0.00, 0.60],
  [0.22, 0.34],
  [0.55, 0.10],
  [1.00, 0.00],
];
const CENTRAL_CORE_BLOOM_OUTER_STOPS = [
  [0.00, 0.24],
  [0.30, 0.11],
  [0.65, 0.03],
  [1.00, 0.00],
];

// A thin glare streak fades in from nothing, peaks near its middle, and fades back to nothing —
// symmetric, unlike the center-outward bloom stops above, so checked separately.
const CENTRAL_CORE_GLARE_FADE_STOPS = [
  [0.00, 0.00],
  [0.12, 0.55],
  [0.50, 1.00],
  [0.88, 0.45],
  [1.00, 0.00],
];

// The angle (radians) of glare streak `index` of `count`, at animation phase `phase`, rotating
// slowly at `rotationSpeed` (radians of rotation per radian of phase) — deterministic and evenly
// spaced, same pattern as the existing prominent/minor core rays and glyph rings.
function centralCoreGlareStreakAngle(index, count, phase, rotationSpeed) {
  return (index / count) * TAU + phase * rotationSpeed;
}

// A bounded multiplier (>= 1) that boosts the bloom/glare alpha in sync with the hexadecagon's own
// pulse (pulse in [0,1] — see hexadecagonPulse), so the core's flare subtly brightens on each pulse
// instead of running on an unrelated, desynced cycle of its own. Defensively clamps its input, so an
// out-of-[0,1] pulse can never push the envelope below 1 or above its intended bound.
function centralCoreFlareEnvelope(pulse) {
  return 1 + clamp01(pulse) * CENTRAL_CORE_PULSE_FLARE_FACTOR;
}
